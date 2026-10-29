-- PDDC IIMS 0019 : conflict-of-interest screening (PRD 8.3).
--
-- "Before a case becomes active the system searches all PDDC records for
--  potential matches on client, subjects, companies, directors, shareholders,
--  beneficial owners and related entities."
--
-- Three rules shape everything here:
--
--   1. It finds POTENTIAL matches and says so. "The system never concludes
--      they are the same." A score and the matching record are shown; nothing
--      is merged, and nothing is decided automatically.
--   2. An authorised manager records the decision, and that decision is
--      immutable and audited.
--   3. A case cannot move to Approved while a conflict check is unresolved.
--
-- The matching itself has to catch the examples the PRD names:
--   "John Mensah" / "John K. Mensah"
--   "ABC Holdings Ltd" / "ABC Holdings Ghana Limited"
-- The first needs tolerance of an inserted middle initial; the second needs
-- company-suffix normalisation plus tolerance of an inserted country word.

-- ---------------------------------------------------------------------------
-- Name normalisation.
--
-- Lower-cased, accent-folded, punctuation stripped, company suffixes and
-- common filler words removed, whitespace collapsed. IMMUTABLE so it can be
-- indexed, which is what makes screening fast enough to run on every keystroke
-- of a name field (PRD 21.6 debounces it to 400ms).
-- ---------------------------------------------------------------------------
create or replace function crm.normalise_name(p_name text)
  returns text
  language sql
  immutable
  parallel safe
  set search_path = ''
as $$
  select
    nullif(
      trim(
        regexp_replace(
          regexp_replace(
            -- Strip suffixes and filler as whole words, repeatedly: "ABC
            -- Holdings Ghana Limited" and "ABC Holdings Ltd" must converge.
            regexp_replace(
              -- Punctuation to spaces, so "John K. Mensah" and "John K Mensah"
              -- agree.
              regexp_replace(
                lower(config.immutable_unaccent(coalesce(p_name, ''))),
                '[^a-z0-9 ]+', ' ', 'g'
              ),
              '\y(ltd|limited|plc|llc|llp|inc|incorporated|corp|corporation|'
              'company|co|gmbh|sa|sarl|bv|nv|pty|pvt|private|holdings|holding|'
              'group|international|global|enterprises|enterprise|ventures|'
              'services|service|trading|and|the|of)\y',
              ' ', 'g'
            ),
            '\s+', ' ', 'g'
          ),
          '^\s+|\s+$', '', 'g'
        )
      ),
      ''
    )
$$;

comment on function crm.normalise_name(text) is
  'Lower-cases, folds accents, strips punctuation and company suffixes, and '
  'collapses whitespace, so variant spellings of the same organisation or '
  'person converge. IMMUTABLE so it can be indexed.';

-- ---------------------------------------------------------------------------
-- A phonetic key, for names that sound alike but are spelled differently.
--
-- dmetaphone on each word, joined in order. Written as a wrapper so the
-- extension schema is pinned and the result can be indexed.
-- ---------------------------------------------------------------------------
create or replace function crm.phonetic_key(p_name text)
  returns text
  language sql
  immutable
  parallel safe
  set search_path = ''
as $$
  select nullif(
    (
      select string_agg(extensions.dmetaphone(word), ' ' order by ordinality)
      from unnest(string_to_array(crm.normalise_name(p_name), ' '))
        with ordinality as t(word, ordinality)
      where word <> ''
    ),
    ''
  )
$$;

grant execute on function crm.normalise_name(text) to iims_app;
grant execute on function crm.phonetic_key(text) to iims_app;

-- Keep the stored normalised name in step with the name itself.
create or replace function crm.set_normalised_name()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  new.organisation_name_normalised := crm.normalise_name(new.organisation_name);
  return new;
end
$$;

drop trigger if exists clients_normalise on crm.clients;
create trigger clients_normalise
  before insert or update of organisation_name on crm.clients
  for each row execute function crm.set_normalised_name();

update crm.clients
set organisation_name_normalised = crm.normalise_name(organisation_name)
where organisation_name_normalised is null;

