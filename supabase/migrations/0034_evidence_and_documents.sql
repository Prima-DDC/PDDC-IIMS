-- PDDC IIMS 0034 : evidence, chain of custody and documents (PRD 6, 7).
--
-- The data model for M4. Three attitudes to change again, and here the
-- differences are the whole point of the module:
--
--   An evidence item is a live record: its custodian changes, its status
--   changes, a working copy is made from it. It is editable.
--
--   A custody event is a fact about a moment, and PRD 6.2 is explicit:
--   "events cannot be edited or deleted by any role; corrections are made by
--   adding a correcting event". So custody gets the same treatment as the
--   audit trail, hash chain included, because a chain of custody that cannot
--   be shown to be unbroken is not a chain of custody.
--
--   A document is versioned, and PRD 7.2 locks an approved version: a change
--   produces the next version with a recorded reason and needs approving
--   again.
--
-- What this migration does NOT do is touch Storage. The buckets and their
-- policies come next, separately, because an INSERT-only bucket policy is the
-- thing that makes an original write-once and it deserves its own test.

-- ---------------------------------------------------------------------------
-- The evidence identifier (PRD 6: EV-YYYY-CCCCCC-NNN).
--
-- Not a column default: the sequence is per case, so it needs the case. The
-- case number is taken from the case's own human identifier rather than from
-- a second counter, which keeps the two from ever disagreeing.
-- ---------------------------------------------------------------------------
create or replace function evidence.next_evidence_id(p_case_id uuid)
  returns text
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v_case_number text;
  v_year        int := extract(year from now())::int;
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

  -- The row lock serialises allocation, so two concurrent registrations
  -- cannot be handed the same number.
  insert into config.id_sequences (prefix, year, last_value)
  values ('EV:' || v_case_number, v_year, 1)
  on conflict (prefix, year) do update
    set last_value = config.id_sequences.last_value + 1
  returning last_value into v_next;

  return 'EV-' || v_year::text || '-' || v_case_number || '-' ||
         lpad(v_next::text, 3, '0');
end
$$;

comment on function evidence.next_evidence_id(uuid) is
  'PRD 6 evidence identifier: EV-YYYY-CCCCCC-NNN, numbered per case. Called '
  'in the INSERT rather than as a default, because the sequence needs the case.';

grant execute on function evidence.next_evidence_id(uuid) to iims_app;

-- ---------------------------------------------------------------------------
-- Evidence items (PRD 6.1).
-- ---------------------------------------------------------------------------
create table if not exists evidence.evidence_items (
  id          uuid primary key default gen_random_uuid(),
  evidence_id text unique not null,
  case_id     uuid not null references casework.cases (id) on delete cascade,

  -- Optional, and allocated when the item is first cited in a report.
  exhibit_no  text,

  evidence_type text not null check (
    evidence_type in (
      'document', 'photograph', 'video', 'audio', 'email', 'cctv',
      'digital_file', 'device', 'physical_item', 'interview_record',
      'public_record', 'registry_record', 'financial_record', 'other'
    )
  ),
  description text not null,

  -- The source register arrives with the intelligence module in M5. The
  -- column is here because PRD 6.1 puts it on the evidence item, and the
  -- foreign key is added in that migration rather than left dangling.
  source_id uuid,

  -- PRD 6.1 marks all four mandatory: evidence nobody can say who collected,
  -- when, where or how is not evidence anybody can rely on.
  collected_by      uuid not null references iam.users (id),
  collected_at      timestamptz not null,
  collection_location text not null,
  collection_method text not null,

  copy_status text not null default 'original'
    check (copy_status in ('original', 'working_copy')),
  -- A working copy points at the original it was made from (PRD 6.3).
  original_evidence_id uuid references evidence.evidence_items (id),

  file_name text,
  file_type text,
  file_size bigint check (file_size is null or file_size >= 0),

  -- Two hashes, deliberately. The browser declares one before the upload and
  -- the server computes the other from the stored object afterwards (PRD
  -- 6.3). Keeping both is what makes a mismatch a permanent record rather
  -- than something that can be quietly corrected.
  declared_sha256 text check (declared_sha256 is null or declared_sha256 ~ '^[0-9a-f]{64}$'),
  computed_sha256 text check (computed_sha256 is null or computed_sha256 ~ '^[0-9a-f]{64}$'),
  integrity_status text not null default 'no_file' check (
    integrity_status in ('no_file', 'hash_unverified', 'verified', 'mismatch')
  ),
  verified_at timestamptz,

  storage_bucket text,
  storage_path   text,

  classification text not null default 'CONFIDENTIAL'
                  references iam.classification_levels (code),
  current_custodian uuid references iam.users (id),

  status text not null default 'registered' check (
    status in ('registered', 'in_review', 'released', 'returned', 'archived')
  ),

  created_at timestamptz not null default now(),
  created_by uuid references iam.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references iam.users (id),
  version    int not null default 1,
  -- PRD 16: only the Administrator may remove evidence, as a recoverable soft
  -- delete with a reason and a second administrator's approval, and never
  -- under a legal hold. The approval queue is M1's; this is the column.
  deleted_at timestamptz,

  constraint evidence_working_copy_has_an_original
    check (copy_status = 'original' or original_evidence_id is not null),
  constraint evidence_original_is_not_its_own_copy
    check (original_evidence_id is null or original_evidence_id <> id),
  -- A file means a declared hash and a path: an item with a file and no hash
  -- could never be verified, which is the one thing PRD 6.3 asks for.
  constraint evidence_file_is_complete
    check (
      (file_name is null and storage_path is null and declared_sha256 is null
       and integrity_status = 'no_file')
      or (file_name is not null and storage_path is not null
          and declared_sha256 is not null and integrity_status <> 'no_file')
    ),
  constraint evidence_mismatch_has_both_hashes
    check (integrity_status <> 'mismatch' or computed_sha256 is not null),
  constraint evidence_verified_has_a_time
    check (integrity_status not in ('verified', 'mismatch') or verified_at is not null)
);

