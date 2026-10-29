-- PDDC IIMS 0005: identity: organisation units and IIMS user records.
--
-- SHARED IDENTITY WITH primaddc.com
-- There is one auth.users row per person and one public.profiles row holding
-- their name, email and photo. Both are owned by the website; the IIMS reads
-- them and never writes them.
--
-- iam.users is the IIMS-side extension of that person: employee number, office,
-- clearance, status, lockout state. Its existence is what grants IIMS access at
-- all: a primaddc.com account alone grants nothing (PRD §3.2), so an
-- administrator must provision this row before anyone sees case content.

-- ---------------------------------------------------------------- reference
create table if not exists iam.countries (
  code        char(2)     primary key,          -- ISO 3166-1 alpha-2
  name        text        not null,
  -- Data-residency rules are per-jurisdiction (PRD §14 "Data separation").
  residency_note text,
  is_active   boolean     not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists iam.offices (
  id           uuid primary key default extensions.gen_random_uuid(),
  code         text not null unique,
  name         text not null,
  country_code char(2) not null references iam.countries (code),
  timezone     text not null default 'UTC',
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);

create table if not exists iam.departments (
  id         uuid primary key default extensions.gen_random_uuid(),
  code       text not null unique,
  name       text not null,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

-- Classification levels are configuration, not code (PRD §21.1), so PDDC can
-- rename them. `rank` is what comparisons use.
create table if not exists iam.classification_levels (
  code        text primary key,
  name        text not null,
  rank        int  not null unique,
  description text,
  is_active   boolean not null default true
);

insert into iam.classification_levels (code, name, rank, description) values
  ('PUBLIC',             'Public',             1, 'No restriction.'),
  ('INTERNAL',           'Internal',           2, 'PDDC staff generally.'),
  ('CONFIDENTIAL',       'Confidential',       3, 'Case team and above.'),
  ('RESTRICTED',         'Restricted',         4, 'Named case team only.'),
  ('STRICTLY_RESTRICTED','Strictly Restricted',5, 'Named-user grant required; human-source identities.')
on conflict (code) do nothing;

-- ------------------------------------------------------------------- users
create table if not exists iam.users (
  -- Same id as the shared identity. ON DELETE CASCADE because an auth.users
  -- row going away means the person no longer exists in either system; the
  -- audit trail keeps their name regardless (PRD §3.3 "Remove").
  id                  uuid primary key references auth.users (id) on delete cascade,

  employee_id         text unique,
  work_phone          text,
  job_title           text,

  office_id           uuid references iam.offices (id),
  department_id       uuid references iam.departments (id),
  country_code        char(2) references iam.countries (code),

  -- Clearance is assigned per user and is NOT conferred by a role alone
  -- (PRD §3.2). The Administrator role is the single exception, handled in
  -- iam.has_clearance().
  clearance           text not null default 'INTERNAL'
                        references iam.classification_levels (code),

  -- Invited -> Active -> Suspended -> Deactivated -> Archived (PRD §3.3).
  status              text not null default 'invited'
                        check (status in ('invited','active','suspended','deactivated','archived')),

  -- Bumped whenever this user's permissions change, so a permission change
  -- takes effect WITHOUT re-login (PRD §3.4): each request compares the
  -- version it cached against this value.
  permissions_version bigint not null default 1,

  -- Per-account lockout. Supabase Auth rate-limits per IP, not per account,
  -- and has no lockout at all, so PRD §14 requires we implement it (see
  -- iam.register_login_attempt()).
  failed_login_count  int not null default 0,
  locked_until        timestamptz,

  -- Configurable session timeout (PRD §3.3). Supabase's own session
  -- time-boxing is a Pro feature, so this is enforced by our liveness check.
  session_timeout_minutes int not null default 480,

  mfa_enrolled_at     timestamptz,
  last_seen_at        timestamptz,

  notes               text,

  created_at          timestamptz not null default now(),
  created_by          uuid,
  updated_at          timestamptz not null default now(),
  updated_by          uuid,
  version             int not null default 1,          -- optimistic locking (§21.7)
  deleted_at          timestamptz                      -- recoverable soft delete (§3.5)
);

create index if not exists users_status_idx     on iam.users (status) where deleted_at is null;
create index if not exists users_office_idx     on iam.users (office_id);
create index if not exists users_department_idx on iam.users (department_id);
create index if not exists users_country_idx    on iam.users (country_code);

comment on table iam.users is
  'IIMS-side user record. Its presence is what grants access to the platform; '
  'a primaddc.com website account alone grants nothing.';

-- --------------------------------------------------------------- lockout
-- Every attempt is recorded so lockout can be per account, and so brute-force
-- patterns are visible in the audit trail.
create table if not exists iam.login_attempts (
  id           uuid primary key default extensions.gen_random_uuid(),
  email        extensions.citext not null,
  user_id      uuid references iam.users (id) on delete set null,
  succeeded    boolean not null,
  failure_kind text,            -- bad_password | locked | no_iims_access | mfa_failed
  ip           inet,
  user_agent   text,
  attempted_at timestamptz not null default now()
);

create index if not exists login_attempts_email_idx
  on iam.login_attempts (email, attempted_at desc);
create index if not exists login_attempts_user_idx
  on iam.login_attempts (user_id, attempted_at desc);

-- ------------------------------------------------------------ invitations
create table if not exists iam.user_invitations (
  id           uuid primary key default extensions.gen_random_uuid(),
  email        extensions.citext not null,
  invited_by   uuid references iam.users (id),
  -- Roles and clearance to apply once the invitee completes enrolment.
  intended_roles  uuid[] not null default '{}',
  intended_clearance text not null default 'INTERNAL'
                       references iam.classification_levels (code),
  office_id    uuid references iam.offices (id),
  department_id uuid references iam.departments (id),
  status       text not null default 'pending'
                 check (status in ('pending','accepted','revoked','expired')),
  sent_at      timestamptz not null default now(),
  accepted_at  timestamptz,
  expires_at   timestamptz not null default now() + interval '14 days',
  created_at   timestamptz not null default now()
);

create index if not exists user_invitations_email_idx on iam.user_invitations (email);
create index if not exists user_invitations_status_idx on iam.user_invitations (status);

-- ---------------------------------------------------------------- touch
-- updated_at and the optimistic-locking version are maintained by the
-- database, so no repository can forget them.
create or replace function iam.touch_row()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  new.updated_at := now();
  new.version    := coalesce(old.version, 0) + 1;
  new.updated_by := coalesce(
    nullif(current_setting('iims.user_id', true), '')::uuid,
    new.updated_by
  );
  return new;
end
$$;

drop trigger if exists users_touch on iam.users;
create trigger users_touch
  before update on iam.users
  for each row execute function iam.touch_row();

-- ------------------------------------------------------------------- RLS
-- Enabled AND forced on every table: postgres owns these tables and a table
-- owner bypasses its own policies without FORCE. Policies arrive in 0007,
-- once the permission functions they depend on exist. Until then these tables
-- are default-deny for iims_app, which is the safe direction.
alter table iam.countries              enable row level security;
alter table iam.countries              force  row level security;
alter table iam.offices                enable row level security;
alter table iam.offices                force  row level security;
alter table iam.departments            enable row level security;
alter table iam.departments            force  row level security;
alter table iam.classification_levels  enable row level security;
alter table iam.classification_levels  force  row level security;
alter table iam.users                  enable row level security;
alter table iam.users                  force  row level security;
alter table iam.login_attempts         enable row level security;
alter table iam.login_attempts         force  row level security;
alter table iam.user_invitations        enable row level security;
alter table iam.user_invitations        force  row level security;
