-- PDDC IIMS 0009 : starter role catalogue, permission atoms and features.
--
-- "The system ships with the starter roles below. Administrators can create
--  more, clone, rename, deactivate or delete roles at any time" (PRD 3.1).
--
-- This seed is the DEFAULT STARTING SET of PRD 16, not a fixed policy. Every
-- row here is editable in the admin dashboard afterwards.
--
-- Idempotent: safe to re-run.

-- ------------------------------------------------------------- helper
create or replace function config.grant_role_permission(
  p_role_key text,
  p_resource text,
  p_action   text,
  p_scope    text default 'assigned',
  p_ceiling  text default 'CONFIDENTIAL'
)
  returns void
  language plpgsql
  set search_path = ''
as $$
declare
  v_role uuid;
  v_perm uuid;
begin
  select id into v_role from iam.roles where key = p_role_key;
  if v_role is null then
    raise exception 'unknown role key: %', p_role_key;
  end if;

  insert into iam.permissions (resource, action, scope, classification_ceiling)
  values (p_resource, p_action, p_scope, p_ceiling)
  on conflict (resource, action, scope, classification_ceiling) do nothing;

  select id into v_perm
  from iam.permissions
  where resource = p_resource
    and action = p_action
    and scope = p_scope
    and classification_ceiling = p_ceiling;

  insert into iam.role_permissions (role_id, permission_id)
  values (v_role, v_perm)
  on conflict do nothing;
end
$$;

-- --------------------------------------------------------------- roles
insert into iam.roles (key, name, description, is_baseline, is_administrator) values
  ('administrator',      'Administrator',                 'Full administration of every user, role, permission, feature, record and system setting.', false, true),
  ('ceo',                'CEO',                           'Executive oversight of operations, risk, quality and performance.', false, false),
  ('coo',                'COO',                           'Day-to-day operational leadership across offices.', false, false),
  ('manager',            'Manager',                       'General line management of a team or department.', false, false),
  ('operations_manager', 'Operations Manager',            'Case assignment, workloads, deadlines and conflict decisions.', false, false),
  ('hr_manager',         'HR Manager',                    'People records, onboarding and offboarding, training, leave. No investigative content.', false, false),
  ('finance',            'Finance',                       'Billing, invoices, payments and case costs. No investigative evidence.', false, false),
  ('supervisor',         'Supervisor',                    'Leads a team''s investigations; approves or returns work.', false, false),
  ('investigator',       'Investigator',                  'Executes investigations on assigned cases.', false, false),
  ('analyst',            'Intelligence Analyst',          'Analyses sources, information and findings.', false, false),
  ('forensics',          'Digital Forensics Specialist',  'Digital evidence handling on authorised cases.', false, false),
  ('qa_reviewer',        'QA / Reviewer',                 'Independent report review. Cannot edit report content.', false, false),
  ('compliance_officer', 'Compliance Officer',            'Conflict, legal hold, retention and policy oversight.', false, false),
  ('legal_counsel',      'Legal Counsel',                 'Legal review of reports and holds.', false, false),
  ('records_custodian',  'Records / Evidence Custodian',  'Custody and storage of evidence.', false, false),
  ('auditor',            'Auditor (read-only)',           'Independent review of the audit trail and records. Read-only.', false, false),
  ('employee',           'Employee',                      'Baseline for all staff: own profile, notifications, notices, own tasks and time entries.', true, false)
on conflict (key) do nothing;

-- ------------------------------------------------------------ features
insert into iam.features (key, name, description) values
  ('module.safety',         'Investigator safety',     'Safety plans, check-in and check-out, incident reports.'),
  ('module.financials',     'Case financials',         'Quoted and approved fees, invoices, payment status.'),
  ('module.time_tracking',  'Time and resources',      'Hours, field days, travel and external costs.'),
  ('module.knowledge_base', 'Knowledge base',          'Lessons learned feeding the PDDC training material.'),
  ('search.global',         'Global search',           'Command-bar search across all permitted records.'),
  ('export.data',           'Data export',             'CSV and PDF export of lists and management reports.'),
  ('report.download',       'Report download',         'Downloading generated report files.'),
  ('upload.bulk',           'Bulk upload',             'Multi-file upload of documents and evidence.'),
  ('ai.assist',             'AI assistance',           'Optional, assistive only, off by default per case.'),
  ('dashboard.widgets',     'Dashboard widgets',       'Role dashboards and their widgets.'),
  ('api.access',            'API access',              'Programmatic access tokens.'),
  ('notifications.email',   'Email notifications',     'Delivery of notifications by email through Resend.')