comment on table evidence.evidence_items is
  'PRD 6.1 evidence register. Originals are write-once in Storage and analysts '
  'work on working copies, which point back at the original.';
comment on column evidence.evidence_items.declared_sha256 is
  'Computed in the browser before the upload. Unattestable on its own, which '
  'is why the server computes its own and both are kept.';

create index if not exists evidence_case_idx
  on evidence.evidence_items (case_id, collected_at desc)
  where deleted_at is null;
create index if not exists evidence_custodian_idx
  on evidence.evidence_items (current_custodian)
  where deleted_at is null;
create index if not exists evidence_integrity_idx
  on evidence.evidence_items (integrity_status)
  where integrity_status in ('hash_unverified', 'mismatch');
create index if not exists evidence_original_idx
  on evidence.evidence_items (original_evidence_id)
  where original_evidence_id is not null;

-- ---------------------------------------------------------------------------
-- Chain of custody (PRD 6.2), hash-chained like the audit trail.
--
-- The head is a singleton holding the last hash, taken FOR UPDATE by the
-- trigger so two concurrent events cannot read the same tail and fork the
-- chain. Exactly the design 0003 uses, and for the same reason.
-- ---------------------------------------------------------------------------
create table if not exists evidence.custody_head (
  id          boolean primary key default true,
  last_hash   text not null,
  entry_count bigint not null default 0,
  updated_at  timestamptz not null default now(),
  constraint custody_head_singleton check (id)
);

insert into evidence.custody_head (id, last_hash, entry_count)
values (true, repeat('0', 64), 0)
on conflict (id) do nothing;

