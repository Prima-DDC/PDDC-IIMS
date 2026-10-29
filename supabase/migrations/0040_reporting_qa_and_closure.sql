-- PDDC IIMS 0040 : reports, QA review, delivery and case closure
-- (PRD 5.9, 10, screens 18 to 21).
--
-- The end of the chain. A report is where everything the platform has
-- recorded is finally asserted to a client, which is why two properties
-- matter more here than anywhere else.
--
-- FIRST, A FINAL VERSION IS LOCKED, AND THE WORKFLOW CANNOT BE SHORT-CUT.
-- PRD 10.1 is a seven-stage line: Draft, Investigator Review, Supervisor
-- Review, QA Review, Approval, Final, Client Delivery, each recorded with
-- user, time and decision, and "the author can never approve their own
-- report". The stages live in `reporting.report_transitions`, which is
-- append-only like the audit trail: a workflow whose history can be rewritten
-- is not a workflow, it is a status field.
--
-- SECOND, EVERY STATEMENT CITES WHAT IT RESTS ON.
-- PRD 10.2 wants sections "pulled from findings, so every statement can cite
-- finding IDs and exhibit numbers". `reporting.section_citations` is a real
-- foreign key per kind, so a citation cannot point at a row that is not
-- there, and a trigger refuses a citation of a finding that has not been
-- accepted: a draft conclusion in a client report is somebody's unreviewed
-- opinion presented as PDDC's.
--
-- Closure (PRD 5.9) is in `casework` rather than here, because it is a fact
-- about the case. Its nine requirements are already implemented and unit
-- tested in the domain; what this migration adds is the record of the answers
-- and the supervisor's approval.

-- ---------------------------------------------------------------------------
-- Retention classes (PRD 14.2), which closure has to choose one of.
-- ---------------------------------------------------------------------------
create table if not exists config.retention_classes (
  code        text primary key,
  name        text not null,
  years       integer not null check (years > 0),
  description text,
  jurisdiction text,
  record_type text,
  is_active   boolean not null default true,
  position    integer not null default 0,
  created_at  timestamptz not null default now()
);

comment on table config.retention_classes is
  'PRD 14.2 retention rules, as a lookup a case closure selects from. '
  'Administrator-configurable, with jurisdiction and record type, because '
  'PRD open question 1 leaves data residency to PDDC.';

insert into config.retention_classes (code, name, years, description, position)
values
  ('standard_7', 'Standard, 7 years', 7,
   'The default for a completed investigation with no special obligation.', 1),
  ('litigation_10', 'Litigation or regulatory, 10 years', 10,
   'Where proceedings are on foot or expected, or a regulator may ask.', 2),
  ('financial_crime_10', 'Financial crime, 10 years', 10,
   'Money laundering, fraud and sanctions work, where the obligation is longer.', 3),
  ('short_3', 'Screening only, 3 years', 3,
   'A conflict check or a declined enquiry that produced no case file.', 4),
  ('permanent', 'Permanent', 99,
   'Kept indefinitely, for a matter of lasting significance to PDDC.', 5)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- Reports (PRD 10, screen 18).
-- ---------------------------------------------------------------------------
create table if not exists reporting.reports (
  id        uuid primary key default gen_random_uuid(),
  report_id text unique not null default config.next_human_id('RPT', 6),
  case_id   uuid not null references casework.cases (id) on delete cascade,

  title text not null,
  report_type text not null default 'investigation_report' check (
    report_type in (
      'investigation_report', 'interim_report', 'due_diligence_report',
      'intelligence_brief', 'memorandum', 'closure_summary', 'other'
    )
  ),

  -- PRD 10.1's line, as a single status on the report. The version carries
  -- its own, because a report in Final can have a later draft in flight.
  status text not null default 'draft' check (
    status in (
      'draft', 'investigator_review', 'supervisor_review', 'qa_review',
      'approval', 'final', 'delivered', 'withdrawn'
    )
  ),

  author uuid not null references iam.users (id),

  current_version_id  uuid,
  approved_version_id uuid,

  classification text not null default 'CONFIDENTIAL'
    references iam.classification_levels (code),

  created_at timestamptz not null default now(),
  created_by uuid references iam.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references iam.users (id),
  version    integer not null default 1,
  deleted_at timestamptz,
  deleted_by uuid references iam.users (id)
);

