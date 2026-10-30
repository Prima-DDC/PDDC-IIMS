-- ---------------------------------------------------------------------------
-- 0059: the AI gateway (PRD 22).
--
-- PRD 22's Amendment 12 says AI is not a core dependency of V1, and this
-- migration is written to make that literally true: the provider allow-list
-- ships EMPTY, every case has AI off, and with no provider enabled the
-- gateway refuses every request with a reason a person can read. Nothing else
-- in the platform changes behaviour. Turning it on is an administrator's
-- deliberate act, twice over: once to enter a provider whose data-retention
-- terms they have recorded, and once per case.
--
-- WHY ALL OF THIS LIVES IN `config`. The ten schemas were fixed in 0001, and
-- `config` is the one commented "workflows, retention, legal holds, settings,
-- AI". An eleventh schema for a subsystem that is off by default would have
-- been a worse trade than a prefix.
--
-- THE FOUR THINGS THAT MAKE CLOUD AI DEFENSIBLE HERE, and they are all in the
-- database rather than in a prompt:
--
--   1. A provider has to be allow-listed, with its retention terms recorded
--      and the date somebody read them. An empty list means no egress.
--   2. A case has to be opted in, by somebody who may, with the decision and
--      the reason kept.
--   3. Only PUBLIC and INTERNAL material may leave (PRD 22.4). The gateway
--      checks this per passage and the job records the ceiling it ran under,
--      so a request that should never have gone cannot be made to look
--      ordinary afterwards.
--   4. The redaction map never leaves. It is written here, read back here to
--      restore the answer, and `iims_app` cannot select it at all: only a
--      SECURITY DEFINER function can, for the job it belongs to.
--
-- Every outbound request is logged in the audit trail with provider, model,
-- case, user, classification and token count, which is the last line of
-- PRD 22.4.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The provider allow-list (PRD 22.4).
--
-- Ships with no rows. That is the point rather than an oversight: an
-- administrator has to name a provider, record what its terms say about
-- retention and training, and date their reading of them, before anything can
-- be sent anywhere.
--
-- The API key is NOT here. It is named here, and read from the environment at
-- call time, so a credential never sits in a table that a backup copies.
-- ---------------------------------------------------------------------------
create table if not exists config.ai_providers (
  key   text primary key check (key ~ '^[a-z][a-z0-9_]{1,30}$'),
  label text not null check (btrim(label) <> ''),

  -- An OpenAI-compatible base URL, which is what makes providers swappable
  -- (PRD 22.1). Anything that speaks that protocol fits with no code change.
  base_url text not null check (base_url ~ '^https://'),
  model    text not null check (btrim(model) <> ''),

  -- The NAME of the environment variable holding the key, never the key.
  api_key_env text not null check (api_key_env ~ '^[A-Z][A-Z0-9_]{2,60}$'),

  -- Off until somebody turns it on, and it cannot be turned on without the
  -- terms having been read. The CHECK is the whole safeguard: a provider
  -- enabled by somebody who skipped the reading is exactly the situation
  -- PRD 22.4 is written to prevent.
  is_enabled boolean not null default false,

  retention_terms    text,
  terms_reviewed_at  timestamptz,
  terms_reviewed_by  uuid references iam.users (id),

  -- Lower goes first. The router walks them in this order.
  position integer not null default 100,
  notes    text,

  -- A ceiling per provider, so a self-hosted model added later can be
  -- allowed more than a free public one without changing any code.
  max_classification text not null default 'INTERNAL'
    references iam.classification_levels (code),

  created_at timestamptz not null default now(),
  created_by uuid references iam.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references iam.users (id),
  version    integer not null default 1,

  constraint ai_providers_enabled_needs_reviewed_terms check (
    not is_enabled
    or (retention_terms is not null and terms_reviewed_at is not null)
  )
);

comment on table config.ai_providers is
  'PRD 22.4 provider allow-list. Empty by default, so no prompt can leave the '
  'platform until an administrator records a provider and the date they read '
  'its retention and training terms. Holds the NAME of the environment '
  'variable with the API key, never the key.';