create table if not exists evidence.custody_events (
  id          uuid primary key default gen_random_uuid(),
  evidence_item_id uuid not null
                   references evidence.evidence_items (id) on delete cascade,

  event_type text not null check (
    event_type in (
      'registered', 'released', 'received', 'returned', 'copied',
      'examined', 'transferred', 'archived', 'correction'
    )
  ),
  occurred_at timestamptz not null default now(),

  released_by uuid references iam.users (id),
  received_by uuid references iam.users (id),
  purpose     text not null,
  location    text,
  condition   text,
  -- What the receiving person confirmed, in their words. PRD 6.2 calls it a
  -- confirmation or signature; a typed confirmation with an audited actor and
  -- a server timestamp is what this platform can honestly offer.
  confirmation text,

  -- A correcting event points at what it corrects (PRD 6.2).
  corrects_event_id uuid references evidence.custody_events (id),
  correction_reason text,

  recorded_at timestamptz not null default now(),
  recorded_by uuid not null references iam.users (id),

  -- Ordering is by this, not by a timestamp: now() is transaction-stable, so
  -- two events written together would tie. The lesson of 0028.
  seq bigserial not null,

  prev_hash text not null,
  row_hash  text not null,

  constraint custody_correction_has_a_reason
    check (
      (corrects_event_id is null and correction_reason is null)
      or (corrects_event_id is not null and length(coalesce(correction_reason, '')) >= 5)
    ),
  constraint custody_correction_is_not_itself
    check (corrects_event_id is null or corrects_event_id <> id),
  -- A movement has two ends. "Released to nobody" is not a movement.
  constraint custody_movement_has_two_ends
    check (
      event_type not in ('released', 'transferred')
      or (released_by is not null and received_by is not null)
    )
);

comment on table evidence.custody_events is
  'PRD 6.2 chain of custody. Append-only for every role, hash-chained so an '
  'unbroken chain can be demonstrated rather than asserted. A mistake is put '
  'right by a correcting event pointing at the original.';

create index if not exists custody_item_idx
  on evidence.custody_events (evidence_item_id, seq desc);
create index if not exists custody_corrects_idx
  on evidence.custody_events (corrects_event_id)
  where corrects_event_id is not null;

create or replace function evidence.append_custody_chain()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v_prev    text;
  v_payload text;
begin
  -- Serialises appends: a concurrent insert blocks here until this one
  -- commits, which is what keeps the chain a single line.
  select last_hash into v_prev
  from evidence.custody_head
  where id
  for update;

  if v_prev is null then
    raise exception 'custody chain head is missing; refusing to append'
      using errcode = 'data_exception';
  end if;

  new.prev_hash := v_prev;

  -- Explicit column list in a fixed order, never to_jsonb(new): a future
  -- column would change the hash of history and break verification.
  v_payload := concat_ws('|',
    new.id::text,
    new.evidence_item_id::text,
    new.event_type,
    extract(epoch from new.occurred_at)::text,
    coalesce(new.released_by::text, ''),
    coalesce(new.received_by::text, ''),
    new.purpose,
    coalesce(new.location, ''),
    coalesce(new.condition, ''),
    coalesce(new.confirmation, ''),
    coalesce(new.corrects_event_id::text, ''),
    coalesce(new.correction_reason, ''),
    new.recorded_by::text
  );

  new.row_hash := encode(
    extensions.digest(convert_to(v_prev || '|' || v_payload, 'UTF8'), 'sha256'),
    'hex'
  );

  update evidence.custody_head
  set last_hash   = new.row_hash,
      entry_count = entry_count + 1,
      updated_at  = now()
  where id;

  return new;
end
$$;

drop trigger if exists custody_events_hash_chain on evidence.custody_events;
create trigger custody_events_hash_chain
  before insert on evidence.custody_events
  for each row execute function evidence.append_custody_chain();

-- Append-only, enforced the same four ways as the audit trail: privilege,
-- policy, row trigger and a separate statement trigger for TRUNCATE, which
-- row triggers never see.
create or replace function evidence.refuse_custody_change()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  raise exception
    'evidence.custody_events is append-only (PRD 6.2). Correct the record by adding a correcting event.';
end
$$;

drop trigger if exists custody_events_no_change on evidence.custody_events;
create trigger custody_events_no_change
  before update or delete on evidence.custody_events
  for each row execute function evidence.refuse_custody_change();

drop trigger if exists custody_events_no_truncate on evidence.custody_events;
create trigger custody_events_no_truncate
  before truncate on evidence.custody_events
  for each statement execute function evidence.refuse_custody_change();

drop trigger if exists custody_head_no_delete on evidence.custody_head;
create trigger custody_head_no_delete
  before delete or truncate on evidence.custody_head
  for each statement execute function evidence.refuse_custody_change();

