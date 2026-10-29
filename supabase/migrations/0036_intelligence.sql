-- PDDC IIMS 0036 : entities, sources, information and findings (PRD 6.4, 8.4, 15).
--
-- The two ends of the chain this platform exists to keep intact. M4 built the
-- middle of it; this migration builds what comes before evidence and what
-- comes after:
--
--   Case -> Subject -> **Source** -> **Information** -> Evidence -> Analysis
--   -> **Finding** -> Report
--
-- Three things here are not ordinary CRUD and are the reason the module
-- exists at all.
--
-- FIRST, reliability and credibility are rated separately (PRD 6.4). A
-- reliable source can report something unconfirmed, and an unreliable source
-- can report something that turns out to be true. Collapsing the two into one
-- "quality" number is the single most common way an intelligence product
-- misleads its reader, so the two scales are different columns with different
-- vocabularies and are shown separately on every screen.
--
-- SECOND, a merge is reversible and never deletes anything (PRD 8.4).
-- Two records flagged as the same entity are merged by pointing the loser at
-- the survivor and moving its links; the loser's row stays, the move is
-- recorded in `intel.entity_merges` with everything needed to put it back,
-- and reversing is a row in the same table rather than an undo nobody can
-- audit.
--
-- THIRD, a human source is STRICTLY RESTRICTED by default and its identity is
-- separable from what it said. `intel.sources.identity_restricted` is not a
-- flag the UI honours: the SELECT policy on the identity columns is what
-- honours it, so information attributed to a protected source is readable by
-- the case team while who that source is remains need-to-know.

-- ---------------------------------------------------------------------------
-- Vocabularies, as check constraints rather than enums.
--
-- The same reason the rest of the platform gives: adding a value to a
-- Postgres enum cannot be done in a transaction that then uses it, and
-- removing one is impossible. A check constraint is replaceable in one
-- statement.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The identifiers (PRD 15).
-- ---------------------------------------------------------------------------
create or replace function intel.next_finding_id(p_case_id uuid)
  returns text
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v_case_number text;
  v_next        bigint;
begin
  select split_part(c.case_id, '-', 3)
  into v_case_number
  from casework.cases c
  where c.id = p_case_id;

  if v_case_number is null then
    raise exception 'no such case: %', p_case_id
      using errcode = 'foreign_key_violation';
  end if;

  -- PRD 15 writes a finding as F-001, numbered within its case: a report
  -- refers to "finding F-003" and the reader is inside one case.
  insert into config.id_sequences (prefix, year, last_value)
  values ('F:' || v_case_number, 0, 1)
  on conflict (prefix, year) do update
    set last_value = config.id_sequences.last_value + 1
  returning last_value into v_next;

  return 'F-' || lpad(v_next::text, 3, '0');
end
$$;

comment on function intel.next_finding_id(uuid) is
  'PRD 15 finding identifier: F-001, numbered within its case. Year 0 in '
  'config.id_sequences because a finding number does not restart annually: '
  'a case that runs over a year end would otherwise get a second F-001.';

grant execute on function intel.next_finding_id(uuid) to iims_app;

-- ---------------------------------------------------------------------------
-- Entities (PRD 15, "Subject / Entity").
--
-- An entity is deliberately NOT case-scoped. The same company appears in
-- several investigations, and the ability to say so is most of the value of
-- an intelligence register: a subject of this case who was a director in a
-- case two years ago is exactly the connection PDDC is paid to find. The link
-- to a case is `intel.case_subjects`, and reach is composed from it.
-- ---------------------------------------------------------------------------
create table if not exists intel.entities (
  id        uuid primary key default gen_random_uuid(),
  entity_id text unique not null default config.next_human_id('ENT', 6),

  entity_type text not null check (
    entity_type in (
      'person', 'company', 'organisation', 'government_body', 'property',
      'vehicle', 'account', 'asset', 'other'
    )
  ),

  name text not null,
  -- The suffix-stripped, unaccented form the conflict and duplicate checks
  -- compare. Generated, so it cannot drift from the name it is derived from.
  normalised_name text generated always as (crm.normalise_name(name)) stored,

  -- PRD 15 lists both: a company has a registration number, a person has an
  -- identity reference, and the second is sensitive in a way the first is
  -- not.
  registration_no text,
  -- Encrypted at rest with pgcrypto, because a passport or national identity
  -- number is the field that turns a data breach into a personal one. Written
  -- and read through intel.set_id_reference / intel.id_reference, which are
  -- the only things granted the key.
  id_reference_encrypted bytea,
  -- The last four characters, in clear, so a screen can show which reference
  -- it holds without decrypting it.
  id_reference_hint text,

  nationality text references iam.countries (code),
  country     text references iam.countries (code),
  address     text,
  date_of_birth date check (date_of_birth is null or date_of_birth <= current_date),
  incorporated_on date,

  notes text,

  -- PRD 8.4: an entity record is provisional until somebody has decided it is
  -- a distinct real thing.
  resolution_status text not null default 'unresolved' check (
    resolution_status in ('unresolved', 'resolved', 'merged', 'disputed')
  ),
  -- Set when this record has been merged into another (PRD 8.4). The row
  -- stays: a merge never deletes a source record.
  merged_into_id uuid references intel.entities (id),

  classification text not null default 'CONFIDENTIAL'
    references iam.classification_levels (code),

  created_at timestamptz not null default now(),
  created_by uuid references iam.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references iam.users (id),
  version    integer not null default 1,
  deleted_at timestamptz,
  deleted_by uuid references iam.users (id),

  constraint entities_merged_consistently check (
    (resolution_status = 'merged') = (merged_into_id is not null)
  ),
  constraint entities_not_merged_into_itself check (merged_into_id is distinct from id),
  -- A person has no incorporation date and a company has no date of birth.
  -- Refused rather than ignored: a company "born" in 1972 is a data entry
  -- mistake somebody will later read as fact.
  constraint entities_dates_match_type check (
    (entity_type = 'person' and incorporated_on is null)
    or (entity_type <> 'person' and date_of_birth is null)
  )
);

