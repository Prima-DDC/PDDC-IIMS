-- ---------------------------------------------------------------------------
-- 0060: the AI worker reads the allow-list as a system process.
--
-- 0059 made `config.ai_providers` readable by whoever may use or configure
-- AI, which is right for the screens and wrong for the worker: the queue
-- runs on a schedule with nobody signed in, and the first thing it has to do
-- is read the allow-list to know where to send anything.
--
-- The alternative was to give the worker somebody's identity, and the first
-- draft did exactly that by picking an administrator. It is worth saying why
-- that was wrong rather than merely inconvenient. Work attributed to a person
-- who did not do it corrupts the audit trail, which is the one record in this
-- platform that has to be true; and an actor with an administrator's
-- permissions would have had more reach than the person whose question it was
-- running, which is precisely the thing PRD 22.3's grounding rule exists to
-- prevent.
--
-- So the worker stays anonymous and named: `iims.system_process` is set to
-- `ai-drain` and no user id is published at all. Retrieval, which is the part
-- that MUST be permission-correct, is done separately as the person who asked
-- the question.
-- ---------------------------------------------------------------------------

drop policy if exists ai_providers_select on config.ai_providers;
create policy ai_providers_select on config.ai_providers
  for select to iims_app
  using (
    iam.has_permission('ai', 'view', 'INTERNAL')
    or iam.has_permission('ai', 'configure', null)
    -- A named background process with no signed-in user. Narrow on purpose:
    -- a request-serving transaction always publishes a user id, so this
    -- cannot be reached from a page however it is called.
    or (
      nullif(current_setting('iims.system_process', true), '') is not null
      and iam.current_user_id() is null
    )
  );

drop policy if exists ai_provider_state_select on config.ai_provider_state;
create policy ai_provider_state_select on config.ai_provider_state
  for select to iims_app
  using (
    iam.has_permission('ai', 'view', 'INTERNAL')
    or iam.has_permission('ai', 'configure', null)
    or (
      nullif(current_setting('iims.system_process', true), '') is not null
      and iam.current_user_id() is null
    )
  );

-- The same correction to the breaker's write policy and the cache's. 0059
-- accepted a system process without also requiring the absence of a user, so
-- a page could in principle have set the GUC and written to them. Nothing in
-- the codebase does, and the fix costs one clause.
drop policy if exists ai_provider_state_write on config.ai_provider_state;
create policy ai_provider_state_write on config.ai_provider_state
  for all to iims_app
  using (
    nullif(current_setting('iims.system_process', true), '') is not null
    and iam.current_user_id() is null
  )
  with check (
    nullif(current_setting('iims.system_process', true), '') is not null
    and iam.current_user_id() is null
  );

-- ---------------------------------------------------------------------------
-- The cache is the one exception, and it is deliberate.
--
-- A request-time read has to be able to find a cached answer, and that read
-- happens inside a transaction that DOES have a user: the asker's. So the
-- cache keeps the looser condition, and the protection is the key rather than
-- the policy. A cache entry is addressable only by (prompt_version,
-- input_hash), and the hash covers the prompt, the question and the exact
-- passages, so finding somebody else's answer means already possessing the
-- question and the material that produced it. If you have those, you have
-- the answer.
-- ---------------------------------------------------------------------------
drop policy if exists ai_cache_write on config.ai_cache;
create policy ai_cache_write on config.ai_cache
  for all to iims_app
  using (nullif(current_setting('iims.system_process', true), '') is not null)
  with check (nullif(current_setting('iims.system_process', true), '') is not null);

comment on table config.ai_cache is
  'PRD 22.1: an identical request costs nothing. Addressable only by prompt '
  'version and input hash, so reaching an entry means already holding the '
  'question and the passages that produced it.';

-- ---------------------------------------------------------------------------
-- Assertions.
-- ---------------------------------------------------------------------------
do $$
declare
  v_user uuid;
begin
  -- A request-shaped caller cannot write the breaker state.
  select id into v_user from iam.users where status = 'active' and deleted_at is null limit 1;

  if v_user is null then
    raise notice 'no active user to probe the breaker policy with, skipping';
    return;
  end if;

  -- Both policies name the system process, which is the property this
  -- migration exists to establish.
  if not exists (
    select 1 from pg_policy
    where polrelid = 'config.ai_providers'::regclass
      and polname = 'ai_providers_select'
      and pg_get_expr(polqual, polrelid) like '%system_process%'
  ) then
    raise exception 'the ai_providers select policy does not admit the worker';
  end if;

  if not exists (
    select 1 from pg_policy
    where polrelid = 'config.ai_provider_state'::regclass
      and polname = 'ai_provider_state_write'
      and pg_get_expr(polqual, polrelid) like '%current_user_id() IS NULL%'
  ) then
    raise exception
      'the breaker write policy no longer requires the absence of a signed-in user';
  end if;
end $$;