-- ---------------------------------------------------------------------------
-- Integrity checks (PRD 6.3): on demand and on a schedule, with the result
-- kept whether it matched or not.
-- ---------------------------------------------------------------------------
create table if not exists evidence.integrity_checks (
  id          uuid primary key default gen_random_uuid(),
  evidence_item_id uuid not null
                   references evidence.evidence_items (id) on delete cascade,

  checked_at  timestamptz not null default now(),
  expected_sha256 text not null,
  actual_sha256   text,
  result text not null check (result in ('match', 'mismatch', 'unreadable')),
  -- Null when a scheduled job ran it rather than a person.
  checked_by uuid references iam.users (id),
  notes      text,

  seq bigserial not null,

  constraint integrity_match_has_a_hash
    check (result <> 'match' or actual_sha256 = expected_sha256),
  constraint integrity_mismatch_has_a_hash
    check (result <> 'mismatch' or (actual_sha256 is not null and actual_sha256 <> expected_sha256))
);

comment on table evidence.integrity_checks is
  'PRD 6.3 re-verification. Append-only: a check that said mismatch stays said.';

create index if not exists integrity_item_idx
  on evidence.integrity_checks (evidence_item_id, seq desc);

drop trigger if exists integrity_checks_no_change on evidence.integrity_checks;
create trigger integrity_checks_no_change
  before update or delete on evidence.integrity_checks
  for each row execute function evidence.refuse_custody_change();

-- ---------------------------------------------------------------------------
-- The standard case folder structure (PRD 7.1), administrator-configurable.
-- ---------------------------------------------------------------------------
create table if not exists config.folder_templates (
  key       text primary key,
  name      text not null,
  position  int  not null,
  is_active boolean not null default true,
  description text
);

alter table config.folder_templates enable row level security;
alter table config.folder_templates force  row level security;

insert into config.folder_templates (key, name, position) values
  ('01_engagement',        '01 Engagement',         10),
  ('02_client_information','02 Client Information', 20),
  ('03_investigation_plan','03 Investigation Plan', 30),
  ('04_field_investigation','04 Field Investigation', 40),
  ('05_interviews',        '05 Interviews',         50),
  ('06_corporate_records', '06 Corporate Records',  60),
  ('07_financial_records', '07 Financial Records',  70),
  ('08_digital_evidence',  '08 Digital Evidence',   80),
  ('09_analysis',          '09 Analysis',           90),
  ('10_draft_reports',     '10 Draft Reports',     100),
  ('11_final_report',      '11 Final Report',      110),
  ('12_closure',           '12 Closure',           120)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Documents (PRD 7.2, 7.3).
-- ---------------------------------------------------------------------------
create table if not exists docs.folders (
  id       uuid primary key default gen_random_uuid(),
  case_id  uuid not null references casework.cases (id) on delete cascade,
  key      text not null,
  name     text not null,
  position int  not null,
  -- A folder created from the template, which is not renamed or removed by
  -- hand: the template is where that happens, for every case at once.
  is_system boolean not null default true,
  created_at timestamptz not null default now(),

  unique (case_id, key)
);

create index if not exists folders_case_idx on docs.folders (case_id, position);

create table if not exists docs.documents (
  id          uuid primary key default gen_random_uuid(),
  document_id text unique not null default config.next_human_id('DOC'),
  case_id     uuid not null references casework.cases (id) on delete cascade,
  folder_id   uuid references docs.folders (id) on delete set null,

  title         text not null,
  document_type text not null check (
    document_type in (
      'engagement_letter', 'nda', 'client_instruction', 'kyc',
      'investigation_plan', 'field_note', 'interview_record',
      'corporate_record', 'financial_record', 'analysis', 'draft_report',
      'final_report', 'correspondence', 'closure', 'other'
    )
  ),
  classification text not null default 'CONFIDENTIAL'
                  references iam.classification_levels (code),

  -- Set by the version table's own writes, so a document cannot claim a
  -- version it does not have.
  current_version_id  uuid,
  approved_version_id uuid,

  related_source_id   uuid,
  related_evidence_id uuid references evidence.evidence_items (id),
  related_task_id     uuid references casework.tasks (id) on delete set null,

  created_at timestamptz not null default now(),
  created_by uuid references iam.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references iam.users (id),
  version    int not null default 1,
  deleted_at timestamptz
);

comment on table docs.documents is
  'PRD 7.3 document register. The file itself lives in a version row: a '
  'document is the thing, its versions are what it has been.';

create index if not exists documents_case_idx
  on docs.documents (case_id, created_at desc)
  where deleted_at is null;