on conflict (key) do nothing;

-- The Administrator role receives every feature, including any added later.
insert into iam.role_features (role_id, feature_key, enabled)
select r.id, f.key, true
from iam.roles r
cross join iam.features f
where r.key = 'administrator'
on conflict (role_id, feature_key) do nothing;

-- Baseline features every employee needs to use the platform at all.
insert into iam.role_features (role_id, feature_key, enabled)
select r.id, f.key, true
from iam.roles r
cross join iam.features f
where r.key = 'employee'
  and f.key in ('search.global', 'dashboard.widgets', 'notifications.email')
on conflict (role_id, feature_key) do nothing;

-- Investigative roles get the operational modules.
insert into iam.role_features (role_id, feature_key, enabled)
select r.id, f.key, true
from iam.roles r
cross join iam.features f
where r.key in ('operations_manager', 'supervisor', 'investigator', 'analyst', 'forensics')
  and f.key in ('module.safety', 'module.time_tracking', 'search.global',
                'report.download', 'upload.bulk', 'dashboard.widgets',
                'notifications.email')
on conflict (role_id, feature_key) do nothing;

insert into iam.role_features (role_id, feature_key, enabled)
select r.id, f.key, true
from iam.roles r
cross join iam.features f
where r.key = 'finance'
  and f.key in ('module.financials', 'module.time_tracking', 'export.data',
                'dashboard.widgets', 'notifications.email')
on conflict (role_id, feature_key) do nothing;

-- ---------------------------------------------------- permission atoms
--
-- The Administrator wildcard. This single row is what makes PRD 3.5 hold
-- automatically: "any new module, resource or feature added later
-- automatically receives a full Administrator grant". Enumerating resources
-- instead would silently miss every future module.
select config.grant_role_permission('administrator', '*', '*', 'all', 'STRICTLY_RESTRICTED');

-- Everyone: own profile, own notifications, own tasks and time (PRD 3.1).
select config.grant_role_permission('employee', 'profile',       'view',   'own', 'INTERNAL');
select config.grant_role_permission('employee', 'profile',       'edit',   'own', 'INTERNAL');
select config.grant_role_permission('employee', 'notifications', 'view',   'own', 'INTERNAL');
select config.grant_role_permission('employee', 'notifications', 'edit',   'own', 'INTERNAL');
select config.grant_role_permission('employee', 'tasks',         'view',   'own', 'INTERNAL');
select config.grant_role_permission('employee', 'tasks',         'edit',   'own', 'INTERNAL');
select config.grant_role_permission('employee', 'time',          'view',   'own', 'INTERNAL');
select config.grant_role_permission('employee', 'time',          'create', 'own', 'INTERNAL');
select config.grant_role_permission('employee', 'time',          'edit',   'own', 'INTERNAL');
select config.grant_role_permission('employee', 'dashboards',    'view',   'own', 'INTERNAL');

-- The rest of PRD 16, driven from a table so the matrix stays readable.
do $$
declare
  g record;