create index if not exists reports_case_idx on reporting.reports (case_id);
create index if not exists reports_search_idx
  on reporting.reports using gin (to_tsvector('simple', title));

-- ---------------------------------------------------------------------------
-- Versions (PRD 10.2: v0.1 ... v1.0 ... Approved Final, final versions
-- locked).
--
-- The lock is a trigger, not a convention. An approved version is what a
-- client has been told, and the next change is the next version.
-- ---------------------------------------------------------------------------
create table if not exists reporting.report_versions (
  id        uuid primary key default gen_random_uuid(),
  report_id uuid not null references reporting.reports (id) on delete cascade,

  version_no    integer not null,
  version_label text not null,

  status text not null default 'draft' check (
    status in (
      'draft', 'investigator_review', 'supervisor_review', 'qa_review',
      'approval', 'final', 'superseded', 'returned'
    )
  ),

  -- The report's own front matter, which a PDF needs and a reader expects.
  executive_summary text,
  scope_statement   text,
  methodology       text,
  limitations       text,
  conclusion        text,

  change_note text,

  is_current  boolean not null default true,
  is_approved boolean not null default false,
  approved_by uuid references iam.users (id),
  approved_at timestamptz,

  created_at timestamptz not null default now(),
  created_by uuid references iam.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references iam.users (id),
  version    integer not null default 1,

  unique (report_id, version_no),
  unique (report_id, version_label),
  constraint report_versions_approval_recorded check (
    is_approved = (approved_by is not null and approved_at is not null)
  ),
  -- PRD 10.1: the author can never approve their own report. At the table as
  -- well as in the domain, because this one is worth two locks.
  constraint report_versions_not_approved_by_its_author check (
    approved_by is null or approved_by <> created_by
  )
);

create index if not exists report_versions_report_idx
  on reporting.report_versions (report_id);
create unique index if not exists report_versions_one_current
  on reporting.report_versions (report_id) where is_current;

alter table reporting.reports
  drop constraint if exists reports_current_version_fkey;
alter table reporting.reports
  add constraint reports_current_version_fkey
  foreign key (current_version_id) references reporting.report_versions (id);
alter table reporting.reports
  drop constraint if exists reports_approved_version_fkey;
alter table reporting.reports
  add constraint reports_approved_version_fkey
  foreign key (approved_version_id) references reporting.report_versions (id);

-- ---------------------------------------------------------------------------
-- Sections, and what each one cites (PRD 10.2).
-- ---------------------------------------------------------------------------
create table if not exists reporting.report_sections (
  id         uuid primary key default gen_random_uuid(),
  version_id uuid not null references reporting.report_versions (id) on delete cascade,

  position integer not null,
  heading  text not null,
  body     text,

  section_type text not null default 'narrative' check (
    section_type in (
      'narrative', 'background', 'methodology', 'finding', 'analysis',
      'exhibit_schedule', 'conclusion', 'recommendation', 'appendix'
    )
  ),

  created_at timestamptz not null default now(),
  created_by uuid references iam.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references iam.users (id),
  version    integer not null default 1,

  unique (version_id, position)
);

create index if not exists report_sections_version_idx
  on reporting.report_sections (version_id);

create table if not exists reporting.section_citations (
  id         uuid primary key default gen_random_uuid(),
  section_id uuid not null references reporting.report_sections (id) on delete cascade,

  citation_type text not null check (
    citation_type in ('finding', 'evidence', 'document', 'information')
  ),
  -- One column per kind rather than a polymorphic id, so every citation is a
  -- real foreign key. A report that cites a row which is not there is the
  -- worst failure this module could have.
  finding_id       uuid references intel.findings (id) on delete cascade,
  evidence_item_id uuid references evidence.evidence_items (id) on delete cascade,
  document_id      uuid references docs.documents (id) on delete cascade,
  information_id   uuid references intel.information (id) on delete cascade,

  note text,

  created_at timestamptz not null default now(),
  created_by uuid references iam.users (id),

  constraint section_citations_exactly_one_target check (
    (case when finding_id       is not null then 1 else 0 end) +
    (case when evidence_item_id is not null then 1 else 0 end) +
    (case when document_id      is not null then 1 else 0 end) +
    (case when information_id   is not null then 1 else 0 end) = 1
  ),
  constraint section_citations_type_matches_target check (
    (citation_type = 'finding' and finding_id is not null)
    or (citation_type = 'evidence' and evidence_item_id is not null)
    or (citation_type = 'document' and document_id is not null)
    or (citation_type = 'information' and information_id is not null)
  )
);