create index if not exists documents_folder_idx
  on docs.documents (folder_id)
  where deleted_at is null;

create table if not exists docs.document_versions (
  id          uuid primary key default gen_random_uuid(),
  document_id uuid not null references docs.documents (id) on delete cascade,

  -- Both: the number orders them, the label is what PRD 7.2 shows (v0.1, v1.0).
  version_no    int  not null,
  version_label text not null,
  change_note   text,

  file_name text not null,
  mime_type text not null,
  file_size bigint not null check (file_size >= 0),
  sha256    text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  storage_bucket text not null,
  storage_path   text not null,

  is_current  boolean not null default true,
  is_approved boolean not null default false,
  approved_by uuid references iam.users (id),
  approved_at timestamptz,

  created_at timestamptz not null default now(),
  created_by uuid references iam.users (id),

  unique (document_id, version_no),
  unique (storage_path),
  constraint version_approval_has_an_approver
    check (not is_approved or (approved_by is not null and approved_at is not null))
);

comment on table docs.document_versions is
  'PRD 7.2 version control. An approved version is locked: a change produces '
  'the next version with a recorded reason, and needs approving again.';

-- One current version per document, which is what every screen reads.
create unique index if not exists document_one_current_idx
  on docs.document_versions (document_id) where is_current;

create index if not exists document_versions_idx
  on docs.document_versions (document_id, version_no desc);

alter table docs.documents
  drop constraint if exists documents_current_version_fk;
alter table docs.documents
  add constraint documents_current_version_fk
  foreign key (current_version_id) references docs.document_versions (id)
  on delete set null;

alter table docs.documents
  drop constraint if exists documents_approved_version_fk;
alter table docs.documents
  add constraint documents_approved_version_fk
  foreign key (approved_version_id) references docs.document_versions (id)
  on delete set null;

-- An approved version is frozen. Its approval flag and its file cannot be
-- changed; a new version is how a document changes (PRD 7.2).
create or replace function docs.refuse_approved_version_change()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  if old.is_approved then
    if new.sha256 <> old.sha256
       or new.storage_path <> old.storage_path
       or new.file_name <> old.file_name
       or new.version_no <> old.version_no then
      raise exception
        'Version % is approved and cannot be altered (PRD 7.2). Upload the next version instead.',
        old.version_label;
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists document_versions_approved_lock on docs.document_versions;
create trigger document_versions_approved_lock
  before update on docs.document_versions
  for each row execute function docs.refuse_approved_version_change();