-- ---------------------------------------------------------------------------
-- The circuit breaker (PRD 22.1).
--
-- Separate from the provider row because it is operational state that
-- changes by the minute, not configuration. Keeping them apart means a
-- breaker tripping is not an edit to an administrator's record, and the
-- version column on `ai_providers` does not move every time a free tier
-- rate-limits us.
-- ---------------------------------------------------------------------------
create table if not exists config.ai_provider_state (
  provider_key         text primary key references config.ai_providers (key) on delete cascade,
  consecutive_failures integer not null default 0,
  opened_at            timestamptz,
  next_attempt_at      timestamptz,
  last_error           text,
  last_success_at      timestamptz,
  updated_at           timestamptz not null default now()
);

comment on table config.ai_provider_state is
  'Circuit-breaker state per provider. A provider that has just returned 429 '
  'is skipped until next_attempt_at rather than retried into the ground.';

-- ---------------------------------------------------------------------------
-- AI per case (PRD 22.4: "off by default for every case").
--
-- A row only exists once somebody has decided, and the decision carries who
-- and why. No row means off, which is the safe reading of silence.
-- ---------------------------------------------------------------------------
create table if not exists config.ai_case_settings (
  case_id    uuid primary key references casework.cases (id) on delete cascade,
  is_enabled boolean not null default false,

  -- PRD 22.4 wants the decision recorded, so a reason is required in both
  -- directions: turning it on for a case is a disclosure decision, and
  -- turning it off again is one somebody may need to explain.
  reason     text not null check (btrim(reason) <> ''),
  decided_by uuid not null references iam.users (id),
  decided_at timestamptz not null default now(),

  -- Where client contracts restrict third-party processing (PRD 22.4), the
  -- consent is recorded against the engagement; this is the acknowledgement
  -- that somebody checked.
  client_consent_recorded boolean not null default false,

  updated_at timestamptz not null default now(),
  version    integer not null default 1
);

comment on table config.ai_case_settings is
  'PRD 22.4: AI is off for every case until a supervisor or operations '
  'manager enables it, with a reason. Absence of a row means off.';

-- ---------------------------------------------------------------------------
-- The job queue (PRD 22.1: "queue and fairness").
--
-- Every AI call is a job, including the interactive ones, for three reasons
-- that are all PRD 22.1: a per-user and per-case quota needs something to
-- count, a free tier needs requests spread rather than bunched, and a
-- summary that takes forty seconds must not be a page load.
--
-- `blocked` is a first-class outcome rather than a failure. A request refused
-- by the classification gate did not go wrong; it was correctly not sent, and
-- the reason belongs on the record.
-- ---------------------------------------------------------------------------
create table if not exists config.ai_jobs (
  id      uuid primary key default gen_random_uuid(),
  case_id uuid references casework.cases (id) on delete cascade,

  requested_by uuid not null references iam.users (id),
  kind         text not null check (kind in (
    'summarise_document', 'extract_entities', 'suggest_duplicates',
    'build_timeline', 'suggest_relationships', 'check_report', 'assist'
  )),

  -- The prompt version is part of the cache key, so changing a prompt
  -- invalidates every answer it produced rather than quietly mixing two
  -- generations of output (PRD 22.1).
  prompt_version text not null,
  input_hash     text not null check (input_hash ~ '^[0-9a-f]{64}$'),

  -- What it was asked about, kept so the audit trail and the screen can both
  -- say what happened. Never the retrieved passages themselves: those stay
  -- in the records they came from.
  subject      text,
  record_type  text,
  record_id    uuid,

  -- The highest classification in anything sent. PRD 22.4 caps this at
  -- INTERNAL, and recording it means a breach of that cap is visible
  -- afterwards rather than only preventable beforehand.
  classification text not null default 'INTERNAL'
    references iam.classification_levels (code),

  status text not null default 'queued' check (status in (
    'queued', 'running', 'succeeded', 'failed', 'blocked'
  )),
  blocked_reason text,

  provider_key      text references config.ai_providers (key),
  model             text,
  prompt_tokens     integer,
  completion_tokens integer,

  -- The answer, with its citations. jsonb because a suggestion is structured:
  -- a statement and the ids it rests on, which is what PRD 22.3 requires of
  -- every sentence.
  output jsonb,
  error  text,

  attempts integer not null default 0,
  cached   boolean not null default false,

  created_at  timestamptz not null default now(),
  started_at  timestamptz,
  finished_at timestamptz,

  -- A suggestion is never a finding until a person says so (PRD 22.3).
  accepted_by uuid references iam.users (id),
  accepted_at timestamptz,
  rejected_by uuid references iam.users (id),
  rejected_at timestamptz,
  decision_note text,

  constraint ai_jobs_blocked_has_a_reason check (
    status <> 'blocked' or blocked_reason is not null
  ),
  constraint ai_jobs_failed_has_a_reason check (
    status <> 'failed' or error is not null
  ),
  constraint ai_jobs_not_accepted_and_rejected check (
    accepted_at is null or rejected_at is null
  )
);