create index if not exists section_citations_section_idx
  on reporting.section_citations (section_id);

/**
 * Only an accepted finding may be cited, and only evidence that still
 * matches what was collected.
 *
 * Both are refusals a user will meet, so both carry a readable message. The
 * first is PRD 10.1's point: a draft conclusion in a client report is
 * somebody's unreviewed opinion presented as PDDC's. The second is PRD 6.3's:
 * an exhibit whose stored file no longer matches cannot support anything.
 */
create or replace function reporting.citation_is_citable()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
declare
  v_status text;
  v_ref    text;
begin
  if new.finding_id is not null then
    select f.status, f.finding_id into v_status, v_ref
    from intel.findings f where f.id = new.finding_id;

    if v_status is distinct from 'accepted' then
      raise exception
        '% has not been accepted, so it cannot be cited in a report (it is %)',
        coalesce(v_ref, 'that finding'), coalesce(v_status, 'missing')
        using errcode = 'restrict_violation';
    end if;
  end if;

  if new.evidence_item_id is not null then
    select e.integrity_status, e.evidence_id into v_status, v_ref
    from evidence.evidence_items e where e.id = new.evidence_item_id;

    if v_status = 'mismatch' then
      raise exception
        '% failed its integrity check, so it cannot be cited until that is resolved',
        coalesce(v_ref, 'that exhibit')
        using errcode = 'restrict_violation';
    end if;
  end if;

  return new;
end
$$;

drop trigger if exists section_citations_citable on reporting.section_citations;
create trigger section_citations_citable
  before insert or update on reporting.section_citations
  for each row execute function reporting.citation_is_citable();

-- ---------------------------------------------------------------------------
-- The approved-version lock (PRD 10.2).
-- ---------------------------------------------------------------------------
create or replace function reporting.version_is_locked_when_final()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  if old.is_approved and (
    new.executive_summary is distinct from old.executive_summary
    or new.scope_statement is distinct from old.scope_statement
    or new.methodology     is distinct from old.methodology
    or new.limitations     is distinct from old.limitations
    or new.conclusion      is distinct from old.conclusion
    or new.version_label   is distinct from old.version_label
  ) then
    raise exception
      '% is approved and cannot be altered. A change is the next version, with a reason (PRD 10.2)',
      old.version_label
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;

drop trigger if exists report_versions_locked on reporting.report_versions;
create trigger report_versions_locked
  before update on reporting.report_versions
  for each row execute function reporting.version_is_locked_when_final();

/** A section of an approved version is locked with it. */
create or replace function reporting.section_is_locked_when_final()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
declare
  v_approved boolean;
  v_label    text;
begin
  select v.is_approved, v.version_label into v_approved, v_label
  from reporting.report_versions v
  where v.id = coalesce(new.version_id, old.version_id);

  if v_approved then
    raise exception
      '% is approved, so its sections cannot change. A change is the next version (PRD 10.2)',
      v_label
      using errcode = 'restrict_violation';
  end if;

  return coalesce(new, old);
end
$$;

drop trigger if exists report_sections_locked on reporting.report_sections;
create trigger report_sections_locked
  before insert or update or delete on reporting.report_sections
  for each row execute function reporting.section_is_locked_when_final();

-- ---------------------------------------------------------------------------
-- The workflow history (PRD 10.1), append-only.
--
-- "Each stage is recorded with user, time and decision." A workflow whose
-- history can be rewritten is a status field, so this gets the same
-- treatment as the audit trail: insert only, a row trigger refusing change,
-- and a statement trigger for TRUNCATE, which row triggers never see.
-- ---------------------------------------------------------------------------
create table if not exists reporting.report_transitions (
  id         uuid primary key default gen_random_uuid(),
  report_id  uuid not null references reporting.reports (id) on delete cascade,
  version_id uuid references reporting.report_versions (id) on delete cascade,

  from_status text not null,
  to_status   text not null,
  decision    text not null check (
    decision in ('submitted', 'approved', 'returned', 'withdrawn', 'delivered')
  ),
  notes text,

  decided_by uuid not null references iam.users (id),
  decided_at timestamptz not null default now()
);

