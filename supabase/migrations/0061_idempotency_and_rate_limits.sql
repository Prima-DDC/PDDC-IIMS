-- ---------------------------------------------------------------------------
-- 0061: idempotency and rate limiting (PRD 14, 21.7).
--
-- Two mechanisms that have nothing to do with each other except that both are
-- counters nobody should have to think about, and both are in Postgres
-- because there is no Redis. PRD 21.3 asks for Redis and Supabase does not
-- provide it; a fixed-window counter in a table is slower than Redis and
-- correct, which is the right trade for a firm of this size. Both sit behind
-- functions, so moving them to Upstash later is an adapter rather than a
-- rewrite.
--
-- IDEMPOTENCY (PRD 21.7: "idempotency keys on all mutating endpoints;
-- replaying any mutating request with the same key yields one record, the
-- same response, and no duplicate email").
--
-- The hard part is not storing the response. It is deciding what to do when
-- the same key arrives with a DIFFERENT body, which is a client bug and must
-- not be served the old answer: PRD 21.7 wants 422 for that, and the stored
-- request hash is what makes the distinction possible.
--
-- It is also not a cache. A replay returns the first response for as long as
-- the key lives and then stops being special, so the window is deliberately
-- short: twenty-four hours is long enough to cover a retry, a double
-- submission, or somebody's browser resending a form, and short enough that
-- the table stays small and a key cannot be reused months later by accident.
--
-- RATE LIMITING (PRD 14). Fixed windows rather than a sliding log, because a
-- sliding window needs a row per request and the thing being defended against
-- is a flood of requests. A fixed window admits up to twice the limit across
-- a boundary, which is a known and acceptable property: the limits here are
-- set to stop abuse and runaway loops, not to meter a paid API to the
-- request.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Idempotency.
-- ---------------------------------------------------------------------------
create table if not exists config.idempotency_keys (
  -- The caller's key, scoped to the caller. Two people may legitimately use
  -- the same key, and a key that crossed users would let one person replay
  -- another's response.
  key     text not null check (btrim(key) <> ''),
  user_id uuid not null references iam.users (id) on delete cascade,

  -- What it was a key FOR. The same key against a different action is a
  -- different operation, and treating them as one would return a client the
  -- answer to a question it did not ask.
  endpoint text not null check (btrim(endpoint) <> ''),

  -- sha256 of the canonical request. A replay with a different body is a bug
  -- and gets 422 rather than the stored answer (PRD 21.7).
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),

  -- Null while the first attempt is still running, which is how a concurrent
  -- duplicate is detected: the row exists and has no response yet.
  response jsonb,

  created_at   timestamptz not null default now(),
  completed_at timestamptz,
  expires_at   timestamptz not null default now() + interval '24 hours',

  primary key (user_id, endpoint, key)
);

comment on table config.idempotency_keys is
  'PRD 21.7: replaying a mutating request with the same key yields one '
  'record and the same response. Keyed per user and per endpoint, because a '
  'key that crossed either would serve one caller another''s answer.';

create index if not exists idempotency_keys_expiry_idx
  on config.idempotency_keys (expires_at);

-- ---------------------------------------------------------------------------
-- Claiming a key.
--
-- Returns what the caller should do, in one round trip, because the decision
-- cannot be made in two: reading and then inserting leaves a window in which
-- two concurrent duplicates both believe they are first.
--
--   'proceed'   this is the first attempt. Do the work, then record it.
--   'replay'    it has been done. The response is returned with this.
--   'running'   a duplicate is in flight right now. The caller waits and
--               retries rather than doing the work twice.
--   'conflict'  the same key with a different body. PRD 21.7 says 422.
-- ---------------------------------------------------------------------------
create or replace function config.claim_idempotency_key(
  p_key          text,
  p_endpoint     text,
  p_request_hash text
)
returns table (outcome text, response jsonb)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user     uuid := iam.current_user_id();
  v_existing record;
begin
  if v_user is null then
    raise exception 'an idempotency key needs an identified caller'
      using errcode = 'insufficient_privilege';
  end if;

  -- One statement, so two concurrent duplicates cannot both be first. The
  -- loser of the race gets no row back from the insert and reads the
  -- existing one below.
  insert into config.idempotency_keys (key, user_id, endpoint, request_hash)
  values (p_key, v_user, p_endpoint, p_request_hash)
  on conflict (user_id, endpoint, key) do nothing;

  select * into v_existing
  from config.idempotency_keys k
  where k.user_id = v_user and k.endpoint = p_endpoint and k.key = p_key;

  -- Our own insert, a moment ago.
  if v_existing.request_hash = p_request_hash
     and v_existing.completed_at is null
     and v_existing.created_at >= now() - interval '1 second' then
    return query select 'proceed'::text, null::jsonb;
    return;
  end if;

  if v_existing.request_hash <> p_request_hash then
    return query select 'conflict'::text, null::jsonb;
    return;
  end if;

  if v_existing.completed_at is not null then
    return query select 'replay'::text, v_existing.response;
    return;
  end if;

  -- The row exists, matches, and has not completed: somebody else is doing
  -- it. Unless they have been doing it for an implausibly long time, in
  -- which case they died and this caller may take over.
  if v_existing.created_at < now() - interval '2 minutes' then
    update config.idempotency_keys
    set created_at = now()
    where user_id = v_user and endpoint = p_endpoint and key = p_key;
    return query select 'proceed'::text, null::jsonb;
    return;
  end if;

  return query select 'running'::text, null::jsonb;