comment on table config.ai_jobs is
  'Every AI request, including interactive ones: PRD 22.1 counts quotas per '
  'user and per case, so there has to be something to count. `blocked` is a '
  'correct outcome, not a failure: the classification gate refused to send.';

create index if not exists ai_jobs_queue_idx
  on config.ai_jobs (created_at)
  where status = 'queued';

create index if not exists ai_jobs_requester_idx
  on config.ai_jobs (requested_by, created_at desc);

create index if not exists ai_jobs_case_idx
  on config.ai_jobs (case_id, created_at desc);

-- ---------------------------------------------------------------------------
-- The cache (PRD 22.1: "identical requests return the cached result").
--
-- Keyed on the prompt version and a hash of the input, which is what makes it
-- safe: the same question about the same text under the same prompt gets the
-- same answer for free, and any change to any of the three is a different
-- key rather than a stale hit.
-- ---------------------------------------------------------------------------
create table if not exists config.ai_cache (
  prompt_version text not null,
  input_hash     text not null check (input_hash ~ '^[0-9a-f]{64}$'),

  output       jsonb not null,
  provider_key text,
  model        text,

  hits        integer not null default 0,
  created_at  timestamptz not null default now(),
  last_hit_at timestamptz,

  primary key (prompt_version, input_hash)
);

comment on table config.ai_cache is
  'PRD 22.1: an identical request costs nothing. Keyed on prompt version and '
  'input hash, so changing a prompt cannot return an answer the old one gave.';

-- ---------------------------------------------------------------------------
-- The redaction map (PRD 22.4), which never leaves.
--
-- Names, identifiers, account numbers and addresses are replaced with tokens
-- before a request goes out and restored from here when the answer comes
-- back. `iims_app` is given NO privilege on this table at all: the only way
-- to read it is the SECURITY DEFINER function below, for one job. A table the
-- application can query is a table a bug can leak.
-- ---------------------------------------------------------------------------
create table if not exists config.ai_redactions (
  job_id   uuid not null references config.ai_jobs (id) on delete cascade,
  token    text not null check (token ~ '^\[[A-Z]+_[0-9]+\]$'),
  original text not null,
  kind     text not null check (kind in (
    'person', 'organisation', 'identifier', 'account', 'address', 'contact'
  )),
  primary key (job_id, token)
);

comment on table config.ai_redactions is
  'PRD 22.4 pseudonymisation map. Written before egress, read back to restore '
  'the answer, and never readable by the application role: only '
  'config.ai_restore(job) can see it.';