create index if not exists report_transitions_report_idx
  on reporting.report_transitions (report_id, decided_at);

create or replace function reporting.transitions_are_append_only()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  raise exception
    'the report workflow history is append-only: a decision is corrected by recording the next one'
    using errcode = 'restrict_violation';
end
$$;

drop trigger if exists report_transitions_no_change on reporting.report_transitions;
create trigger report_transitions_no_change
  before update or delete on reporting.report_transitions
  for each row execute function reporting.transitions_are_append_only();

drop trigger if exists report_transitions_no_truncate on reporting.report_transitions;
create trigger report_transitions_no_truncate
  before truncate on reporting.report_transitions
  for each statement execute function reporting.transitions_are_append_only();

-- ---------------------------------------------------------------------------
-- QA review (PRD 10.3).
--
-- Twelve named items, each pass, fail or not applicable, with a comment. The
-- reviewer chooses Approve or Return for Correction, and the result is
-- derived from the items rather than typed: a review with a failed item
-- cannot be an approval, which is the one thing a checklist is for.
-- ---------------------------------------------------------------------------
create table if not exists config.qa_checklist_items (
  key         text primary key,
  label       text not null,
  guidance    text,
  position    integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

comment on table config.qa_checklist_items is
  'PRD 10.3 QA checklist, as configurable data rather than code, so PDDC can '
  'add an item without a release.';

insert into config.qa_checklist_items (key, label, guidance, position)
values
  ('scope_addressed', 'Scope addressed',
   'Every question the case was opened to answer is answered, or its absence is explained.', 1),
  ('instructions_followed', 'Instructions followed',
   'The work matches what the client instructed, including anything they ruled out.', 2),
  ('evidence_referenced', 'Evidence referenced',
   'Each factual statement cites the exhibit it rests on.', 3),
  ('sources_recorded', 'Sources appropriately recorded',
   'Reliability is stated, and a human source is not identifiable from the text.', 4),
  ('facts_separated', 'Facts separated from analysis',
   'A reader can tell what was found from what it is taken to mean.', 5),
  ('contradictions_addressed', 'Contradictions addressed',
   'Anything that cuts against the conclusion is dealt with, not omitted.', 6),
  ('dates_verified', 'Dates verified',
   'Every date in the report matches the record it came from.', 7),
  ('names_verified', 'Names verified',
   'Spellings match the registry or identity document, and aliases are noted.', 8),
  ('findings_supported', 'Findings supported',
   'Each finding is accepted and its support is cited.', 9),
  ('conclusions_supported', 'Conclusions supported',
   'The conclusion follows from the findings and claims no more than they carry.', 10),
  ('classification_correct', 'Classification correct',
   'The banner and the handling instructions match the most sensitive content.', 11),
  ('formatting_correct', 'Formatting correct',
   'Headings, numbering, exhibit references and the footer are right.', 12)
on conflict (key) do nothing;

create table if not exists reporting.qa_reviews (
  id         uuid primary key default gen_random_uuid(),
  report_id  uuid not null references reporting.reports (id) on delete cascade,
  version_id uuid not null references reporting.report_versions (id) on delete cascade,

  reviewer uuid not null references iam.users (id),
  result   text check (result in ('approved', 'returned')),
  summary  text,

  started_at   timestamptz not null default now(),
  completed_at timestamptz,

  created_at timestamptz not null default now(),
  created_by uuid references iam.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references iam.users (id),
  version    integer not null default 1,

  constraint qa_reviews_result_recorded check (
    (result is null) = (completed_at is null)
  )
);

create index if not exists qa_reviews_version_idx
  on reporting.qa_reviews (version_id);

create table if not exists reporting.qa_review_items (
  id        uuid primary key default gen_random_uuid(),
  review_id uuid not null references reporting.qa_reviews (id) on delete cascade,
  item_key  text not null references config.qa_checklist_items (key),

  result  text not null check (result in ('pass', 'fail', 'not_applicable')),
  comment text,

  created_at timestamptz not null default now(),
  created_by uuid references iam.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references iam.users (id),
  version    integer not null default 1,

  unique (review_id, item_key),
  -- PRD 10.3 asks for comments per item; a failure without one tells the
  -- author nothing, so it is refused.
  constraint qa_items_failure_has_a_comment check (
    result <> 'fail' or (comment is not null and btrim(comment) <> '')
  )
);

/**
 * A review with a failed item cannot be an approval.
 *
 * The one thing a checklist is for. Enforced at the table because a QA
 * result is the last gate before a client sees the work, and because the
 * alternative is a checklist whose boxes are decoration.
 */
create or replace function reporting.qa_result_follows_its_items()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
declare
  v_failed int;
begin
  if new.result is distinct from 'approved' then
    return new;
  end if;

  select count(*) into v_failed
  from reporting.qa_review_items i
  where i.review_id = new.id and i.result = 'fail';

  if v_failed > 0 then
    raise exception
      'this review has % failed item(s), so it cannot be an approval. Return it for correction, or pass the items first',
      v_failed
      using errcode = 'restrict_violation';
  end if;

  return new;
end
$$;

drop trigger if exists qa_reviews_result_follows_items on reporting.qa_reviews;
create trigger qa_reviews_result_follows_items
  before insert or update on reporting.qa_reviews
  for each row execute function reporting.qa_result_follows_its_items();

-- ---------------------------------------------------------------------------
-- Client delivery (PRD 10.2).
-- ---------------------------------------------------------------------------
create table if not exists reporting.deliveries (
  id         uuid primary key default gen_random_uuid(),
  report_id  uuid not null references reporting.reports (id) on delete cascade,
  version_id uuid not null references reporting.report_versions (id),

  delivered_to   text not null,
  delivery_method text not null check (
    delivery_method in (
      'secure_link', 'encrypted_email', 'hand_delivery', 'courier',
      'client_portal', 'in_person_briefing', 'other'
    )
  ),
  delivered_at timestamptz not null default now(),
  delivered_by uuid not null references iam.users (id),

  acknowledgement      text,
  acknowledged_at      timestamptz,
  acknowledged_by_name text,

  notes text,

  created_at timestamptz not null default now(),
  created_by uuid references iam.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references iam.users (id),
  version    integer not null default 1,

  constraint deliveries_acknowledgement_recorded check (
    (acknowledged_at is null) = (acknowledgement is null)
  ),
  constraint deliveries_not_in_the_future check (delivered_at <= now())
);

create index if not exists deliveries_report_idx on reporting.deliveries (report_id);

/** Only an approved version is delivered to a client. */
create or replace function reporting.delivery_is_of_an_approved_version()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
declare
  v_approved boolean;
  v_label    text;
begin
  select v.is_approved, v.version_label into v_approved, v_label
  from reporting.report_versions v where v.id = new.version_id;

  if not coalesce(v_approved, false) then
    raise exception
      '% has not been approved, so it cannot be delivered to a client',
      coalesce(v_label, 'that version')
      using errcode = 'restrict_violation';
  end if;

  return new;
end
$$;

drop trigger if exists deliveries_approved_only on reporting.deliveries;
create trigger deliveries_approved_only
  before insert or update on reporting.deliveries
  for each row execute function reporting.delivery_is_of_an_approved_version();

-- ---------------------------------------------------------------------------
-- Case closure (PRD 5.9), in casework because it is a fact about the case.
-- ---------------------------------------------------------------------------
create table if not exists casework.case_closures (
  id      uuid primary key default gen_random_uuid(),
  case_id uuid not null unique references casework.cases (id) on delete cascade,

  -- The answers to the nine requirements `assessClosureReadiness` checks.
  -- Three of them (tasks, report, delivery) are computed rather than
  -- attested, so they are not columns here: a checklist that lets somebody
  -- tick "report approved" when none is would be worse than no checklist.
  objectives_outcome text not null check (btrim(objectives_outcome) <> ''),
  evidence_disposition text not null check (btrim(evidence_disposition) <> ''),
  outstanding_issues text,
  financial_status   text not null check (btrim(financial_status) <> ''),

  retention_class text not null references config.retention_classes (code),

  -- Lessons learned (PRD 5.9), which is a knowledge-base contribution rather
  -- than a form to be got through: every field is its own question.
  what_worked        text,
  what_did_not_work  text,
  challenges         text,
  new_sources        text,
  new_typologies     text,
  methodological_lessons text,
  recommendations    text,
  contribute_to_knowledge_base boolean not null default false,

  status text not null default 'proposed' check (
    status in ('proposed', 'approved', 'returned')
  ),
  proposed_by uuid not null references iam.users (id),
  proposed_at timestamptz not null default now(),
  approved_by uuid references iam.users (id),
  approved_at timestamptz,
  review_notes text,

  created_at timestamptz not null default now(),
  created_by uuid references iam.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references iam.users (id),
  version    integer not null default 1,

  constraint closures_decision_recorded check (
    status = 'proposed' or (approved_by is not null and approved_at is not null)
  ),
  -- PRD 5.9: the Supervisor approves closure, and never the person who
  -- proposed it.
  constraint closures_not_approved_by_proposer check (
    approved_by is null or approved_by <> proposed_by
  ),
  constraint closures_return_has_a_reason check (
    status <> 'returned'
    or (review_notes is not null and btrim(review_notes) <> '')
  ),
  -- A lessons-learned record offered to the training base with nothing in it
  -- is a tick in a box.
  constraint closures_knowledge_base_has_content check (
    not contribute_to_knowledge_base
    or coalesce(btrim(what_worked), '') <> ''
    or coalesce(btrim(methodological_lessons), '') <> ''
    or coalesce(btrim(recommendations), '') <> ''
  )
);

comment on table casework.case_closures is
  'PRD 5.9 closure and lessons learned. The three computed requirements '
  '(tasks complete, report approved, delivery recorded) are deliberately not '
  'columns: they are read from the records themselves, so nobody can attest '
  'to something the platform can check.';

-- ---------------------------------------------------------------------------
-- updated_at / updated_by.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['reports', 'report_versions', 'report_sections',
                           'qa_reviews', 'qa_review_items', 'deliveries']
  loop
    execute format('drop trigger if exists %I_touch on reporting.%I', t, t);
    execute format(
      'create trigger %I_touch before update on reporting.%I '
      'for each row execute function iam.touch_row()', t, t);
  end loop;

  execute 'drop trigger if exists case_closures_touch on casework.case_closures';
  execute 'create trigger case_closures_touch before update on casework.case_closures '
          'for each row execute function iam.touch_row()';
end
$$;

-- ---------------------------------------------------------------------------
-- Row-level security.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['reports', 'report_versions', 'report_sections',
                           'section_citations', 'report_transitions',
                           'qa_reviews', 'qa_review_items', 'deliveries']
  loop
    execute format('alter table reporting.%I enable row level security', t);
    execute format('alter table reporting.%I force  row level security', t);
  end loop;
end
$$;

alter table casework.case_closures enable row level security;
alter table casework.case_closures force  row level security;
alter table config.retention_classes enable row level security;
alter table config.retention_classes force  row level security;
alter table config.qa_checklist_items enable row level security;
alter table config.qa_checklist_items force  row level security;

-- The two config lookups are readable by anybody signed in and writable by
-- whoever may configure the system, exactly as the other config tables are.
drop policy if exists retention_classes_select on config.retention_classes;
create policy retention_classes_select on config.retention_classes
  for select to iims_app using (true);

drop policy if exists retention_classes_write on config.retention_classes;
create policy retention_classes_write on config.retention_classes
  for all to iims_app
  using (iam.has_permission('settings', 'configure', null))
  with check (iam.has_permission('settings', 'configure', null));

drop policy if exists qa_checklist_items_select on config.qa_checklist_items;
create policy qa_checklist_items_select on config.qa_checklist_items
  for select to iims_app using (true);

drop policy if exists qa_checklist_items_write on config.qa_checklist_items;
create policy qa_checklist_items_write on config.qa_checklist_items
  for all to iims_app
  using (iam.has_permission('settings', 'configure', null))
  with check (iam.has_permission('settings', 'configure', null));

-- Reports follow their case and their own classification, the composition the
-- rest of the platform uses.
drop policy if exists reports_select on reporting.reports;
create policy reports_select on reporting.reports
  for select to iims_app
  using (
    deleted_at is null
    and iam.has_permission('reports', 'view', reporting.reports.classification)
    and casework.can_reach_case(reporting.reports.case_id, 'view')
  );

drop policy if exists reports_select_deleted on reporting.reports;
create policy reports_select_deleted on reporting.reports
  for select to iims_app
  using (
    deleted_at is not null
    and iam.has_permission('reports', 'delete', reporting.reports.classification)
  );

drop policy if exists reports_insert on reporting.reports;
create policy reports_insert on reporting.reports
  for insert to iims_app
  with check (
    iam.has_permission('reports', 'create', reporting.reports.classification)
    and casework.can_reach_case(reporting.reports.case_id, 'view')
  );

drop policy if exists reports_update on reporting.reports;
create policy reports_update on reporting.reports
  for update to iims_app
  using (
    casework.can_reach_case(reporting.reports.case_id, 'view')
    and (
      iam.has_permission('reports', 'edit', reporting.reports.classification)
      or iam.has_permission('reports', 'approve', reporting.reports.classification)
    )
  )
  with check (
    casework.can_reach_case(reporting.reports.case_id, 'view')
    and (
      iam.has_permission('reports', 'edit', reporting.reports.classification)
      or iam.has_permission('reports', 'approve', reporting.reports.classification)
    )
  );

-- Versions, sections and citations follow their report.
do $$
declare
  spec record;
begin
  for spec in
    select * from (values
      ('report_versions', 'reporting.report_versions.report_id'),
      ('qa_reviews',      'reporting.qa_reviews.report_id'),
      ('deliveries',      'reporting.deliveries.report_id')
    ) as t(tbl, col)
  loop
    execute format('drop policy if exists %I_select on reporting.%I', spec.tbl, spec.tbl);
    execute format(
      'create policy %I_select on reporting.%I for select to iims_app '
      'using (exists (select 1 from reporting.reports r where r.id = %s))',
      spec.tbl, spec.tbl, spec.col);

    execute format('drop policy if exists %I_write on reporting.%I', spec.tbl, spec.tbl);
    execute format(
      'create policy %I_write on reporting.%I for all to iims_app '
      'using (exists (select 1 from reporting.reports r where r.id = %s '
      '  and (iam.has_permission(''reports'', ''edit'', r.classification) '
      '    or iam.has_permission(''reports'', ''approve'', r.classification) '
      '    or iam.has_permission(''qa'', ''create'', r.classification)))) '
      'with check (exists (select 1 from reporting.reports r where r.id = %s '
      '  and (iam.has_permission(''reports'', ''edit'', r.classification) '
      '    or iam.has_permission(''reports'', ''approve'', r.classification) '
      '    or iam.has_permission(''qa'', ''create'', r.classification))))',
      spec.tbl, spec.tbl, spec.col, spec.col);
  end loop;
end
$$;

drop policy if exists report_sections_select on reporting.report_sections;
create policy report_sections_select on reporting.report_sections
  for select to iims_app
  using (
    exists (
      select 1 from reporting.report_versions v
      where v.id = reporting.report_sections.version_id
    )
  );

drop policy if exists report_sections_write on reporting.report_sections;
create policy report_sections_write on reporting.report_sections
  for all to iims_app
  using (
    exists (
      select 1 from reporting.report_versions v
      join reporting.reports r on r.id = v.report_id
      where v.id = reporting.report_sections.version_id
        and iam.has_permission('reports', 'edit', r.classification)
    )
  )
  with check (
    exists (
      select 1 from reporting.report_versions v
      join reporting.reports r on r.id = v.report_id
      where v.id = reporting.report_sections.version_id
        and iam.has_permission('reports', 'edit', r.classification)
    )
  );

drop policy if exists section_citations_select on reporting.section_citations;
create policy section_citations_select on reporting.section_citations
  for select to iims_app
  using (
    exists (
      select 1 from reporting.report_sections s
      where s.id = reporting.section_citations.section_id
    )
  );

drop policy if exists section_citations_write on reporting.section_citations;
create policy section_citations_write on reporting.section_citations
  for all to iims_app
  using (
    exists (
      select 1 from reporting.report_sections s
      join reporting.report_versions v on v.id = s.version_id
      join reporting.reports r on r.id = v.report_id
      where s.id = reporting.section_citations.section_id
        and iam.has_permission('reports', 'edit', r.classification)
    )
  )
  with check (
    exists (
      select 1 from reporting.report_sections s
      join reporting.report_versions v on v.id = s.version_id
      join reporting.reports r on r.id = v.report_id
      where s.id = reporting.section_citations.section_id
        and iam.has_permission('reports', 'edit', r.classification)
    )
  );

-- The workflow history is readable with its report and written by anybody who
-- may move it. No UPDATE or DELETE policy exists at all, which is the second
-- of the four locks the audit trail taught.
drop policy if exists report_transitions_select on reporting.report_transitions;
create policy report_transitions_select on reporting.report_transitions
  for select to iims_app
  using (
    exists (
      select 1 from reporting.reports r
      where r.id = reporting.report_transitions.report_id
    )
  );

drop policy if exists report_transitions_insert on reporting.report_transitions;
create policy report_transitions_insert on reporting.report_transitions
  for insert to iims_app
  with check (
    exists (
      select 1 from reporting.reports r
      where r.id = reporting.report_transitions.report_id
        and (
          iam.has_permission('reports', 'edit', r.classification)
          or iam.has_permission('reports', 'approve', r.classification)
          or iam.has_permission('qa', 'create', r.classification)
        )
    )
  );

drop policy if exists qa_review_items_select on reporting.qa_review_items;
create policy qa_review_items_select on reporting.qa_review_items
  for select to iims_app
  using (
    exists (
      select 1 from reporting.qa_reviews q
      where q.id = reporting.qa_review_items.review_id
    )
  );

drop policy if exists qa_review_items_write on reporting.qa_review_items;
create policy qa_review_items_write on reporting.qa_review_items
  for all to iims_app
  using (
    exists (
      select 1 from reporting.qa_reviews q
      join reporting.reports r on r.id = q.report_id
      where q.id = reporting.qa_review_items.review_id
        and (
          iam.has_permission('qa', 'create', r.classification)
          or iam.has_permission('reports', 'approve', r.classification)
        )
    )
  )
  with check (
    exists (
      select 1 from reporting.qa_reviews q
      join reporting.reports r on r.id = q.report_id
      where q.id = reporting.qa_review_items.review_id
        and (
          iam.has_permission('qa', 'create', r.classification)
          or iam.has_permission('reports', 'approve', r.classification)
        )
    )
  );

-- Closure follows its case, and deciding it needs the close permission.
drop policy if exists case_closures_select on casework.case_closures;
create policy case_closures_select on casework.case_closures
  for select to iims_app
  using (casework.can_reach_case(casework.case_closures.case_id, 'view'));

drop policy if exists case_closures_write on casework.case_closures;
create policy case_closures_write on casework.case_closures
  for all to iims_app
  using (
    casework.can_reach_case(casework.case_closures.case_id, 'view')
    and (
      iam.has_permission('cases', 'close', null)
      or iam.has_permission('cases', 'edit', null)
    )
  )
  with check (
    casework.can_reach_case(casework.case_closures.case_id, 'view')
    and (
      iam.has_permission('cases', 'close', null)
      or iam.has_permission('cases', 'edit', null)
    )
  );

-- ---------------------------------------------------------------------------
-- Privileges.
--
-- The three join-shaped tables genuinely delete: removing a citation or a
-- section is a deletion, exactly as untagging a document is. The workflow
-- history keeps neither UPDATE nor DELETE.
-- ---------------------------------------------------------------------------
select config.revoke_erasure('reporting');

grant delete on reporting.report_sections  to iims_app;
grant delete on reporting.section_citations to iims_app;
grant delete on reporting.qa_review_items   to iims_app;

revoke update, delete on reporting.report_transitions from iims_app;

-- ---------------------------------------------------------------------------
-- Assertions.
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad text;
begin
  select string_agg(c.relname, ', ')
  into v_bad
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'reporting'
    and c.relkind = 'r'
    and not (c.relrowsecurity and c.relforcerowsecurity);

  if v_bad is not null then
    raise exception 'reporting tables without forced row-level security: %', v_bad;
  end if;

  -- The workflow history must have no policy that could change or remove a
  -- decision, which is what makes it a history rather than a status field.
  select string_agg(policyname || ' (' || cmd || ')', ', ')
  into v_bad
  from pg_catalog.pg_policies
  where schemaname = 'reporting'
    and tablename = 'report_transitions'
    and cmd in ('UPDATE', 'DELETE', 'ALL');

  if v_bad is not null then
    raise exception
      'reporting.report_transitions has a policy that could rewrite a decision: %',
      v_bad;
  end if;
end
$$;