end
$$;

comment on function config.claim_idempotency_key(text, text, text) is
  'Decides in one statement whether a caller should proceed, replay, wait or '
  'be refused. Two reads would leave a window in which concurrent duplicates '
  'both believe they are first.';

revoke all on function config.claim_idempotency_key(text, text, text) from public;
grant execute on function config.claim_idempotency_key(text, text, text) to iims_app;

create or replace function config.complete_idempotency_key(
  p_key      text,
  p_endpoint text,
  p_response jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := iam.current_user_id();
begin
  if v_user is null then
    raise exception 'an idempotency key needs an identified caller'
      using errcode = 'insufficient_privilege';
  end if;

  update config.idempotency_keys
  set response = p_response, completed_at = now()
  where user_id = v_user and endpoint = p_endpoint and key = p_key
    and completed_at is null;
end
$$;

revoke all on function config.complete_idempotency_key(text, text, jsonb) from public;
grant execute on function config.complete_idempotency_key(text, text, jsonb) to iims_app;

/*
 * Releasing a key that failed.
 *
 * A refused submission must NOT be remembered as its own answer. Somebody
 * who is told to check a highlighted field, corrects it and submits again is
 * sending the same key with a different body, and a stored failure would
 * meet that with 422 for ever. So a failure deletes the claim and the
 * corrected submission starts clean.
 *
 * This is the one place the table is deleted from, and it is why the schema's
 * no-erasure convention is relaxed for it below.
 */
create or replace function config.release_idempotency_key(
  p_key      text,
  p_endpoint text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := iam.current_user_id();
begin
  if v_user is null then return; end if;

  delete from config.idempotency_keys
  where user_id = v_user and endpoint = p_endpoint and key = p_key
    and completed_at is null;
end
$$;

revoke all on function config.release_idempotency_key(text, text) from public;
grant execute on function config.release_idempotency_key(text, text) to iims_app;

-- ---------------------------------------------------------------------------
-- Rate limiting.
-- ---------------------------------------------------------------------------
create table if not exists config.rate_limits (
  -- Whatever the caller is counting: a user id, an IP, a route name, or a
  -- combination. Opaque on purpose, so a new limit needs no migration.
  bucket       text not null,
  window_start timestamptz not null,
  hits         integer not null default 0,
  primary key (bucket, window_start)
);

comment on table config.rate_limits is
  'Fixed-window counters (PRD 14). A fixed window admits up to twice the '
  'limit across a boundary, which is acceptable here: these stop abuse and '
  'runaway loops rather than metering a paid API to the request.';

create index if not exists rate_limits_window_idx
  on config.rate_limits (window_start);

-- ---------------------------------------------------------------------------
-- Counting a hit, and saying whether it is allowed.
--
-- The increment and the decision are one statement, so two requests arriving
-- together cannot both read "one under the limit" and both proceed.
-- ---------------------------------------------------------------------------
create or replace function config.take_rate_limit(
  p_bucket         text,
  p_limit          integer,
  p_window_seconds integer
)
returns table (allowed boolean, hits integer, retry_after_seconds integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window timestamptz;
  v_hits   integer;
begin
  -- Truncated to the window, so every caller in the same window shares a row
  -- rather than each creating their own.
  v_window := to_timestamp(
    floor(extract(epoch from now()) / greatest(p_window_seconds, 1))
      * greatest(p_window_seconds, 1)
  );

  insert into config.rate_limits (bucket, window_start, hits)
  values (p_bucket, v_window, 1)
  on conflict (bucket, window_start) do update
    set hits = config.rate_limits.hits + 1
  returning config.rate_limits.hits into v_hits;

  return query select
    v_hits <= p_limit,
    v_hits,
    greatest(
      1,
      ceil(extract(epoch from (v_window + make_interval(secs => p_window_seconds)) - now()))::integer
    );
end
$$;

comment on function config.take_rate_limit(text, integer, integer) is
  'Counts a hit and decides in one statement, so two requests arriving '
  'together cannot both read one-under-the-limit and both proceed.';

revoke all on function config.take_rate_limit(text, integer, integer) from public;
grant execute on function config.take_rate_limit(text, integer, integer) to iims_app;

-- ---------------------------------------------------------------------------
-- Housekeeping.
--
-- Both tables grow with traffic and neither has any value once its window has
-- passed. `cron.job_run_details` taught this lesson already: a table nobody
-- prunes blocks an upgrade eventually.
-- ---------------------------------------------------------------------------
create or replace function config.prune_expired_counters()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_keys  integer;
  v_rates integer;
begin
  if nullif(current_setting('iims.system_process', true), '') is null
     or iam.current_user_id() is not null then
    raise exception 'pruning runs on a schedule, not from a request'
      using errcode = 'insufficient_privilege';
  end if;

  delete from config.idempotency_keys where expires_at < now();
  get diagnostics v_keys = row_count;

  -- A day of windows kept, so a rate-limit question can still be answered
  -- after the fact ("was this account throttled yesterday").
  delete from config.rate_limits where window_start < now() - interval '1 day';
  get diagnostics v_rates = row_count;

  return v_keys + v_rates;
end
$$;

revoke all on function config.prune_expired_counters() from public;
grant execute on function config.prune_expired_counters() to iims_app;

-- ---------------------------------------------------------------------------
-- Row-level security.
--
-- Neither table is read by the application: both are reached only through the
-- functions above, which are SECURITY DEFINER. So there is no select policy
-- and no privilege, which is the same shape as the notification outbox and
-- the AI redaction map.
-- ---------------------------------------------------------------------------
alter table config.idempotency_keys enable row level security;
alter table config.idempotency_keys force  row level security;
alter table config.rate_limits      enable row level security;
alter table config.rate_limits      force  row level security;

revoke all on config.idempotency_keys from iims_app;
revoke all on config.rate_limits      from iims_app;

-- ---------------------------------------------------------------------------
-- Assertions.
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad  text;
  v_user uuid;
  v_out  record;
begin
  select string_agg(p.proname, ', ')
  into v_bad
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'config'
    and p.proname in ('claim_idempotency_key', 'complete_idempotency_key',
                      'release_idempotency_key', 'take_rate_limit',
                      'prune_expired_counters')
    and not (p.prosecdef and p.proconfig @> array['search_path=""']);

  if v_bad is not null then
    raise exception
      'these functions are not SECURITY DEFINER with a pinned search_path: %',
      v_bad;
  end if;

  -- Neither table is reachable by the application except through them.
  if has_table_privilege('iims_app', 'config.idempotency_keys', 'select')
     or has_table_privilege('iims_app', 'config.rate_limits', 'select') then
    raise exception
      'the counters are directly readable by iims_app, so the functions are not the only way in';
  end if;

  -- And the limiter actually limits. Three hits against a limit of two.
  perform set_config('iims.system_process', '', true);
  perform set_config('iims.user_id', '', true);

  select * into v_out from config.take_rate_limit('probe:0061', 2, 60);
  if not v_out.allowed then raise exception 'the first hit was refused'; end if;

  select * into v_out from config.take_rate_limit('probe:0061', 2, 60);
  if not v_out.allowed then raise exception 'the second hit was refused'; end if;

  select * into v_out from config.take_rate_limit('probe:0061', 2, 60);
  if v_out.allowed then
    raise exception 'the third hit was allowed against a limit of two';
  end if;
  if v_out.retry_after_seconds < 1 then
    raise exception 'the refusal did not say when to try again';
  end if;

  delete from config.rate_limits where bucket = 'probe:0061';

  -- The idempotency claim refuses a caller it cannot identify, which is what
  -- stops an unauthenticated path from writing into the table.
  begin
    perform config.claim_idempotency_key('probe', 'probe', repeat('a', 64));
    raise exception 'an unidentified caller claimed an idempotency key';
  exception
    when insufficient_privilege then null;
  end;

  -- And it behaves: proceed, then replay, then conflict.
  select id into v_user from iam.users
  where status = 'active' and deleted_at is null limit 1;

  if v_user is null then
    raise notice 'no active user to probe idempotency with, skipping';
    return;
  end if;

  perform set_config('iims.user_id', v_user::text, true);

  select * into v_out
  from config.claim_idempotency_key('probe-0061', 'probe', repeat('a', 64));
  if v_out.outcome <> 'proceed' then
    raise exception 'a first claim returned %', v_out.outcome;
  end if;

  perform config.complete_idempotency_key(
    'probe-0061', 'probe', '{"ok": true}'::jsonb);

  select * into v_out
  from config.claim_idempotency_key('probe-0061', 'probe', repeat('a', 64));
  if v_out.outcome <> 'replay' or v_out.response is null then
    raise exception 'a repeat claim returned % rather than the stored response',
      v_out.outcome;
  end if;

  select * into v_out
  from config.claim_idempotency_key('probe-0061', 'probe', repeat('b', 64));
  if v_out.outcome <> 'conflict' then
    raise exception
      'the same key with a different body returned % rather than conflict',
      v_out.outcome;
  end if;

  delete from config.idempotency_keys where key = 'probe-0061';
  perform set_config('iims.user_id', '', true);
end $$;