-- ---------------------------------------------------------------------------
-- Tags (PRD 17.2).
-- ---------------------------------------------------------------------------
create table if not exists docs.tags (
  key  text primary key,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists docs.document_tags (
  document_id uuid not null references docs.documents (id) on delete cascade,
  tag_key     text not null references docs.tags (key) on delete cascade,
  primary key (document_id, tag_key)
);

-- ---------------------------------------------------------------------------
-- The folders every case gets (PRD 7.1: "created automatically when a case is
-- created").
--
-- A trigger rather than application code, so a case created by any route gets
-- its folders. SECURITY DEFINER because the folders are system structure
-- rather than something the creating user is writing.
-- ---------------------------------------------------------------------------
create or replace function docs.create_case_folders()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  insert into docs.folders (case_id, key, name, position, is_system)
  select new.id, t.key, t.name, t.position, true
  from config.folder_templates t
  where t.is_active
  on conflict (case_id, key) do nothing;

  return new;
end
$$;

drop trigger if exists cases_create_folders on casework.cases;
create trigger cases_create_folders
  after insert on casework.cases
  for each row execute function docs.create_case_folders();

-- And the folders for cases that already exist, so the structure is not only
-- true of cases opened from now on.
insert into docs.folders (case_id, key, name, position, is_system)
select c.id, t.key, t.name, t.position, true
from casework.cases c
cross join config.folder_templates t
where t.is_active
on conflict (case_id, key) do nothing;

-- ---------------------------------------------------------------------------
-- updated_at / updated_by.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['evidence_items']
  loop
    execute format('drop trigger if exists %I_touch on evidence.%I', t, t);
    execute format(
      'create trigger %I_touch before update on evidence.%I '
      'for each row execute function iam.touch_row()', t, t);
  end loop;

  foreach t in array array['documents']
  loop
    execute format('drop trigger if exists %I_touch on docs.%I', t, t);
    execute format(
      'create trigger %I_touch before update on docs.%I '
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
  foreach t in array array['evidence_items', 'custody_events', 'custody_head',
                           'integrity_checks']
  loop
    execute format('alter table evidence.%I enable row level security', t);
    execute format('alter table evidence.%I force  row level security', t);
  end loop;

  foreach t in array array['folders', 'documents', 'document_versions',
                           'tags', 'document_tags']
  loop
    execute format('alter table docs.%I enable row level security', t);
    execute format('alter table docs.%I force  row level security', t);
  end loop;
end
$$;

-- Evidence follows its case and its own classification, the composition 0027
-- settled on: an item can be more sensitive than the case it belongs to.
drop policy if exists evidence_items_select on evidence.evidence_items;
create policy evidence_items_select on evidence.evidence_items
  for select to iims_app
  using (
    deleted_at is null
    and iam.has_permission('evidence', 'view', evidence.evidence_items.classification)
    and casework.can_reach_case(evidence.evidence_items.case_id, 'view')
  );

-- Removed evidence stays visible to whoever may remove it, which is the rule
-- 0033 had to establish: Postgres applies the SELECT policy to the new row of
-- an UPDATE, so without this the soft delete is impossible for everybody.
drop policy if exists evidence_items_select_deleted on evidence.evidence_items;
create policy evidence_items_select_deleted on evidence.evidence_items
  for select to iims_app
  using (
    deleted_at is not null
    and iam.has_permission('evidence', 'delete', evidence.evidence_items.classification)
  );

drop policy if exists evidence_items_insert on evidence.evidence_items;
create policy evidence_items_insert on evidence.evidence_items
  for insert to iims_app
  with check (
    iam.has_permission('evidence', 'create', evidence.evidence_items.classification)
    and casework.can_reach_case(evidence.evidence_items.case_id, 'view')
  );

drop policy if exists evidence_items_update on evidence.evidence_items;
create policy evidence_items_update on evidence.evidence_items
  for update to iims_app
  using (
    iam.has_permission('evidence', 'edit', evidence.evidence_items.classification)
    and casework.can_reach_case(evidence.evidence_items.case_id, 'view')
  )
  with check (
    iam.has_permission('evidence', 'edit', evidence.evidence_items.classification)
    and casework.can_reach_case(evidence.evidence_items.case_id, 'view')
  );

-- Custody is readable by anybody who can read the item, and insert-only.
-- PRD 16 gives custody its own create permission, because recording a
-- movement is not the same as editing the item.
drop policy if exists custody_events_select on evidence.custody_events;
create policy custody_events_select on evidence.custody_events
  for select to iims_app
  using (
    exists (
      select 1 from evidence.evidence_items i
      where i.id = evidence.custody_events.evidence_item_id
    )
  );

drop policy if exists custody_events_insert on evidence.custody_events;
create policy custody_events_insert on evidence.custody_events
  for insert to iims_app
  with check (
    iam.has_permission('custody', 'create')
    and exists (
      select 1 from evidence.evidence_items i
      where i.id = evidence.custody_events.evidence_item_id
    )
  );

drop policy if exists integrity_checks_select on evidence.integrity_checks;
create policy integrity_checks_select on evidence.integrity_checks
  for select to iims_app
  using (
    exists (
      select 1 from evidence.evidence_items i
      where i.id = evidence.integrity_checks.evidence_item_id
    )
  );

drop policy if exists integrity_checks_insert on evidence.integrity_checks;
create policy integrity_checks_insert on evidence.integrity_checks
  for insert to iims_app
  with check (
    exists (
      select 1 from evidence.evidence_items i
      where i.id = evidence.integrity_checks.evidence_item_id
    )
  );

-- The custody head is written only by the chain trigger, which is SECURITY
-- DEFINER, so the application needs no policy on it at all. No policy means
-- no access, which is the safe direction.

-- Folders follow their case and are read-only to the application: they are
-- created by the trigger from the template.
drop policy if exists folders_select on docs.folders;
create policy folders_select on docs.folders
  for select to iims_app
  using (casework.can_reach_case(docs.folders.case_id, 'view'));

drop policy if exists documents_select on docs.documents;
create policy documents_select on docs.documents
  for select to iims_app
  using (
    deleted_at is null
    and iam.has_permission('documents', 'view', docs.documents.classification)
    and casework.can_reach_case(docs.documents.case_id, 'view')
  );

drop policy if exists documents_select_deleted on docs.documents;
create policy documents_select_deleted on docs.documents
  for select to iims_app
  using (
    deleted_at is not null
    and iam.has_permission('documents', 'edit', docs.documents.classification)
    and casework.can_reach_case(docs.documents.case_id, 'view')
  );

drop policy if exists documents_insert on docs.documents;
create policy documents_insert on docs.documents
  for insert to iims_app
  with check (
    iam.has_permission('documents', 'create', docs.documents.classification)
    and casework.can_reach_case(docs.documents.case_id, 'view')
  );

drop policy if exists documents_update on docs.documents;
create policy documents_update on docs.documents
  for update to iims_app
  using (
    iam.has_permission('documents', 'edit', docs.documents.classification)
    and casework.can_reach_case(docs.documents.case_id, 'view')
  )
  with check (
    iam.has_permission('documents', 'edit', docs.documents.classification)
    and casework.can_reach_case(docs.documents.case_id, 'view')
  );

drop policy if exists document_versions_select on docs.document_versions;
create policy document_versions_select on docs.document_versions
  for select to iims_app
  using (
    exists (
      select 1 from docs.documents d
      where d.id = docs.document_versions.document_id
    )
  );

drop policy if exists document_versions_insert on docs.document_versions;
create policy document_versions_insert on docs.document_versions
  for insert to iims_app
  with check (
    exists (
      select 1 from docs.documents d
      where d.id = docs.document_versions.document_id
        and iam.has_permission('documents', 'upload', d.classification)
    )
  );

-- Only the flags move: the approved lock above refuses a change to the file.
drop policy if exists document_versions_update on docs.document_versions;
create policy document_versions_update on docs.document_versions
  for update to iims_app
  using (
    exists (
      select 1 from docs.documents d
      where d.id = docs.document_versions.document_id
        and iam.has_permission('documents', 'edit', d.classification)
    )
  )
  with check (
    exists (
      select 1 from docs.documents d
      where d.id = docs.document_versions.document_id
        and iam.has_permission('documents', 'edit', d.classification)
    )
  );

-- Tags are a shared vocabulary: everybody reads them, administrators curate.
drop policy if exists tags_select on docs.tags;
create policy tags_select on docs.tags
  for select to iims_app using (true);

drop policy if exists tags_write on docs.tags;
create policy tags_write on docs.tags
  for all to iims_app
  using (iam.has_permission('documents', 'edit'))
  with check (iam.has_permission('documents', 'edit'));

drop policy if exists document_tags_select on docs.document_tags;
create policy document_tags_select on docs.document_tags
  for select to iims_app
  using (
    exists (
      select 1 from docs.documents d where d.id = docs.document_tags.document_id
    )
  );

drop policy if exists document_tags_write on docs.document_tags;
create policy document_tags_write on docs.document_tags
  for all to iims_app
  using (
    exists (
      select 1 from docs.documents d
      where d.id = docs.document_tags.document_id
        and iam.has_permission('documents', 'edit', d.classification)
    )
  )
  with check (
    exists (
      select 1 from docs.documents d
      where d.id = docs.document_tags.document_id
        and iam.has_permission('documents', 'edit', d.classification)
    )
  );

-- ---------------------------------------------------------------------------
-- Privileges.
--
-- `document_tags` genuinely deletes: untagging is a deletion, not a state
-- change, exactly as removing a role assignment is in `iam`. Everything else
-- in these schemas follows the no-erasure rule, and custody and integrity
-- checks are insert-only on top of that.
-- ---------------------------------------------------------------------------
select config.revoke_erasure('evidence');
select config.revoke_erasure('docs');

grant delete on docs.document_tags to iims_app;

revoke update on evidence.custody_events from iims_app;
revoke update on evidence.integrity_checks from iims_app;

grant usage, select on sequence evidence.custody_events_seq_seq to iims_app;
grant usage, select on sequence evidence.integrity_checks_seq_seq to iims_app;