-- ---------------------------------------------------------------------------
-- Permissions for AI, as data like everything else (PRD 3.3).
--
-- Four, and they reuse the verbs the platform already has rather than
-- inventing two. The action set in 0006 is a closed CHECK on purpose, because
-- PRD 14 asks for "View, Create, Edit, Upload, Download, Share, Approve,
-- Delete evaluated separately", and `use` and `enable` would have been a
-- fifth and sixth verb meaning what two of those already mean:
--
--   ai:view      see a suggestion somebody asked for. A supervisor reviewing
--                one needs this and need not be able to ask for more.
--   ai:create    ask for a suggestion. It creates a job, which is what the
--                verb says.
--   ai:approve   turn AI on for a case. PRD 22.4 calls it a decision by a
--                Supervisor or Operations Manager, and an approval is what
--                that is.
--   ai:configure the provider allow-list. Granted to nobody: the
--                administrator's wildcard reaches it, and recording a third
--                party's data-retention terms is not a delegable act.
--
-- Every ceiling is INTERNAL, which is PRD 22.4's cap. A ceiling above that
-- would make the classification gate a formality.
-- ---------------------------------------------------------------------------
insert into iam.permissions (resource, action, scope, classification_ceiling, description)
values
  ('ai', 'view', 'assigned', 'INTERNAL',
   'See AI suggestions on a case you are on, and whether AI is enabled for it.'),
  ('ai', 'create', 'assigned', 'INTERNAL',
   'Ask the assistant for a suggestion. Capped at INTERNAL by PRD 22.4.'),
  ('ai', 'approve', 'all', 'INTERNAL',
   'Turn AI on or off for a case, with a reason (PRD 22.4).'),
  ('ai', 'configure', 'all', 'INTERNAL',
   'Maintain the provider allow-list and record each provider''s retention terms.')
on conflict (resource, action, scope, classification_ceiling) do nothing;

insert into iam.role_permissions (role_id, permission_id)
select r.id, p.id
from iam.roles r
cross join iam.permissions p
where p.resource = 'ai'
  and (
    (p.action = 'view' and r.key in (
      'investigator', 'analyst', 'forensics', 'supervisor', 'qa_reviewer',
      'operations_manager', 'coo', 'ceo'
    ))
    or (p.action = 'create' and r.key in (
      'investigator', 'analyst', 'forensics', 'supervisor', 'qa_reviewer'
    ))
    or (p.action = 'approve' and r.key in ('supervisor', 'operations_manager', 'coo'))
  )
on conflict do nothing;

-- Effective permissions are cached per user and invalidated by this, so the
-- grants above take effect without anybody signing in again (PRD 3.4).
update iam.users set permissions_version = permissions_version + 1;