begin
  for g in
    select * from (values
      -- role                resource        action      scope        ceiling
      -- CEO: executive visibility across everything, no editing.
      ('ceo','cases','view','all','RESTRICTED'),
      ('ceo','clients','view','all','RESTRICTED'),
      ('ceo','engagements','view','all','RESTRICTED'),
      ('ceo','plans','view','all','RESTRICTED'),
      ('ceo','tasks','view','all','RESTRICTED'),
      ('ceo','entities','view','all','RESTRICTED'),
      ('ceo','sources','view','all','RESTRICTED'),
      ('ceo','information','view','all','RESTRICTED'),
      ('ceo','evidence','view','all','RESTRICTED'),
      ('ceo','custody','view','all','RESTRICTED'),
      ('ceo','documents','view','all','RESTRICTED'),
      ('ceo','findings','view','all','RESTRICTED'),
      ('ceo','reports','view','all','RESTRICTED'),
      ('ceo','reports','approve','all','RESTRICTED'),
      ('ceo','financials','view','all','RESTRICTED'),
      ('ceo','time','view','all','RESTRICTED'),
      ('ceo','audit','view','all','RESTRICTED'),
      ('ceo','dashboards','view','all','RESTRICTED'),
      ('ceo','users','view','all','INTERNAL'),

      -- COO: operational leadership.
      ('coo','cases','view','all','RESTRICTED'),
      ('coo','cases','edit','all','RESTRICTED'),
      ('coo','cases','assign','all','RESTRICTED'),
      ('coo','tasks','view','all','CONFIDENTIAL'),
      ('coo','plans','view','all','CONFIDENTIAL'),
      ('coo','plans','approve','all','CONFIDENTIAL'),
      ('coo','reports','view','all','RESTRICTED'),
      ('coo','dashboards','view','all','INTERNAL'),
      ('coo','users','view','all','INTERNAL'),

      -- Manager: own team.
      ('manager','cases','view','team','CONFIDENTIAL'),
      ('manager','tasks','view','team','CONFIDENTIAL'),
      ('manager','tasks','assign','team','CONFIDENTIAL'),
      ('manager','time','view','team','INTERNAL'),
      ('manager','dashboards','view','team','INTERNAL'),
      ('manager','users','view','team','INTERNAL'),

      -- HR Manager: people data only, explicitly no investigative content.
      ('hr_manager','users','view','all','INTERNAL'),
      ('hr_manager','users','create','all','INTERNAL'),
      ('hr_manager','users','edit','all','INTERNAL'),
      ('hr_manager','dashboards','view','all','INTERNAL'),

      -- Operations Manager: runs operations across all cases.
      ('operations_manager','clients','view','all','CONFIDENTIAL'),
      ('operations_manager','clients','create','all','CONFIDENTIAL'),
      ('operations_manager','clients','edit','all','CONFIDENTIAL'),
      ('operations_manager','engagements','view','all','CONFIDENTIAL'),
      ('operations_manager','engagements','create','all','CONFIDENTIAL'),
      ('operations_manager','engagements','edit','all','CONFIDENTIAL'),
      ('operations_manager','engagements','approve','all','CONFIDENTIAL'),
      ('operations_manager','conflicts','view','all','CONFIDENTIAL'),
      ('operations_manager','conflicts','approve','all','CONFIDENTIAL'),
      ('operations_manager','cases','view','all','CONFIDENTIAL'),
      ('operations_manager','cases','create','all','CONFIDENTIAL'),
      ('operations_manager','cases','edit','all','CONFIDENTIAL'),
      ('operations_manager','cases','approve','all','CONFIDENTIAL'),
      ('operations_manager','cases','assign','all','CONFIDENTIAL'),
      ('operations_manager','plans','view','all','CONFIDENTIAL'),
      ('operations_manager','tasks','view','all','CONFIDENTIAL'),
      ('operations_manager','tasks','create','all','CONFIDENTIAL'),
      ('operations_manager','tasks','edit','all','CONFIDENTIAL'),
      ('operations_manager','tasks','assign','all','CONFIDENTIAL'),
      ('operations_manager','entities','view','all','CONFIDENTIAL'),
      ('operations_manager','sources','view','all','CONFIDENTIAL'),
      ('operations_manager','information','view','all','CONFIDENTIAL'),
      ('operations_manager','evidence','view','all','CONFIDENTIAL'),
      ('operations_manager','custody','view','all','CONFIDENTIAL'),
      ('operations_manager','documents','view','all','CONFIDENTIAL'),
      ('operations_manager','findings','view','all','CONFIDENTIAL'),
      ('operations_manager','reports','view','all','CONFIDENTIAL'),
      ('operations_manager','financials','view','all','CONFIDENTIAL'),
      ('operations_manager','financials','create','all','CONFIDENTIAL'),
      ('operations_manager','financials','edit','all','CONFIDENTIAL'),
      ('operations_manager','time','view','all','INTERNAL'),
      ('operations_manager','dashboards','view','all','INTERNAL'),
      ('operations_manager','users','view','all','INTERNAL'),

      -- Supervisor: leads a team's cases, approves or returns work.
      ('supervisor','clients','view','team','CONFIDENTIAL'),
      ('supervisor','engagements','view','team','CONFIDENTIAL'),
      ('supervisor','conflicts','view','team','CONFIDENTIAL'),
      ('supervisor','cases','view','team','RESTRICTED'),
      ('supervisor','cases','edit','team','RESTRICTED'),
      ('supervisor','cases','approve','team','RESTRICTED'),
      ('supervisor','plans','view','team','RESTRICTED'),
      ('supervisor','plans','approve','team','RESTRICTED'),
      ('supervisor','tasks','view','team','RESTRICTED'),
      ('supervisor','tasks','create','team','RESTRICTED'),
      ('supervisor','tasks','edit','team','RESTRICTED'),
      ('supervisor','tasks','assign','team','RESTRICTED'),
      ('supervisor','entities','view','team','RESTRICTED'),
      ('supervisor','entities','create','team','RESTRICTED'),
      ('supervisor','entities','edit','team','RESTRICTED'),
      ('supervisor','sources','view','team','RESTRICTED'),
      ('supervisor','sources','create','team','RESTRICTED'),
      ('supervisor','sources','edit','team','RESTRICTED'),
      ('supervisor','information','view','team','RESTRICTED'),
      ('supervisor','information','create','team','RESTRICTED'),
      ('supervisor','information','edit','team','RESTRICTED'),
      ('supervisor','evidence','view','team','RESTRICTED'),
      ('supervisor','evidence','upload','team','RESTRICTED'),
      ('supervisor','evidence','download','team','RESTRICTED'),
      ('supervisor','custody','view','team','RESTRICTED'),
      ('supervisor','custody','create','team','RESTRICTED'),
      ('supervisor','documents','view','team','RESTRICTED'),
      ('supervisor','documents','create','team','RESTRICTED'),
      ('supervisor','documents','edit','team','RESTRICTED'),
      ('supervisor','documents','upload','team','RESTRICTED'),
      ('supervisor','documents','download','team','RESTRICTED'),
      ('supervisor','findings','view','team','RESTRICTED'),
      ('supervisor','findings','approve','team','RESTRICTED'),
      ('supervisor','reports','view','team','RESTRICTED'),
      ('supervisor','reports','approve','team','RESTRICTED'),
      ('supervisor','financials','view','team','INTERNAL'),
      ('supervisor','time','view','team','INTERNAL'),
      ('supervisor','audit','view','team','RESTRICTED'),
      ('supervisor','dashboards','view','team','INTERNAL'),

      -- Investigator: assigned cases only.
      ('investigator','clients','view','assigned','CONFIDENTIAL'),
      ('investigator','engagements','view','assigned','CONFIDENTIAL'),
      ('investigator','cases','view','assigned','CONFIDENTIAL'),
      ('investigator','cases','edit','assigned','CONFIDENTIAL'),
      ('investigator','plans','view','assigned','CONFIDENTIAL'),
      ('investigator','plans','create','assigned','CONFIDENTIAL'),
      ('investigator','plans','edit','assigned','CONFIDENTIAL'),
      ('investigator','tasks','view','assigned','CONFIDENTIAL'),
      ('investigator','tasks','create','assigned','CONFIDENTIAL'),
      ('investigator','tasks','edit','assigned','CONFIDENTIAL'),
      ('investigator','entities','view','assigned','CONFIDENTIAL'),
      ('investigator','entities','create','assigned','CONFIDENTIAL'),
      ('investigator','entities','edit','assigned','CONFIDENTIAL'),
      ('investigator','sources','view','assigned','CONFIDENTIAL'),
      ('investigator','sources','create','assigned','CONFIDENTIAL'),
      ('investigator','sources','edit','assigned','CONFIDENTIAL'),
      ('investigator','information','view','assigned','CONFIDENTIAL'),
      ('investigator','information','create','assigned','CONFIDENTIAL'),
      ('investigator','information','edit','assigned','CONFIDENTIAL'),
      ('investigator','evidence','view','assigned','CONFIDENTIAL'),
      ('investigator','evidence','create','assigned','CONFIDENTIAL'),
      ('investigator','evidence','upload','assigned','CONFIDENTIAL'),
      ('investigator','evidence','download','assigned','CONFIDENTIAL'),
      ('investigator','custody','view','assigned','CONFIDENTIAL'),
      ('investigator','custody','create','assigned','CONFIDENTIAL'),
      ('investigator','documents','view','assigned','CONFIDENTIAL'),
      ('investigator','documents','create','assigned','CONFIDENTIAL'),
      ('investigator','documents','edit','assigned','CONFIDENTIAL'),
      ('investigator','documents','upload','assigned','CONFIDENTIAL'),
      ('investigator','documents','download','assigned','CONFIDENTIAL'),
      ('investigator','findings','view','assigned','CONFIDENTIAL'),
      ('investigator','findings','create','assigned','CONFIDENTIAL'),
      ('investigator','findings','edit','assigned','CONFIDENTIAL'),
      ('investigator','reports','view','assigned','CONFIDENTIAL'),
      ('investigator','reports','create','assigned','CONFIDENTIAL'),
      ('investigator','reports','edit','assigned','CONFIDENTIAL'),
      ('investigator','dashboards','view','own','INTERNAL'),

      -- Intelligence Analyst: analysis, no client financials.
      ('analyst','cases','view','assigned','CONFIDENTIAL'),
      ('analyst','plans','view','assigned','CONFIDENTIAL'),
      ('analyst','tasks','view','assigned','CONFIDENTIAL'),
      ('analyst','tasks','create','assigned','CONFIDENTIAL'),
      ('analyst','tasks','edit','assigned','CONFIDENTIAL'),
      ('analyst','entities','view','assigned','CONFIDENTIAL'),
      ('analyst','entities','create','assigned','CONFIDENTIAL'),
      ('analyst','entities','edit','assigned','CONFIDENTIAL'),
      ('analyst','sources','view','assigned','CONFIDENTIAL'),
      ('analyst','sources','create','assigned','CONFIDENTIAL'),
      ('analyst','sources','edit','assigned','CONFIDENTIAL'),
      ('analyst','information','view','assigned','CONFIDENTIAL'),
      ('analyst','information','create','assigned','CONFIDENTIAL'),
      ('analyst','information','edit','assigned','CONFIDENTIAL'),
      ('analyst','evidence','view','assigned','CONFIDENTIAL'),
      ('analyst','evidence','download','assigned','CONFIDENTIAL'),
      ('analyst','custody','view','assigned','CONFIDENTIAL'),
      ('analyst','custody','create','assigned','CONFIDENTIAL'),
      ('analyst','documents','view','assigned','CONFIDENTIAL'),
      ('analyst','documents','create','assigned','CONFIDENTIAL'),
      ('analyst','documents','upload','assigned','CONFIDENTIAL'),
      ('analyst','documents','download','assigned','CONFIDENTIAL'),
      ('analyst','findings','view','assigned','CONFIDENTIAL'),
      ('analyst','findings','create','assigned','CONFIDENTIAL'),
      ('analyst','findings','edit','assigned','CONFIDENTIAL'),
      ('analyst','reports','view','assigned','CONFIDENTIAL'),
      ('analyst','reports','create','assigned','CONFIDENTIAL'),
      ('analyst','reports','edit','assigned','CONFIDENTIAL'),
      ('analyst','dashboards','view','own','INTERNAL'),

      -- Digital Forensics Specialist: digital evidence on authorised cases.
      ('forensics','cases','view','assigned','RESTRICTED'),
      ('forensics','tasks','view','assigned','RESTRICTED'),
      ('forensics','tasks','create','assigned','RESTRICTED'),
      ('forensics','tasks','edit','assigned','RESTRICTED'),
      ('forensics','entities','view','assigned','RESTRICTED'),
      ('forensics','sources','view','assigned','RESTRICTED'),
      ('forensics','information','view','assigned','RESTRICTED'),
      ('forensics','evidence','view','assigned','RESTRICTED'),
      ('forensics','evidence','create','assigned','RESTRICTED'),
      ('forensics','evidence','edit','assigned','RESTRICTED'),
      ('forensics','evidence','upload','assigned','RESTRICTED'),
      ('forensics','evidence','download','assigned','RESTRICTED'),
      ('forensics','custody','view','assigned','RESTRICTED'),
      ('forensics','custody','create','assigned','RESTRICTED'),
      ('forensics','documents','view','assigned','RESTRICTED'),
      ('forensics','documents','create','assigned','RESTRICTED'),
      ('forensics','documents','upload','assigned','RESTRICTED'),
      ('forensics','documents','download','assigned','RESTRICTED'),
      ('forensics','findings','view','assigned','RESTRICTED'),
      ('forensics','findings','create','assigned','RESTRICTED'),
      ('forensics','findings','edit','assigned','RESTRICTED'),
      ('forensics','reports','view','assigned','RESTRICTED'),
      ('forensics','reports','create','assigned','RESTRICTED'),
      ('forensics','reports','edit','assigned','RESTRICTED'),
      ('forensics','dashboards','view','own','INTERNAL'),

      -- QA / Reviewer: reviews, never edits report content.
      ('qa_reviewer','cases','view','assigned','CONFIDENTIAL'),
      ('qa_reviewer','plans','view','assigned','CONFIDENTIAL'),
      ('qa_reviewer','tasks','view','assigned','CONFIDENTIAL'),
      ('qa_reviewer','entities','view','assigned','CONFIDENTIAL'),
      ('qa_reviewer','sources','view','assigned','CONFIDENTIAL'),
      ('qa_reviewer','information','view','assigned','CONFIDENTIAL'),
      ('qa_reviewer','evidence','view','assigned','CONFIDENTIAL'),
      ('qa_reviewer','evidence','download','assigned','CONFIDENTIAL'),
      ('qa_reviewer','custody','view','assigned','CONFIDENTIAL'),
      ('qa_reviewer','documents','view','assigned','CONFIDENTIAL'),
      ('qa_reviewer','documents','download','assigned','CONFIDENTIAL'),
      ('qa_reviewer','findings','view','assigned','CONFIDENTIAL'),
      ('qa_reviewer','reports','view','assigned','CONFIDENTIAL'),
      ('qa_reviewer','reports','approve','assigned','CONFIDENTIAL'),
      ('qa_reviewer','qa','view','assigned','CONFIDENTIAL'),
      ('qa_reviewer','qa','create','assigned','CONFIDENTIAL'),
      ('qa_reviewer','qa','edit','assigned','CONFIDENTIAL'),
      ('qa_reviewer','dashboards','view','own','INTERNAL'),

      -- Finance: billing only, no investigative content by default.
      ('finance','clients','view','all','INTERNAL'),
      ('finance','engagements','view','all','INTERNAL'),
      ('finance','cases','view','all','INTERNAL'),
      ('finance','financials','view','all','INTERNAL'),
      ('finance','financials','create','all','INTERNAL'),
      ('finance','financials','edit','all','INTERNAL'),
      ('finance','financials','export','all','INTERNAL'),
      ('finance','time','view','all','INTERNAL'),
      ('finance','dashboards','view','all','INTERNAL'),

      -- Compliance Officer: read access plus compliance actions.
      ('compliance_officer','cases','view','all','RESTRICTED'),
      ('compliance_officer','conflicts','view','all','RESTRICTED'),
      ('compliance_officer','conflicts','approve','all','RESTRICTED'),
      ('compliance_officer','evidence','view','all','RESTRICTED'),
      ('compliance_officer','custody','view','all','RESTRICTED'),
      ('compliance_officer','documents','view','all','RESTRICTED'),
      ('compliance_officer','reports','view','all','RESTRICTED'),
      ('compliance_officer','audit','view','all','RESTRICTED'),
      ('compliance_officer','settings','view','all','RESTRICTED'),
      ('compliance_officer','dashboards','view','all','INTERNAL'),

      -- Legal Counsel: assigned matters.
      ('legal_counsel','cases','view','assigned','RESTRICTED'),
      ('legal_counsel','evidence','view','assigned','RESTRICTED'),
      ('legal_counsel','documents','view','assigned','RESTRICTED'),
      ('legal_counsel','findings','view','assigned','RESTRICTED'),
      ('legal_counsel','reports','view','assigned','RESTRICTED'),
      ('legal_counsel','reports','approve','assigned','RESTRICTED'),
      ('legal_counsel','dashboards','view','own','INTERNAL'),

      -- Records / Evidence Custodian: the evidence register.
      ('records_custodian','cases','view','all','CONFIDENTIAL'),
      ('records_custodian','evidence','view','all','RESTRICTED'),
      ('records_custodian','evidence','edit','all','RESTRICTED'),
      ('records_custodian','custody','view','all','RESTRICTED'),
      ('records_custodian','custody','create','all','RESTRICTED'),
      ('records_custodian','documents','view','all','CONFIDENTIAL'),
      ('records_custodian','dashboards','view','own','INTERNAL'),

      -- Auditor: read-only review of the trail and records.
      ('auditor','cases','view','all','RESTRICTED'),
      ('auditor','evidence','view','all','RESTRICTED'),
      ('auditor','custody','view','all','RESTRICTED'),
      ('auditor','documents','view','all','RESTRICTED'),
      ('auditor','findings','view','all','RESTRICTED'),
      ('auditor','reports','view','all','RESTRICTED'),
      ('auditor','audit','view','all','RESTRICTED'),
      ('auditor','users','view','all','INTERNAL'),
      ('auditor','settings','view','all','INTERNAL'),
      ('auditor','dashboards','view','all','INTERNAL')
    ) as t(role_key, resource, action, scope, ceiling)
  loop
    perform config.grant_role_permission(g.role_key, g.resource, g.action, g.scope, g.ceiling);
  end loop;
