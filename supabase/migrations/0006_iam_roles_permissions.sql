-- PDDC IIMS 0006: roles, permissions, features and the governance tables.
--
-- "Roles and permissions are DATA, not code: an administrator can add, edit
--  and remove them without a software release" (PRD §3).
--
-- A permission is built from four parts chosen in the interface (PRD §3.3):
--   resource x action x scope x classification ceiling
--
-- The Administrator role is expressed as a wildcard grant ('*','*') rather
-- than by enumerating resources. That is what makes PRD §3.5's promise hold
-- automatically: "any new module, resource or feature added later
-- automatically receives a full Administrator grant."

-- ------------------------------------------------------------------- roles
create table if not exists iam.roles (
  id          uuid primary key default extensions.gen_random_uuid(),
  key         text not null unique,          -- stable machine key, e.g. 'supervisor'
  name        text not null,
  description text,

  -- Employee is the baseline role every user holds and cannot be removed
  -- (PRD §3.1).
  is_baseline boolean not null default false,
  -- Carries every clearance and the wildcard grant (PRD §3.2, §3.5).
  is_administrator boolean not null default false,

  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  created_by  uuid references iam.users (id),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references iam.users (id),
  version     int not null default 1,
  deleted_at  timestamptz
);

-- Role definitions are versioned with reason, author and a before/after
-- comparison, and can be rolled back (PRD §3.3).
create table if not exists iam.role_versions (
  id          uuid primary key default extensions.gen_random_uuid(),
  role_id     uuid not null references iam.roles (id) on delete cascade,
  version     int  not null,
  reason      text not null,
  before_value jsonb,
  after_value  jsonb not null,
  changed_by  uuid references iam.users (id),
  changed_at  timestamptz not null default now(),
  unique (role_id, version)
);

-- ------------------------------------------------------------- permissions
-- The grantable atoms. '*' is a wildcard in resource and action.
create table if not exists iam.permissions (
  id                   uuid primary key default extensions.gen_random_uuid(),
  resource             text not null,
  action               text not null
                         check (action in ('*','view','create','edit','upload','download',
                                           'share','approve','delete','export','assign','configure')),
  scope                text not null default 'assigned'
                         check (scope in ('own','assigned','team','department','office','country','all')),
  classification_ceiling text not null default 'INTERNAL'
                         references iam.classification_levels (code),
  description          text,
  created_at           timestamptz not null default now(),
  unique (resource, action, scope, classification_ceiling)
);

create index if not exists permissions_lookup_idx on iam.permissions (resource, action);

create table if not exists iam.role_permissions (
  role_id       uuid not null references iam.roles (id) on delete cascade,
  permission_id uuid not null references iam.permissions (id) on delete cascade,
  granted_at    timestamptz not null default now(),
  granted_by    uuid references iam.users (id),
  primary key (role_id, permission_id)
);

-- --------------------------------------------------------------- features
-- Switching modules and capabilities on or off per role and per user
-- (PRD §3.3 "Feature and module access").
create table if not exists iam.features (
  key         text primary key,            -- e.g. 'module.safety', 'ai.assist'
  name        text not null,
  description text,
  is_active   boolean not null default true
);

create table if not exists iam.role_features (
  role_id     uuid not null references iam.roles (id) on delete cascade,
  feature_key text not null references iam.features (key) on delete cascade,
  enabled     boolean not null default true,
  primary key (role_id, feature_key)
);

create table if not exists iam.user_features (
  user_id     uuid not null references iam.users (id) on delete cascade,
  feature_key text not null references iam.features (key) on delete cascade,
  enabled     boolean not null,
  reason      text not null,
  expires_at  timestamptz,
  granted_by  uuid references iam.users (id),
  granted_at  timestamptz not null default now(),
  primary key (user_id, feature_key)
);

-- ------------------------------------------------------------- user roles
-- "A user can hold any number of roles at once", each scopeable to an office,
-- country, department, team or specific cases, and each able to carry start
-- and end dates for temporary cover (PRD §3.2).
create table if not exists iam.user_roles (
  id         uuid primary key default extensions.gen_random_uuid(),
  user_id    uuid not null references iam.users (id) on delete cascade,
  role_id    uuid not null references iam.roles (id) on delete cascade,

  scope_type text not null default 'all'
               check (scope_type in ('all','office','country','department','team','case')),
  scope_id   text,                       -- office/department uuid, country code, or case id

  is_primary boolean not null default false,   -- shown in the interface (§3.2)

  valid_from timestamptz not null default now(),
  valid_to   timestamptz,

  assigned_by uuid references iam.users (id),
  assigned_at timestamptz not null default now(),
  reason      text,

  -- A role may be held once per scope, not twice.
  unique (user_id, role_id, scope_type, scope_id)
);