-- ---------------------------------------------------------------------------
-- Is AI on for this case, and may this person use it?
--
-- One function, because the question is always asked as a whole: there is no
-- useful state where a provider is available but the case is not opted in.
-- Written as a function rather than repeated in five policies so there is one
-- place the answer comes from.
-- ---------------------------------------------------------------------------
create or replace function config.ai_available_for_case(p_case uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select
    -- At least one provider an administrator has enabled, which requires
    -- them to have recorded its terms.
    exists (select 1 from config.ai_providers where is_enabled)
    -- And this case opted in.
    and exists (
      select 1 from config.ai_case_settings s
      where s.case_id = p_case and s.is_enabled
    )
    -- And the asker may use it, and may reach the case.
    and iam.has_permission('ai', 'create', 'INTERNAL')
    and casework.can_reach_case(p_case, 'view');
$$;

comment on function config.ai_available_for_case(uuid) is
  'PRD 22.4: a provider is allow-listed and enabled, the case is opted in, '
  'and the asker may both use AI and reach the case. All four, or no.';

revoke all on function config.ai_available_for_case(uuid) from public;
grant execute on function config.ai_available_for_case(uuid) to iims_app;

-- ---------------------------------------------------------------------------
-- Restoring an answer.
--
-- The one way to read the redaction map, and only for a job the caller
-- requested. A SECURITY DEFINER function rather than a policy, because the
-- application role holds no privilege on the table at all and that is the
-- property worth keeping: there is nothing to widen by accident.
-- ---------------------------------------------------------------------------
create or replace function config.ai_restore(p_job uuid)
returns table (token text, original text)
language sql
security definer
set search_path = ''
stable
as $$
  select r.token, r.original
  from config.ai_redactions r
  join config.ai_jobs j on j.id = r.job_id
  where r.job_id = p_job
    and (
      -- The person who asked, restoring their own answer.
      j.requested_by = iam.current_user_id()
      -- Or the worker that is about to write the answer back.
      or nullif(current_setting('iims.system_process', true), '') is not null
    );
$$;

comment on function config.ai_restore(uuid) is
  'The only read of config.ai_redactions, for the job''s own requester or the '
  'worker. iims_app holds no privilege on that table.';

revoke all on function config.ai_restore(uuid) from public;
grant execute on function config.ai_restore(uuid) to iims_app;

-- ---------------------------------------------------------------------------
-- Row-level security.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['ai_providers', 'ai_provider_state',
                           'ai_case_settings', 'ai_jobs', 'ai_cache',
                           'ai_redactions']
  loop
    execute format('alter table config.%I enable row level security', t);
    execute format('alter table config.%I force  row level security', t);
  end loop;
end
$$;

-- The allow-list is readable by anybody who may use AI, because the screens
-- have to be able to say "no provider is configured" rather than failing
-- silently. It is writable only by whoever may configure it.
drop policy if exists ai_providers_select on config.ai_providers;
create policy ai_providers_select on config.ai_providers
  for select to iims_app
  using (
    iam.has_permission('ai', 'view', 'INTERNAL')
    or iam.has_permission('ai', 'configure', null)
  );

drop policy if exists ai_providers_write on config.ai_providers;
create policy ai_providers_write on config.ai_providers
  for all to iims_app
  using (iam.has_permission('ai', 'configure', null))
  with check (iam.has_permission('ai', 'configure', null));

-- Breaker state follows the provider it belongs to for reading, and is
-- written by the worker rather than by a person.
drop policy if exists ai_provider_state_select on config.ai_provider_state;
create policy ai_provider_state_select on config.ai_provider_state
  for select to iims_app
  using (
    iam.has_permission('ai', 'view', 'INTERNAL')
    or iam.has_permission('ai', 'configure', null)
  );

drop policy if exists ai_provider_state_write on config.ai_provider_state;
create policy ai_provider_state_write on config.ai_provider_state
  for all to iims_app
  using (nullif(current_setting('iims.system_process', true), '') is not null)
  with check (nullif(current_setting('iims.system_process', true), '') is not null);

-- Whether AI is on for a case is readable by anybody on the case: somebody
-- who cannot see the setting cannot understand why the assistant is absent.
drop policy if exists ai_case_settings_select on config.ai_case_settings;
create policy ai_case_settings_select on config.ai_case_settings
  for select to iims_app
  using (casework.can_reach_case(config.ai_case_settings.case_id, 'view'));

drop policy if exists ai_case_settings_write on config.ai_case_settings;
create policy ai_case_settings_write on config.ai_case_settings
  for all to iims_app
  using (
    iam.has_permission('ai', 'approve', 'INTERNAL')
    and casework.can_reach_case(config.ai_case_settings.case_id, 'view')
  )
  with check (
    iam.has_permission('ai', 'approve', 'INTERNAL')
    and casework.can_reach_case(config.ai_case_settings.case_id, 'view')
  );

-- A job is the requester's, or visible to somebody who can reach its case:
-- PRD 22.3 requires acceptance to be a human decision, and a supervisor
-- cannot review a suggestion they cannot see.
drop policy if exists ai_jobs_select on config.ai_jobs;
create policy ai_jobs_select on config.ai_jobs
  for select to iims_app
  using (
    requested_by = iam.current_user_id()
    or (
      config.ai_jobs.case_id is not null
      and casework.can_reach_case(config.ai_jobs.case_id, 'view')
      and iam.has_permission('ai', 'view', 'INTERNAL')
    )
  );

drop policy if exists ai_jobs_insert on config.ai_jobs;
create policy ai_jobs_insert on config.ai_jobs
  for insert to iims_app
  with check (
    requested_by = iam.current_user_id()
    and (
      config.ai_jobs.case_id is null
      or config.ai_available_for_case(config.ai_jobs.case_id)
    )
  );

-- Accepting or rejecting a suggestion, and the worker writing the answer
-- back. Nobody edits the prompt or the output of a job that has finished:
-- that is what the decision columns are for.
drop policy if exists ai_jobs_update on config.ai_jobs;
create policy ai_jobs_update on config.ai_jobs
  for update to iims_app
  using (
    nullif(current_setting('iims.system_process', true), '') is not null
    or (
      config.ai_jobs.case_id is not null
      and casework.can_reach_case(config.ai_jobs.case_id, 'view')
      and iam.has_permission('ai', 'view', 'INTERNAL')
    )
  )
  with check (
    nullif(current_setting('iims.system_process', true), '') is not null
    or (
      config.ai_jobs.case_id is not null
      and casework.can_reach_case(config.ai_jobs.case_id, 'view')
      and iam.has_permission('ai', 'view', 'INTERNAL')
    )
  );

-- The cache is infrastructure: the worker writes it, and nothing reads it
-- through a policy, because a cached answer is served by the gateway rather
-- than looked up by a screen.
drop policy if exists ai_cache_write on config.ai_cache;
create policy ai_cache_write on config.ai_cache
  for all to iims_app
  using (nullif(current_setting('iims.system_process', true), '') is not null)
  with check (nullif(current_setting('iims.system_process', true), '') is not null);

-- And the redaction map has NO policy, deliberately. See the privileges
-- below: the application role cannot reach it at all.

-- ---------------------------------------------------------------------------
-- Privileges.
-- ---------------------------------------------------------------------------
select config.revoke_erasure('config');

-- A provider has to be removable: an allow-list you can only add to is not an
-- allow-list. A case setting does not, because turning AI off is an edit with
-- a reason rather than a deletion.
grant delete on config.ai_providers to iims_app;

-- The redaction map is unreachable. Not "has no select policy": has no
-- privilege, so even a policy added later would have nothing to act on.
revoke all on config.ai_redactions from iims_app;

-- ---------------------------------------------------------------------------
-- Assertions.
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad text;
  v_n   integer;
begin
  -- RLS enabled AND forced everywhere.
  select string_agg(c.relname, ', ')
  into v_bad
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'config' and c.relkind = 'r'
    and c.relname like 'ai_%'
    and not (c.relrowsecurity and c.relforcerowsecurity);

  if v_bad is not null then
    raise exception 'row-level security is not enabled and forced on: %', v_bad;
  end if;

  -- The allow-list is empty, which is what makes PRD 22's "works fully with
  -- it switched off" true on the day this is applied.
  select count(*) into v_n from config.ai_providers;
  if v_n <> 0 then
    raise exception
      'the AI provider allow-list is not empty, so AI would not be off by default';
  end if;

  -- A provider cannot be enabled without its terms having been read.
  begin
    insert into config.ai_providers (key, label, base_url, model, api_key_env, is_enabled)
    values ('probe', 'Probe', 'https://example.invalid/v1', 'probe-model',
            'PROBE_API_KEY', true);
    raise exception
      'a provider was enabled with no retention terms recorded, which PRD 22.4 forbids';
  exception
    when check_violation then null;   -- refused, which is the point
  end;

  -- And the redaction map is beyond the application role's reach.
  if has_table_privilege('iims_app', 'config.ai_redactions', 'select')
     or has_table_privilege('iims_app', 'config.ai_redactions', 'insert')
     or has_table_privilege('iims_app', 'config.ai_redactions', 'update') then
    raise exception
      'iims_app can reach config.ai_redactions, so the pseudonymisation map is not safe';
  end if;

  -- The four permissions exist, and `configure` is granted to nobody: the
  -- administrator wildcard is the only thing that reaches it.
  select count(*) into v_n from iam.permissions where resource = 'ai';
  if v_n <> 4 then
    raise exception 'expected four ai permissions, found %', v_n;
  end if;

  select count(*)
  into v_n
  from iam.role_permissions rp
  join iam.permissions p on p.id = rp.permission_id
  where p.resource = 'ai' and p.action = 'configure';

  if v_n <> 0 then
    raise exception
      'ai:configure has been granted to % role(s); recording a third party''s retention terms is not delegable',
      v_n;
  end if;

  -- PRD 22.4 caps every ai permission at INTERNAL. A ceiling above that
  -- would make the classification gate a formality.
  select string_agg(p.action, ', ')
  into v_bad
  from iam.permissions p
  where p.resource = 'ai'
    and p.classification_ceiling not in ('PUBLIC', 'INTERNAL');

  if v_bad is not null then
    raise exception
      'these ai permissions reach above INTERNAL, which PRD 22.4 forbids: %',
      v_bad;
  end if;
end $$;