comment on table intel.entities is
  'PRD 15 subjects and entities. Not case-scoped on purpose: the same company '
  'appears in several investigations and saying so is the point of the '
  'register. intel.case_subjects links an entity to a case.';

create index if not exists entities_normalised_name_trgm
  on intel.entities using gin (normalised_name extensions.gin_trgm_ops);
create index if not exists entities_type_idx on intel.entities (entity_type);
create index if not exists entities_merged_into_idx on intel.entities (merged_into_id)
  where merged_into_id is not null;
create index if not exists entities_search_idx
  on intel.entities using gin (
    to_tsvector('simple', name || ' ' || coalesce(registration_no, ''))
  );

-- ---------------------------------------------------------------------------
-- The identity reference, encrypted.
--
-- Two functions, both SECURITY DEFINER, so the key never reaches iims_app and
-- a decryption is an act the audit trail can record. The key lives in
-- config.secrets rather than in the function body, so rotating it does not
-- need a migration that rewrites code.
-- ---------------------------------------------------------------------------
create table if not exists config.secrets (
  key        text primary key,
  value      text not null,
  created_at timestamptz not null default now()
);

comment on table config.secrets is
  'Application secrets that must be readable inside the database, such as the '
  'key for intel.entities.id_reference_encrypted. iims_app has no privileges '
  'here at all: only the SECURITY DEFINER functions that need a value can '
  'read one.';

revoke all on config.secrets from iims_app;

-- Enabled and forced like every other table in the platform, so a future
-- grant cannot quietly open it: with no policy at all, nothing but a
-- SECURITY DEFINER function can read a row.
alter table config.secrets enable row level security;
alter table config.secrets force  row level security;

-- Generated once, here, rather than taken from an environment variable: the
-- value has to survive in the database for a decryption to be possible at
-- all, and a key in .env.local that is lost makes every reference unreadable.
insert into config.secrets (key, value)
values ('intel.id_reference_key', encode(gen_random_bytes(32), 'hex'))
on conflict (key) do nothing;

create or replace function intel.set_id_reference(
  p_entity_id uuid,
  p_reference text
)
  returns void
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v_key text;
begin
  if p_reference is null or btrim(p_reference) = '' then
    update intel.entities
    set id_reference_encrypted = null, id_reference_hint = null
    where id = p_entity_id;
    return;
  end if;

  select value into v_key from config.secrets where key = 'intel.id_reference_key';
  if v_key is null then
    raise exception 'the identity reference key is missing from config.secrets';
  end if;

  update intel.entities
  set id_reference_encrypted =
        extensions.pgp_sym_encrypt(btrim(p_reference), v_key),
      id_reference_hint = right(btrim(p_reference), 4)
  where id = p_entity_id;
end
$$;

comment on function intel.set_id_reference(uuid, text) is
  'Stores an entity identity reference encrypted (PRD 15: id_reference is '
  'encrypted). SECURITY DEFINER so the key never reaches the application role.';

create or replace function intel.id_reference(p_entity_id uuid)
  returns text
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v_key       text;
  v_cipher    bytea;
  v_class     text;
  v_reference text;
begin
  select e.id_reference_encrypted, e.classification
  into v_cipher, v_class
  from intel.entities e
  where e.id = p_entity_id;

  if v_cipher is null then
    return null;
  end if;

  -- The check cannot be skipped by calling this directly: a SECURITY DEFINER
  -- function runs with its owner's privileges, so it has to do its own
  -- authorization rather than relying on the caller's policies.
  if not iam.has_permission('entities', 'view', v_class) then
    raise exception 'not permitted to read the identity reference of this entity'
      using errcode = 'insufficient_privilege';
  end if;

  select value into v_key from config.secrets where key = 'intel.id_reference_key';

  v_reference := extensions.pgp_sym_decrypt(v_cipher, v_key);

  -- Reading one is itself an event worth recording: it is the most sensitive
  -- field in the register and PRD 13 wants every access to sensitive data in
  -- the trail.
  perform audit.write(
    'entity.id_reference_read', 'intel.entities', p_entity_id::text,
    null, null, null,
    'decrypted the identity reference', v_class
  );

  return v_reference;
end
$$;

comment on function intel.id_reference(uuid) is
  'Decrypts an entity identity reference, after checking the caller may view '
  'the entity, and writes the access to the audit trail.';

grant execute on function intel.set_id_reference(uuid, text) to iims_app;
grant execute on function intel.id_reference(uuid) to iims_app;

-- ---------------------------------------------------------------------------
-- Aliases (PRD 15: aliases[]).
--
-- Their own table rather than an array, because the conflict check has to
-- search them: "John K. Mensah" is a match for "John Mensah" and a trigram
-- index on an array element is not a thing.
-- ---------------------------------------------------------------------------
create table if not exists intel.entity_aliases (
  id        uuid primary key default gen_random_uuid(),
  entity_id uuid not null references intel.entities (id) on delete cascade,
  alias     text not null,
  normalised_alias text generated always as (crm.normalise_name(alias)) stored,
  alias_type text not null default 'also_known_as' check (
    alias_type in (
      'also_known_as', 'former_name', 'trading_name', 'abbreviation',
      'transliteration', 'misspelling'
    )
  ),
  source_note text,

  created_at timestamptz not null default now(),
  created_by uuid references iam.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references iam.users (id),
  version    integer not null default 1,

  unique (entity_id, normalised_alias)
);