create index if not exists user_roles_user_idx on iam.user_roles (user_id);
create index if not exists user_roles_role_idx on iam.user_roles (role_id);
create index if not exists user_roles_valid_idx on iam.user_roles (user_id, valid_from, valid_to);

-- Exactly one primary role per user, enforced rather than hoped for.
create unique index if not exists user_roles_one_primary_idx
  on iam.user_roles (user_id) where is_primary;

-- ----------------------------------------------------- per-user overrides
-- "A user-specific override can grant or deny any permission or feature for
--  one user, with a mandatory reason and an optional expiry" (PRD §3.3), and
-- "an explicit deny always overrides an allow" (PRD §3.2).
create table if not exists iam.user_permission_overrides (
  id            uuid primary key default extensions.gen_random_uuid(),
  user_id       uuid not null references iam.users (id) on delete cascade,
  permission_id uuid not null references iam.permissions (id) on delete cascade,
  effect        text not null check (effect in ('allow','deny')),
  reason        text not null,                        -- mandatory, by design
  expires_at    timestamptz,
  granted_by    uuid references iam.users (id),
  granted_at    timestamptz not null default now(),
  unique (user_id, permission_id, effect)
);

create index if not exists overrides_user_idx on iam.user_permission_overrides (user_id);

-- ------------------------------------------------ separation of duties
-- Configurable incompatible role pairs, e.g. Finance + Administrator
-- (PRD §3.2). The other separation rule: "cannot approve work you authored"
--: is per-record and lives in the domain layer, since it depends on the
-- record, not on the role pair.
create table if not exists iam.role_incompatibilities (
  role_a_id uuid not null references iam.roles (id) on delete cascade,
  role_b_id uuid not null references iam.roles (id) on delete cascade,
  reason    text not null,
  created_at timestamptz not null default now(),
  primary key (role_a_id, role_b_id),
  constraint role_incompatibility_distinct check (role_a_id <> role_b_id)
);

-- ------------------------------------------------------- two-person rule
-- High-risk changes need a second administrator's approval (PRD §3.4), and
-- "an administrator cannot raise their own privileges without second
-- approval".
create table if not exists iam.access_change_requests (
  id            uuid primary key default extensions.gen_random_uuid(),
  kind          text not null
                  check (kind in ('grant_administrator','grant_strictly_restricted',
                                  'grant_delete','grant_export_all','change_audit_settings',
                                  'change_retention','purge_record','remove_administrator')),
  target_user_id uuid references iam.users (id) on delete cascade,
  target_record  text,                      -- for purge_record
  payload        jsonb not null default '{}'::jsonb,
  reason         text not null,

  requested_by   uuid not null references iam.users (id),
  requested_at   timestamptz not null default now(),

  status         text not null default 'pending'
                   check (status in ('pending','approved','rejected','applied','expired')),
  decided_by     uuid references iam.users (id),
  decided_at     timestamptz,
  decision_note  text,
  applied_at     timestamptz,

  expires_at     timestamptz not null default now() + interval '7 days',

  -- The requester can never be the approver. This is the whole point of the
  -- rule, so it is a database constraint, not a service-layer check.
  constraint two_person_distinct
    check (decided_by is null or decided_by <> requested_by)
);

create index if not exists access_requests_status_idx
  on iam.access_change_requests (status, requested_at desc);

-- --------------------------------------------------------------- touch
drop trigger if exists roles_touch on iam.roles;
create trigger roles_touch
  before update on iam.roles
  for each row execute function iam.touch_row();

-- ------------------------------------------------------------------- RLS
alter table iam.roles                     enable row level security;
alter table iam.roles                     force  row level security;
alter table iam.role_versions             enable row level security;
alter table iam.role_versions             force  row level security;
alter table iam.permissions               enable row level security;
alter table iam.permissions               force  row level security;
alter table iam.role_permissions          enable row level security;
alter table iam.role_permissions          force  row level security;
alter table iam.features                  enable row level security;
alter table iam.features                  force  row level security;
alter table iam.role_features             enable row level security;
alter table iam.role_features             force  row level security;
alter table iam.user_features              enable row level security;
alter table iam.user_features              force  row level security;
alter table iam.user_roles                enable row level security;
alter table iam.user_roles                force  row level security;
alter table iam.user_permission_overrides enable row level security;
alter table iam.user_permission_overrides force  row level security;
alter table iam.role_incompatibilities    enable row level security;
alter table iam.role_incompatibilities    force  row level security;
alter table iam.access_change_requests    enable row level security;
alter table iam.access_change_requests    force  row level security;