end
$$;

-- --------------------------------------- separation of duties defaults
-- "the administrator can define incompatible role pairs, for example a user
--  cannot hold both Finance and Administrator" (PRD 3.2).
insert into iam.role_incompatibilities (role_a_id, role_b_id, reason)
select a.id, b.id,
       'Finance must not also administer the system: it would allow a single person to both record and authorise payments.'
from iam.roles a, iam.roles b
where a.key = 'finance' and b.key = 'administrator'
on conflict do nothing;

insert into iam.role_incompatibilities (role_a_id, role_b_id, reason)
select a.id, b.id,
       'An auditor reviewing the trail must not also hold administrative write access to what they review.'
from iam.roles a, iam.roles b
where a.key = 'auditor' and b.key = 'administrator'
on conflict do nothing;

-- ---------------------------------------------------- jurisdictions seed
-- Starting set only; administrators manage these in the admin dashboard.
insert into iam.countries (code, name) values
  ('GH', 'Ghana'),
  ('RW', 'Rwanda')
on conflict (code) do nothing;

insert into iam.departments (code, name) values
  ('INV', 'Investigations'),
  ('INT', 'Intelligence'),
  ('FOR', 'Digital Forensics'),
  ('QA',  'Quality Assurance'),
  ('OPS', 'Operations'),
  ('FIN', 'Finance'),
  ('HR',  'Human Resources'),
  ('LEG', 'Legal and Compliance')
on conflict (code) do nothing;