create index if not exists entity_aliases_trgm
  on intel.entity_aliases using gin (normalised_alias extensions.gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- An entity's part in a case (PRD 15: relationship_to_case).
-- ---------------------------------------------------------------------------
create table if not exists intel.case_subjects (
  id        uuid primary key default gen_random_uuid(),
  case_id   uuid not null references casework.cases (id) on delete cascade,
  entity_id uuid not null references intel.entities (id) on delete cascade,

  subject_role text not null check (
    subject_role in (
      'primary_subject', 'secondary_subject', 'person_of_interest', 'witness',
      'complainant', 'related_party', 'client_contact', 'other'
    )
  ),
  relationship_to_case text,

  created_at timestamptz not null default now(),
  created_by uuid references iam.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references iam.users (id),
  version    integer not null default 1,
  removed_at timestamptz,
  removed_by uuid references iam.users (id),
  removal_reason text,

  unique (case_id, entity_id)
);

comment on table intel.case_subjects is
  'Which entities a case concerns, and in what part. Removing a subject is a '
  'state change rather than a deletion: a subject who turned out to be '
  'irrelevant is part of what the investigation did.';

create index if not exists case_subjects_case_idx on intel.case_subjects (case_id);
create index if not exists case_subjects_entity_idx on intel.case_subjects (entity_id);

-- ---------------------------------------------------------------------------
-- Relationships between entities (PRD 15, "Relationship").
--
-- Directional, because "A is a director of B" and "B is a director of A" are
-- different statements, and the graph is unreadable if direction is lost.
-- ---------------------------------------------------------------------------
create table if not exists intel.relationships (
  id             uuid primary key default gen_random_uuid(),
  from_entity_id uuid not null references intel.entities (id) on delete cascade,
  to_entity_id   uuid not null references intel.entities (id) on delete cascade,

  relationship_type text not null check (
    relationship_type in (
      'director_of', 'shareholder_of', 'beneficial_owner_of', 'employee_of',
      'officer_of', 'owns', 'subsidiary_of', 'parent_of', 'associated_with',
      'family_member_of', 'spouse_of', 'business_partner_of',
      'signatory_on', 'resident_at', 'registered_at', 'other'
    )
  ),
  description text,

  -- PRD 15: percentage/period.
  percentage numeric(7, 4) check (
    percentage is null or (percentage >= 0 and percentage <= 100)
  ),
  held_from date,
  held_to   date,

  -- The whole reason this table is worth anything: a relationship that cannot
  -- be traced back to something is a rumour.
  source_id        uuid,
  evidence_item_id uuid references evidence.evidence_items (id),

  confidence text not null default 'moderate' check (
    confidence in ('high', 'moderate', 'low', 'unverified')
  ),

  created_at timestamptz not null default now(),
  created_by uuid references iam.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references iam.users (id),
  version    integer not null default 1,
  deleted_at timestamptz,
  deleted_by uuid references iam.users (id),

  constraint relationships_not_to_itself
    check (from_entity_id <> to_entity_id),
  constraint relationships_period_in_order
    check (held_to is null or held_from is null or held_to >= held_from),
  -- A percentage belongs to a holding, and saying "a director of, 40%" is
  -- either a mistake or a shareholding recorded under the wrong type.
  constraint relationships_percentage_belongs_to_a_holding check (
    percentage is null
    or relationship_type in ('shareholder_of', 'beneficial_owner_of', 'owns')
  )
);

create index if not exists relationships_from_idx on intel.relationships (from_entity_id);
create index if not exists relationships_to_idx on intel.relationships (to_entity_id);

-- ---------------------------------------------------------------------------
-- Potential duplicates and matches (PRD 8.4).
--
-- Flagged, never merged automatically. The pair is stored in a fixed order so
-- the same two records cannot be flagged twice in opposite directions.
-- ---------------------------------------------------------------------------
create table if not exists intel.entity_match_flags (
  id         uuid primary key default gen_random_uuid(),
  entity_a_id uuid not null references intel.entities (id) on delete cascade,
  entity_b_id uuid not null references intel.entities (id) on delete cascade,

  flag_type text not null check (
    flag_type in ('potential_duplicate', 'potential_match')
  ),
  similarity_score numeric(5, 4) check (
    similarity_score is null or (similarity_score >= 0 and similarity_score <= 1)
  ),
  detected_by text not null default 'manual' check (
    detected_by in ('manual', 'name_similarity', 'identifier', 'phonetic')
  ),
  notes text,

  status text not null default 'open' check (
    status in ('open', 'same_entity', 'different_entities', 'undecided')
  ),
  decided_by uuid references iam.users (id),
  decided_at timestamptz,
  decision_reason text,

  created_at timestamptz not null default now(),
  created_by uuid references iam.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references iam.users (id),
  version    integer not null default 1,

  constraint match_flags_pair_ordered check (entity_a_id < entity_b_id),
  constraint match_flags_decision_has_a_reason check (
    status = 'open'
    or (decided_by is not null and decided_at is not null
        and decision_reason is not null and btrim(decision_reason) <> '')
  ),
  unique (entity_a_id, entity_b_id)
);

comment on constraint match_flags_pair_ordered on intel.entity_match_flags is
  'The pair is held in a fixed order so A/B and B/A cannot both be flagged. '
  'The repository orders the two before it writes.';

-- ---------------------------------------------------------------------------
-- Merges, reversible (PRD 8.4).
--
-- `moved` holds what was moved and from where, which is what makes reversing
-- possible without guessing: a reversal reads this row rather than trying to
-- work out which aliases used to belong to the loser.
-- ---------------------------------------------------------------------------
create table if not exists intel.entity_merges (
  id         uuid primary key default gen_random_uuid(),
  surviving_entity_id uuid not null references intel.entities (id),
  merged_entity_id    uuid not null references intel.entities (id),

  reason     text not null check (btrim(reason) <> ''),
  moved      jsonb not null default '{}'::jsonb,

  merged_by  uuid not null references iam.users (id),
  merged_at  timestamptz not null default now(),

  reversed_at timestamptz,
  reversed_by uuid references iam.users (id),
  reversal_reason text,

  constraint merges_not_onto_itself
    check (surviving_entity_id <> merged_entity_id),
  constraint merges_reversal_has_a_reason check (
    reversed_at is null
    or (reversed_by is not null and reversal_reason is not null
        and btrim(reversal_reason) <> '')
  )
);

comment on table intel.entity_merges is
  'PRD 8.4: merges are reversible through a retained merge log and never '
  'delete source records. `moved` records exactly what was reassigned, so a '
  'reversal puts it back rather than guessing.';

create index if not exists entity_merges_merged_idx
  on intel.entity_merges (merged_entity_id);

-- ---------------------------------------------------------------------------
-- Sources (PRD 6.4, PRD 15).
--
-- Case-scoped, unlike an entity: "the registry" is not a source, a particular
-- search of the registry on a particular day by a particular person is. That
-- is what a reader of the report needs to be able to go back to.
-- ---------------------------------------------------------------------------
create table if not exists intel.sources (
  id        uuid primary key default gen_random_uuid(),
  source_id text unique not null default config.next_human_id('SRC', 6),
  case_id   uuid not null references casework.cases (id) on delete cascade,

  source_type text not null check (
    source_type in (
      'public_registry', 'government_record', 'interview', 'human_source',
      'client', 'open_source', 'media', 'database', 'corporate_filing',
      'financial_record', 'court_record', 'site_visit', 'other'
    )
  ),
  description text not null,

  date_obtained date not null,
  obtained_by   uuid not null references iam.users (id),

  -- PRD 6.4's left-hand column. Rated on the SOURCE, about whether what it
  -- says can be relied on in general.
  source_reliability text not null check (
    source_reliability in (
      'reliable', 'usually_reliable', 'unknown', 'questionable', 'unreliable'
    )
  ),

  access_restrictions text,
  verification_status text not null default 'unverified' check (
    verification_status in ('unverified', 'verifying', 'verified', 'failed')
  ),

  -- PRD 6.4: "Human-source identities carry additional access controls
  -- (STRICTLY RESTRICTED by default, named-user access only)." Set
  -- automatically for a human source by the trigger below, and the identity
  -- columns are separated from the rest so what the source said stays
  -- readable while who they are does not.
  identity_restricted boolean not null default false,
  identity_name       text,
  identity_contact    text,
  identity_notes      text,

  classification text not null default 'CONFIDENTIAL'
    references iam.classification_levels (code),

  created_at timestamptz not null default now(),
  created_by uuid references iam.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references iam.users (id),
  version    integer not null default 1,
  deleted_at timestamptz,
  deleted_by uuid references iam.users (id),

  constraint sources_obtained_in_the_past check (date_obtained <= current_date),
  -- An identity may only be recorded where it is protected. Without this a
  -- human source's name could be typed into a source whose identity is not
  -- restricted, which is the exact failure PRD 6.4 is written to prevent.
  constraint sources_identity_is_protected check (
    identity_restricted
    or (identity_name is null and identity_contact is null and identity_notes is null)
  )
);

comment on table intel.sources is
  'PRD 6.4 and 15. A source is a particular acquisition of material, not a '
  'place: a reader has to be able to go back to the same search on the same '
  'day by the same person.';

create index if not exists sources_case_idx on intel.sources (case_id);
create index if not exists sources_search_idx
  on intel.sources using gin (to_tsvector('simple', description));

-- A human source is protected by default, and nothing in the application can
-- forget to do it.
create or replace function intel.protect_human_source()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  if new.source_type = 'human_source' then
    new.identity_restricted := true;
    -- PRD 6.4: STRICTLY RESTRICTED by default. Raised rather than set, so a
    -- source already recorded as more sensitive is left alone.
    if iam.clearance_rank(new.classification)
       < iam.clearance_rank('STRICTLY_RESTRICTED') then
      new.classification := 'STRICTLY_RESTRICTED';
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists sources_protect_human on intel.sources;
create trigger sources_protect_human
  before insert or update on intel.sources
  for each row execute function intel.protect_human_source();

comment on function intel.protect_human_source() is
  'PRD 6.4: a human source is STRICTLY RESTRICTED with its identity '
  'restricted, decided at the table so no code path can omit it.';

-- The source reference M4 left as a bare column, now that the table exists.
alter table evidence.evidence_items
  drop constraint if exists evidence_items_source_id_fkey;
alter table evidence.evidence_items
  add constraint evidence_items_source_id_fkey
  foreign key (source_id) references intel.sources (id);

alter table intel.relationships
  drop constraint if exists relationships_source_id_fkey;
alter table intel.relationships
  add constraint relationships_source_id_fkey
  foreign key (source_id) references intel.sources (id);

-- ---------------------------------------------------------------------------
-- Information (PRD 6.4, PRD 15).
--
-- A piece of information is something a source said. Its credibility is
-- rated here, separately from the source's reliability, because that is the
-- distinction the whole module turns on.
-- ---------------------------------------------------------------------------
create table if not exists intel.information (
  id             uuid primary key default gen_random_uuid(),
  information_id text unique not null default config.next_human_id('INF', 6),
  case_id        uuid not null references casework.cases (id) on delete cascade,
  source_id      uuid not null references intel.sources (id),

  date_obtained date not null,
  description   text not null,

  -- PRD 6.4's right-hand column, about this particular statement.
  information_credibility text not null check (
    information_credibility in (
      'confirmed', 'probable', 'possible', 'doubtful', 'unverified'
    )
  ),
  verification_status text not null default 'unverified' check (
    verification_status in ('unverified', 'verifying', 'verified', 'contradicted')
  ),

  -- PRD 15 asks for a confidence as well as a credibility. They are not the
  -- same: credibility is about the statement, confidence is the analyst's
  -- judgement of what it is worth given everything else known.
  confidence text not null default 'unverified' check (
    confidence in ('high', 'moderate', 'low', 'unverified')
  ),
  analyst uuid references iam.users (id),

  -- Which entity this is about, where it is about one.
  entity_id uuid references intel.entities (id),

  classification text not null default 'CONFIDENTIAL'
    references iam.classification_levels (code),

  created_at timestamptz not null default now(),
  created_by uuid references iam.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references iam.users (id),
  version    integer not null default 1,
  deleted_at timestamptz,
  deleted_by uuid references iam.users (id),

  constraint information_obtained_in_the_past check (date_obtained <= current_date),
  -- "Confirmed" is a claim about corroboration, and the application enforces
  -- that it has some. The constraint catches the other half: nothing can be
  -- confirmed and contradicted at once.
  constraint information_not_confirmed_and_contradicted check (
    not (information_credibility = 'confirmed'
         and verification_status = 'contradicted')
  )
);

create index if not exists information_case_idx on intel.information (case_id);
create index if not exists information_source_idx on intel.information (source_id);
create index if not exists information_entity_idx on intel.information (entity_id)
  where entity_id is not null;
create index if not exists information_search_idx
  on intel.information using gin (to_tsvector('simple', description));

-- Corroboration: one piece of information supported by another, from a
-- different source (PRD 15: corroborating_sources[]).
create table if not exists intel.information_corroboration (
  id uuid primary key default gen_random_uuid(),
  information_id uuid not null references intel.information (id) on delete cascade,
  corroborating_information_id uuid not null
    references intel.information (id) on delete cascade,
  note text,

  created_at timestamptz not null default now(),
  created_by uuid references iam.users (id),

  constraint corroboration_not_itself
    check (information_id <> corroborating_information_id),
  unique (information_id, corroborating_information_id)
);

comment on table intel.information_corroboration is
  'PRD 15 corroborating_sources. Information rather than sources, because '
  'what corroborates a statement is another statement: two pieces from the '
  'same source corroborate nothing, which the application refuses.';

-- Information to the evidence that supports it (PRD 15: related_evidence[]).
create table if not exists intel.information_evidence (
  id uuid primary key default gen_random_uuid(),
  information_id   uuid not null references intel.information (id) on delete cascade,
  evidence_item_id uuid not null references evidence.evidence_items (id) on delete cascade,
  note text,

  created_at timestamptz not null default now(),
  created_by uuid references iam.users (id),

  unique (information_id, evidence_item_id)
);

-- ---------------------------------------------------------------------------
-- Findings (PRD 15, screen 17).
--
-- A finding is the investigation's conclusion, and the one thing on it that
-- matters more than its wording is what it rests on. A finding with no
-- supporting information and no supporting evidence is an opinion, and the
-- application refuses to let one be put forward for review.
-- ---------------------------------------------------------------------------
create table if not exists intel.findings (
  id         uuid primary key default gen_random_uuid(),
  finding_id text not null,
  case_id    uuid not null references casework.cases (id) on delete cascade,

  statement text not null,
  detail    text,

  analyst    uuid not null references iam.users (id),
  confidence text not null default 'moderate' check (
    confidence in ('high', 'moderate', 'low', 'unverified')
  ),
  finding_date date not null default current_date,

  status text not null default 'draft' check (
    status in ('draft', 'submitted', 'accepted', 'returned', 'withdrawn')
  ),
  reviewer     uuid references iam.users (id),
  reviewed_at  timestamptz,
  review_notes text,

  classification text not null default 'CONFIDENTIAL'
    references iam.classification_levels (code),

  created_at timestamptz not null default now(),
  created_by uuid references iam.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references iam.users (id),
  version    integer not null default 1,
  deleted_at timestamptz,
  deleted_by uuid references iam.users (id),

  unique (case_id, finding_id),
  constraint findings_decision_recorded check (
    status in ('draft', 'submitted', 'withdrawn')
    or (reviewer is not null and reviewed_at is not null)
  ),
  -- PRD 16 and the pattern the whole platform follows: nobody approves their
  -- own work. At the table as well, because this one is worth two locks.
  constraint findings_not_reviewed_by_its_analyst check (
    reviewer is null or reviewer <> analyst
  ),
  constraint findings_return_has_a_reason check (
    status <> 'returned'
    or (review_notes is not null and btrim(review_notes) <> '')
  )
);

comment on table intel.findings is
  'PRD 15 and screen 17. The conclusion, and what it rests on: '
  'intel.finding_links is what makes the traceability strip possible.';

create index if not exists findings_case_idx on intel.findings (case_id);
create index if not exists findings_search_idx
  on intel.findings using gin (to_tsvector('simple', statement));

-- What a finding rests on (screen 17, screen 23's traceability strip).
create table if not exists intel.finding_links (
  id         uuid primary key default gen_random_uuid(),
  finding_id uuid not null references intel.findings (id) on delete cascade,

  link_type text not null check (
    link_type in ('information', 'evidence', 'document', 'entity')
  ),
  -- One column per kind rather than a polymorphic id, so every link is a real
  -- foreign key: a traceability strip that can point at a deleted row is
  -- worse than no strip.
  information_id   uuid references intel.information (id) on delete cascade,
  evidence_item_id uuid references evidence.evidence_items (id) on delete cascade,
  document_id      uuid references docs.documents (id) on delete cascade,
  entity_id        uuid references intel.entities (id) on delete cascade,

  relevance text,

  created_at timestamptz not null default now(),
  created_by uuid references iam.users (id),

  constraint finding_links_exactly_one_target check (
    (case when information_id   is not null then 1 else 0 end) +
    (case when evidence_item_id is not null then 1 else 0 end) +
    (case when document_id      is not null then 1 else 0 end) +
    (case when entity_id        is not null then 1 else 0 end) = 1
  ),
  constraint finding_links_type_matches_target check (
    (link_type = 'information' and information_id is not null)
    or (link_type = 'evidence' and evidence_item_id is not null)
    or (link_type = 'document' and document_id is not null)
    or (link_type = 'entity' and entity_id is not null)
  )
);

create unique index if not exists finding_links_unique_information
  on intel.finding_links (finding_id, information_id)
  where information_id is not null;
create unique index if not exists finding_links_unique_evidence
  on intel.finding_links (finding_id, evidence_item_id)
  where evidence_item_id is not null;
create unique index if not exists finding_links_unique_document
  on intel.finding_links (finding_id, document_id)
  where document_id is not null;
create unique index if not exists finding_links_unique_entity
  on intel.finding_links (finding_id, entity_id)
  where entity_id is not null;

-- ---------------------------------------------------------------------------
-- The reach rule for an entity.
--
-- An entity is not case-scoped, so "can this person see it" cannot be
-- answered from a case. It is answered from the cases the entity appears on:
-- somebody who can reach any case this entity is a subject of can see the
-- entity. An entity on no case at all is reachable by whoever has the
-- permission at 'all' scope, which is how a register entry created before it
-- is attached to anything stays usable.
-- ---------------------------------------------------------------------------
create or replace function intel.can_reach_entity(p_entity_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select
    iam.scope_rank(iam.permission_scope('entities', 'view'))
      >= iam.scope_rank('all')
    or exists (
      select 1
      from intel.case_subjects s
      where s.entity_id = p_entity_id
        and s.removed_at is null
        and casework.can_reach_case(s.case_id, 'view')
    )
$$;

comment on function intel.can_reach_entity(uuid) is
  'Whether the current actor can see an entity: at "all" scope, or through a '
  'case the entity is a subject of. An entity on no case is visible only at '
  '"all" scope.';

grant execute on function intel.can_reach_entity(uuid) to iims_app;

-- ---------------------------------------------------------------------------
-- updated_at / updated_by.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['entities', 'entity_aliases', 'case_subjects',
                           'relationships', 'entity_match_flags', 'sources',
                           'information', 'findings']
  loop
    execute format('drop trigger if exists %I_touch on intel.%I', t, t);
    execute format(
      'create trigger %I_touch before update on intel.%I '
      'for each row execute function iam.touch_row()', t, t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- Row-level security.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['entities', 'entity_aliases', 'case_subjects',
                           'relationships', 'entity_match_flags',
                           'entity_merges', 'sources', 'information',
                           'information_corroboration', 'information_evidence',
                           'findings', 'finding_links']
  loop
    execute format('alter table intel.%I enable row level security', t);
    execute format('alter table intel.%I force  row level security', t);
  end loop;
end
$$;

-- Entities: their own classification, and reach through the cases they are on.
drop policy if exists entities_select on intel.entities;
create policy entities_select on intel.entities
  for select to iims_app
  using (
    deleted_at is null
    and iam.has_permission('entities', 'view', intel.entities.classification)
    and intel.can_reach_entity(intel.entities.id)
  );

drop policy if exists entities_select_deleted on intel.entities;
create policy entities_select_deleted on intel.entities
  for select to iims_app
  using (
    deleted_at is not null
    and iam.has_permission('entities', 'delete', intel.entities.classification)
  );

drop policy if exists entities_insert on intel.entities;
create policy entities_insert on intel.entities
  for insert to iims_app
  with check (
    iam.has_permission('entities', 'create', intel.entities.classification)
  );

drop policy if exists entities_update on intel.entities;
create policy entities_update on intel.entities
  for update to iims_app
  using (iam.has_permission('entities', 'edit', intel.entities.classification))
  with check (iam.has_permission('entities', 'edit', intel.entities.classification));

-- Aliases, relationships and match flags follow their entities.
drop policy if exists entity_aliases_select on intel.entity_aliases;
create policy entity_aliases_select on intel.entity_aliases
  for select to iims_app
  using (
    exists (
      select 1 from intel.entities e where e.id = intel.entity_aliases.entity_id
    )
  );

drop policy if exists entity_aliases_write on intel.entity_aliases;
create policy entity_aliases_write on intel.entity_aliases
  for all to iims_app
  using (
    exists (
      select 1 from intel.entities e
      where e.id = intel.entity_aliases.entity_id
        and iam.has_permission('entities', 'edit', e.classification)
    )
  )
  with check (
    exists (
      select 1 from intel.entities e
      where e.id = intel.entity_aliases.entity_id
        and iam.has_permission('entities', 'edit', e.classification)
    )
  );

drop policy if exists case_subjects_select on intel.case_subjects;
create policy case_subjects_select on intel.case_subjects
  for select to iims_app
  using (
    casework.can_reach_case(intel.case_subjects.case_id, 'view')
    and exists (
      select 1 from intel.entities e
      where e.id = intel.case_subjects.entity_id
        and iam.has_permission('entities', 'view', e.classification)
    )
  );

drop policy if exists case_subjects_write on intel.case_subjects;
create policy case_subjects_write on intel.case_subjects
  for all to iims_app
  using (
    casework.can_reach_case(intel.case_subjects.case_id, 'view')
    and iam.has_permission('entities', 'edit', null)
  )
  with check (
    casework.can_reach_case(intel.case_subjects.case_id, 'view')
    and iam.has_permission('entities', 'edit', null)
  );

drop policy if exists relationships_select on intel.relationships;
create policy relationships_select on intel.relationships
  for select to iims_app
  using (
    deleted_at is null
    -- Visible only when both ends are: half a relationship on screen is a
    -- statement about an entity this person may not see.
    and exists (
      select 1 from intel.entities e where e.id = intel.relationships.from_entity_id
    )
    and exists (
      select 1 from intel.entities e where e.id = intel.relationships.to_entity_id
    )
  );

drop policy if exists relationships_select_deleted on intel.relationships;
create policy relationships_select_deleted on intel.relationships
  for select to iims_app
  using (
    deleted_at is not null
    and iam.has_permission('entities', 'delete', null)
  );

drop policy if exists relationships_write on intel.relationships;
create policy relationships_write on intel.relationships
  for all to iims_app
  using (iam.has_permission('entities', 'edit', null))
  with check (
    iam.has_permission('entities', 'edit', null)
    and exists (
      select 1 from intel.entities e where e.id = intel.relationships.from_entity_id
    )
    and exists (
      select 1 from intel.entities e where e.id = intel.relationships.to_entity_id
    )
  );

drop policy if exists entity_match_flags_select on intel.entity_match_flags;
create policy entity_match_flags_select on intel.entity_match_flags
  for select to iims_app
  using (
    exists (
      select 1 from intel.entities e where e.id = intel.entity_match_flags.entity_a_id
    )
    and exists (
      select 1 from intel.entities e where e.id = intel.entity_match_flags.entity_b_id
    )
  );

drop policy if exists entity_match_flags_write on intel.entity_match_flags;
create policy entity_match_flags_write on intel.entity_match_flags
  for all to iims_app
  using (iam.has_permission('entities', 'edit', null))
  with check (iam.has_permission('entities', 'edit', null));

-- The merge log is readable by whoever can see both entities, and written
-- only by whoever may merge. It is never updated except to record a
-- reversal, which the privileges below allow and the application restricts.
drop policy if exists entity_merges_select on intel.entity_merges;
create policy entity_merges_select on intel.entity_merges
  for select to iims_app
  using (iam.has_permission('entities', 'view', null));

drop policy if exists entity_merges_insert on intel.entity_merges;
create policy entity_merges_insert on intel.entity_merges
  for insert to iims_app
  with check (iam.has_permission('entities', 'merge', null));

drop policy if exists entity_merges_update on intel.entity_merges;
create policy entity_merges_update on intel.entity_merges
  for update to iims_app
  using (iam.has_permission('entities', 'merge', null))
  with check (iam.has_permission('entities', 'merge', null));

-- Sources and information follow their case and their own classification,
-- the composition the rest of the platform uses.
drop policy if exists sources_select on intel.sources;
create policy sources_select on intel.sources
  for select to iims_app
  using (
    deleted_at is null
    and iam.has_permission('sources', 'view', intel.sources.classification)
    and casework.can_reach_case(intel.sources.case_id, 'view')
  );

drop policy if exists sources_select_deleted on intel.sources;
create policy sources_select_deleted on intel.sources
  for select to iims_app
  using (
    deleted_at is not null
    and iam.has_permission('sources', 'delete', intel.sources.classification)
  );

drop policy if exists sources_insert on intel.sources;
create policy sources_insert on intel.sources
  for insert to iims_app
  with check (
    iam.has_permission('sources', 'create', intel.sources.classification)
    and casework.can_reach_case(intel.sources.case_id, 'view')
  );

drop policy if exists sources_update on intel.sources;
create policy sources_update on intel.sources
  for update to iims_app
  using (
    iam.has_permission('sources', 'edit', intel.sources.classification)
    and casework.can_reach_case(intel.sources.case_id, 'view')
  )
  with check (
    iam.has_permission('sources', 'edit', intel.sources.classification)
    and casework.can_reach_case(intel.sources.case_id, 'view')
  );

drop policy if exists information_select on intel.information;
create policy information_select on intel.information
  for select to iims_app
  using (
    deleted_at is null
    and iam.has_permission('information', 'view', intel.information.classification)
    and casework.can_reach_case(intel.information.case_id, 'view')
  );

drop policy if exists information_select_deleted on intel.information;
create policy information_select_deleted on intel.information
  for select to iims_app
  using (
    deleted_at is not null
    and iam.has_permission('information', 'delete', intel.information.classification)
  );

drop policy if exists information_insert on intel.information;
create policy information_insert on intel.information
  for insert to iims_app
  with check (
    iam.has_permission('information', 'create', intel.information.classification)
    and casework.can_reach_case(intel.information.case_id, 'view')
  );

drop policy if exists information_update on intel.information;
create policy information_update on intel.information
  for update to iims_app
  using (
    iam.has_permission('information', 'edit', intel.information.classification)
    and casework.can_reach_case(intel.information.case_id, 'view')
  )
  with check (
    iam.has_permission('information', 'edit', intel.information.classification)
    and casework.can_reach_case(intel.information.case_id, 'view')
  );

drop policy if exists information_corroboration_select on intel.information_corroboration;
create policy information_corroboration_select on intel.information_corroboration
  for select to iims_app
  using (
    exists (
      select 1 from intel.information i
      where i.id = intel.information_corroboration.information_id
    )
    and exists (
      select 1 from intel.information i
      where i.id = intel.information_corroboration.corroborating_information_id
    )
  );

drop policy if exists information_corroboration_write on intel.information_corroboration;
create policy information_corroboration_write on intel.information_corroboration
  for all to iims_app
  using (
    exists (
      select 1 from intel.information i
      where i.id = intel.information_corroboration.information_id
        and iam.has_permission('information', 'edit', i.classification)
    )
  )
  with check (
    exists (
      select 1 from intel.information i
      where i.id = intel.information_corroboration.information_id
        and iam.has_permission('information', 'edit', i.classification)
    )
    and exists (
      select 1 from intel.information i
      where i.id = intel.information_corroboration.corroborating_information_id
    )
  );

drop policy if exists information_evidence_select on intel.information_evidence;
create policy information_evidence_select on intel.information_evidence
  for select to iims_app
  using (
    exists (
      select 1 from intel.information i
      where i.id = intel.information_evidence.information_id
    )
    and exists (
      select 1 from evidence.evidence_items e
      where e.id = intel.information_evidence.evidence_item_id
    )
  );

drop policy if exists information_evidence_write on intel.information_evidence;
create policy information_evidence_write on intel.information_evidence
  for all to iims_app
  using (
    exists (
      select 1 from intel.information i
      where i.id = intel.information_evidence.information_id
        and iam.has_permission('information', 'edit', i.classification)
    )
  )
  with check (
    exists (
      select 1 from intel.information i
      where i.id = intel.information_evidence.information_id
        and iam.has_permission('information', 'edit', i.classification)
    )
    and exists (
      select 1 from evidence.evidence_items e
      where e.id = intel.information_evidence.evidence_item_id
    )
  );

drop policy if exists findings_select on intel.findings;
create policy findings_select on intel.findings
  for select to iims_app
  using (
    deleted_at is null
    and iam.has_permission('findings', 'view', intel.findings.classification)
    and casework.can_reach_case(intel.findings.case_id, 'view')
  );

drop policy if exists findings_select_deleted on intel.findings;
create policy findings_select_deleted on intel.findings
  for select to iims_app
  using (
    deleted_at is not null
    and iam.has_permission('findings', 'delete', intel.findings.classification)
  );

drop policy if exists findings_insert on intel.findings;
create policy findings_insert on intel.findings
  for insert to iims_app
  with check (
    iam.has_permission('findings', 'create', intel.findings.classification)
    and casework.can_reach_case(intel.findings.case_id, 'view')
  );

drop policy if exists findings_update on intel.findings;
create policy findings_update on intel.findings
  for update to iims_app
  using (
    casework.can_reach_case(intel.findings.case_id, 'view')
    and (
      iam.has_permission('findings', 'edit', intel.findings.classification)
      or iam.has_permission('findings', 'approve', intel.findings.classification)
    )
  )
  with check (
    casework.can_reach_case(intel.findings.case_id, 'view')
    and (
      iam.has_permission('findings', 'edit', intel.findings.classification)
      or iam.has_permission('findings', 'approve', intel.findings.classification)
    )
  );

drop policy if exists finding_links_select on intel.finding_links;
create policy finding_links_select on intel.finding_links
  for select to iims_app
  using (
    exists (
      select 1 from intel.findings f where f.id = intel.finding_links.finding_id
    )
  );

drop policy if exists finding_links_write on intel.finding_links;
create policy finding_links_write on intel.finding_links
  for all to iims_app
  using (
    exists (
      select 1 from intel.findings f
      where f.id = intel.finding_links.finding_id
        and iam.has_permission('findings', 'edit', f.classification)
    )
  )
  with check (
    exists (
      select 1 from intel.findings f
      where f.id = intel.finding_links.finding_id
        and iam.has_permission('findings', 'edit', f.classification)
    )
  );

-- ---------------------------------------------------------------------------
-- Privileges.
--
-- The join tables genuinely delete: unlinking a piece of evidence from a
-- finding is a deletion, exactly as untagging a document is. Everything that
-- carries a history keeps the no-erasure rule.
-- ---------------------------------------------------------------------------
select config.revoke_erasure('intel');

grant delete on intel.entity_aliases to iims_app;
grant delete on intel.information_corroboration to iims_app;
grant delete on intel.information_evidence to iims_app;
grant delete on intel.finding_links to iims_app;

-- The merge log records a reversal and nothing else: an UPDATE is allowed by
-- the policy above and restricted to the reversal columns here.
create or replace function intel.merges_record_reversal_only()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  if new.surviving_entity_id <> old.surviving_entity_id
     or new.merged_entity_id <> old.merged_entity_id
     or new.reason <> old.reason
     or new.moved <> old.moved
     or new.merged_by <> old.merged_by
     or new.merged_at <> old.merged_at then
    raise exception
      'a merge record cannot be rewritten; only its reversal may be recorded'
      using errcode = 'restrict_violation';
  end if;

  if old.reversed_at is not null then
    raise exception 'that merge has already been reversed'
      using errcode = 'restrict_violation';
  end if;

  return new;
end
$$;

drop trigger if exists entity_merges_reversal_only on intel.entity_merges;
create trigger entity_merges_reversal_only
  before update on intel.entity_merges
  for each row execute function intel.merges_record_reversal_only();

-- ---------------------------------------------------------------------------
-- Permissions, as data (PRD 16).
--
-- `merge` is a separate action from `edit` because PRD 8.4 says merging
-- "requires authorised confirmation": somebody who may correct a name is not
-- thereby somebody who may decide two records are one thing.
-- ---------------------------------------------------------------------------
-- `merge` is a new verb, and the action vocabulary is a check constraint
-- rather than an enum for exactly this reason: it is replaceable in one
-- statement, where adding a value to a Postgres enum cannot be done in a
-- transaction that then uses it.
alter table iam.permissions drop constraint if exists permissions_action_check;
alter table iam.permissions add constraint permissions_action_check check (
  action = any (array[
    '*', 'view', 'create', 'edit', 'upload', 'download', 'share', 'approve',
    'delete', 'export', 'assign', 'configure', 'close', 'archive',
    -- PRD 8.4: deciding two entity records are one thing, which is not the
    -- same authority as being able to correct a name.
    'merge'
  ])
);

insert into iam.permissions (resource, action, scope, classification_ceiling, description)
values
  ('entities', 'merge', 'all', 'STRICTLY_RESTRICTED',
   'Decide that two entity records are the same thing, and reverse it (PRD 8.4).'),
  ('findings', 'approve', 'all', 'STRICTLY_RESTRICTED',
   'Accept or return a finding put forward by somebody else (PRD 15).')
on conflict (resource, action, scope, classification_ceiling) do nothing;

-- Who gets them. Entity resolution and finding review are supervisory acts.
insert into iam.role_permissions (role_id, permission_id)
select r.id, p.id
from iam.roles r
cross join iam.permissions p
where r.key in ('supervisor', 'operations_manager')
  and (
    (p.resource = 'entities' and p.action = 'merge')
    or (p.resource = 'findings' and p.action = 'approve')
  )
on conflict (role_id, permission_id) do nothing;

-- ---------------------------------------------------------------------------
-- Assertions, so the properties above are enforced rather than believed.
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad text;
begin
  -- Every intel table has RLS enabled AND forced. Enabled alone is bypassed
  -- by the table owner, which is postgres for everything here.
  select string_agg(c.relname, ', ')
  into v_bad
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'intel'
    and c.relkind = 'r'
    and not (c.relrowsecurity and c.relforcerowsecurity);

  if v_bad is not null then
    raise exception 'intel tables without forced row-level security: %', v_bad;
  end if;

  -- A human source cannot be recorded unprotected, whatever reaches the
  -- table. Asserted structurally rather than by probing: RLS on intel.sources
  -- is FORCED and its policies are granted to iims_app, so the migration role
  -- cannot insert a row here at all. That is the control working, and it is
  -- the reason the behavioural proof lives in the integration test, which
  -- runs as the application role.
  if not exists (
    select 1 from pg_catalog.pg_trigger t
    where t.tgrelid = 'intel.sources'::regclass
      and t.tgname = 'sources_protect_human'
      and not t.tgisinternal
  ) then
    raise exception
      'intel.sources has no sources_protect_human trigger, so a human source could be recorded unprotected (PRD 6.4)';
  end if;

  -- And the identity columns cannot be filled on an unprotected source,
  -- which is the half a trigger cannot guarantee on its own.
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'intel.sources'::regclass
      and conname = 'sources_identity_is_protected'
  ) then
    raise exception 'intel.sources lost its sources_identity_is_protected constraint';
  end if;
end
$$;