-- Trigram index on the normalised form, which is what similarity() reads.
create index if not exists clients_normalised_trgm_idx
  on crm.clients using gin (organisation_name_normalised extensions.gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- The check and its matches.
-- ---------------------------------------------------------------------------
create table if not exists crm.conflict_checks (
  id            uuid primary key default gen_random_uuid(),
  check_id      text unique not null default config.next_human_id('CFL'),

  -- A check belongs to an enquiry, an engagement, or both.
  enquiry_id    uuid references crm.enquiries (id),
  engagement_id uuid references crm.engagements (id),
  client_id     uuid references crm.clients (id),

  -- What was searched for, kept verbatim so the check is reproducible.
  searched_terms text[] not null default '{}',

  status        text not null default 'open'
                  check (status in ('open','cleared','further_review','declined')),

  -- The decision. "Cleared / Further Review Required / Conflict Declined",
  -- recorded by an authorised manager with a reason (PRD 8.3).
  decision      text
                  check (decision in ('cleared','further_review','declined')),
  decision_reason text,
  decided_by    uuid references iam.users (id),
  decided_at    timestamptz,

  match_count   int not null default 0,
  highest_score numeric(4,3),

  created_at  timestamptz not null default now(),
  created_by  uuid references iam.users (id),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references iam.users (id),
  version     int not null default 1,

  constraint conflict_check_has_a_subject
    check (enquiry_id is not null or engagement_id is not null or client_id is not null),
  -- A decision is never recorded without a reason or a decider.
  constraint conflict_decision_complete
    check (
      decision is null
      or (decided_by is not null and decided_at is not null
          and decision_reason is not null and length(trim(decision_reason)) > 0)
    )
);

create index if not exists conflict_checks_status_idx
  on crm.conflict_checks (status, created_at desc);
create index if not exists conflict_checks_enquiry_idx on crm.conflict_checks (enquiry_id);
create index if not exists conflict_checks_engagement_idx on crm.conflict_checks (engagement_id);

create table if not exists crm.conflict_matches (
  id             uuid primary key default gen_random_uuid(),
  check_id       uuid not null references crm.conflict_checks (id) on delete cascade,

  searched_term  text not null,
  -- What matched, and where. Deliberately generic: the same screening runs
  -- against clients now and against intel.entities once that exists.
  matched_table  text not null,
  matched_id     uuid not null,
  matched_label  text not null,

  -- Trigram similarity, 0 to 1, plus whether the phonetic keys agreed.
  similarity     numeric(4,3) not null,
  phonetic_match boolean not null default false,
  match_reason   text,

  created_at timestamptz not null default now()
);

create index if not exists conflict_matches_check_idx on crm.conflict_matches (check_id);

-- ---------------------------------------------------------------------------
-- The decision is immutable once recorded (PRD 8.3).
--
-- Enforced by a trigger rather than a service check, because "the decision is
-- immutable and audited" is the whole basis on which a conflict clearance can
-- be relied upon later. A mistaken decision is corrected by raising a new
-- check, exactly as a mistaken audit entry is corrected by a new entry.
-- ---------------------------------------------------------------------------
create or replace function crm.guard_conflict_decision()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  if old.decision is not null and (
       new.decision is distinct from old.decision
       or new.decision_reason is distinct from old.decision_reason
       or new.decided_by is distinct from old.decided_by
       or new.decided_at is distinct from old.decided_at
     ) then
    raise exception
      'a recorded conflict decision cannot be changed. Raise a new conflict check instead (PRD 8.3).'
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end
$$;

drop trigger if exists conflict_decision_immutable on crm.conflict_checks;
create trigger conflict_decision_immutable
  before update on crm.conflict_checks
  for each row execute function crm.guard_conflict_decision();

drop trigger if exists conflict_checks_touch on crm.conflict_checks;
create trigger conflict_checks_touch
  before update on crm.conflict_checks
  for each row execute function iam.touch_row();

-- A match is evidence of what the search found, so it is not editable either.
create or replace function crm.guard_match_immutable()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  raise exception
    'conflict matches record what a search found and cannot be altered. Re-run the check instead.'
    using errcode = 'insufficient_privilege';
end
$$;

drop trigger if exists conflict_matches_immutable on crm.conflict_matches;
create trigger conflict_matches_immutable
  before update on crm.conflict_matches
  for each row execute function crm.guard_match_immutable();

-- ---------------------------------------------------------------------------
-- The search itself.
--
-- Returns potential matches with a score. Never writes, never merges, never
-- decides. The caller records the result as a check plus its matches.
--
-- p_threshold defaults to 0.3, which catches the PRD's examples without
-- drowning the reviewer; it is a parameter so PDDC can tune it.
-- ---------------------------------------------------------------------------
create or replace function crm.find_conflicts(
  p_terms     text[],
  p_threshold numeric default 0.30,
  p_limit     int default 50
)
  returns table (
    searched_term  text,
    matched_table  text,
    matched_id     uuid,
    matched_label  text,
    similarity     numeric,
    phonetic_match boolean,
    match_reason   text
  )
  language plpgsql
  stable
  security definer
  set search_path = ''
as $$
begin
  if not iam.has_permission('conflicts', 'view') then
    raise exception 'not permitted to run a conflict check'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  with terms as (
    select t.term,
           crm.normalise_name(t.term) as normalised,
           crm.phonetic_key(t.term)   as phonetic
    from unnest(p_terms) as t(term)
    where crm.normalise_name(t.term) is not null
  )
  select
    te.term,
    'crm.clients'::text,
    c.id,
    c.organisation_name,
    round(extensions.similarity(c.organisation_name_normalised, te.normalised)::numeric, 3),
    (crm.phonetic_key(c.organisation_name) = te.phonetic),
    case
      when c.organisation_name_normalised = te.normalised
        then 'identical once suffixes and punctuation are normalised'
      when crm.phonetic_key(c.organisation_name) = te.phonetic
        then 'sounds the same'
      when c.organisation_name_normalised like '%' || te.normalised || '%'
        then 'the searched name appears within an existing name'
      when te.normalised like '%' || c.organisation_name_normalised || '%'
        then 'an existing name appears within the searched name'
      else 'similar spelling'
    end
  from terms te
  join crm.clients c
    on c.deleted_at is null
   and c.organisation_name_normalised is not null
   and (
         extensions.similarity(c.organisation_name_normalised, te.normalised) >= p_threshold
         or crm.phonetic_key(c.organisation_name) = te.phonetic
         or c.organisation_name_normalised like '%' || te.normalised || '%'
         or te.normalised like '%' || c.organisation_name_normalised || '%'
       )
  order by 5 desc, 4
  limit least(coalesce(p_limit, 50), 200);
end
$$;

grant execute on function crm.find_conflicts(text[], numeric, int) to iims_app;

-- ------------------------------------------------------------------- RLS
alter table crm.conflict_checks  enable row level security;
alter table crm.conflict_checks  force  row level security;
alter table crm.conflict_matches enable row level security;
alter table crm.conflict_matches force  row level security;
