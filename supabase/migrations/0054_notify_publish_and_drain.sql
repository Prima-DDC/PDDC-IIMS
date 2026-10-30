-- ---------------------------------------------------------------------------
-- 0054: publishing a notification, and draining the queue.
--
-- Migration 0053 built the tables and closed them properly, and closing them
-- properly is what makes this migration necessary. Two things the platform
-- has to do cannot be done under those policies, and neither should be fixed
-- by widening them:
--
--   PUBLISHING. Notifying somebody means reading THEIR preferences, and
--   `preferences_select` is `user_id = iam.current_user_id()`. A producer is
--   by definition not the recipient, so it cannot see whether they asked not
--   to be emailed. Widening that policy would let anybody read everybody's
--   choices, which is a worse outcome than the problem.
--
--   DRAINING. The worker has to read and update `notify.outbox`, which has an
--   insert policy and nothing else, deliberately: the outbox is a queue of
--   email addresses and delivery state, and no page in the platform has any
--   business reading it.
--
-- So both become SECURITY DEFINER functions with a pinned `search_path`, each
-- doing one thing and refusing everything else. This is the same shape as
-- 0051 and 0052, and for the same reason: the narrow function is a smaller
-- grant than the wider policy would be.
--
-- THE GUARD ON THE WORKER FUNCTIONS IS STRUCTURAL, not a password. A
-- request-serving transaction always publishes `iims.user_id`; the outbox
-- worker runs under `withSystemActor`, which publishes `iims.system_process`
-- and no user. So the queue functions require a system process AND no user,
-- which means nothing reached from a signed-in request can touch the queue
-- however it is called. The route the scheduler posts to is protected
-- separately by a shared secret; this is the layer underneath that.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- An in-app preference that is switched off has to mean something.
--
-- 0053 made a preference two booleans per category and left the in-app half
-- with nowhere to land: the notification row is the durable record, and the
-- outbox references it, so it cannot simply not be written. Recording the
-- suppression on the row is the honest version. The event happened and is on
-- file; the person asked not to see it in their feed, and does not.
--
-- Filtering the feed by today's preferences instead would have made history
-- move: switching a category off would retrospectively hide what had already
-- been shown, and switching it back on would resurrect it.
-- ---------------------------------------------------------------------------
alter table notify.notifications
  add column if not exists in_app_suppressed boolean not null default false;

comment on column notify.notifications.in_app_suppressed is
  'True when the recipient had this category''s in-app channel switched off '
  'at the moment it was published. The row stays, because it is the record '
  'of what was communicated and the outbox references it; the feed does not '
  'show it.';

-- The unread index is what the bell count reads, so it has to agree with the
-- feed about what counts.
drop index if exists notify.notifications_unread_idx;
create index notifications_unread_idx
  on notify.notifications (recipient_id, created_at desc)
  where read_at is null and not in_app_suppressed;

-- ---------------------------------------------------------------------------
-- Publishing one notification.
--
-- Called inside the business action's own transaction (PRD 12.2), so an
-- action that rolls back notifies nobody and one that commits always does.
-- That is the whole point of the outbox and it is why this is a function
-- rather than a job.
--
-- Returns the notification id, or null when there was nobody to tell. Null
-- rather than an exception, because notifying is a consequence of the work
-- and not the work: refusing to assign a task because its assignee was
-- deactivated thirty seconds ago would be the wrong failure in the wrong
-- place. A caller that genuinely requires a live recipient checks that
-- itself, before it does the thing.
-- ---------------------------------------------------------------------------
create or replace function notify.publish(
  p_recipient uuid,
  p_category  text,
  p_title     text,
  p_detail    text default null,
  p_case_id   uuid default null,
  p_link      text default null,
  p_email     jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor       uuid := iam.current_user_id();
  v_system      text := nullif(current_setting('iims.system_process', true), '');
  v_mandatory   boolean;
  v_want_in_app boolean;
  v_want_email  boolean;
  v_email       text;
  v_id          uuid;
begin
  -- Somebody or something identifiable has to be the cause. A notification
  -- with no origin is not traceable, and everything else here is.
  if v_actor is null and v_system is null then
    raise exception
      'a notification needs an identified actor or a named system process'
      using errcode = 'insufficient_privilege';
  end if;

  select c.is_mandatory into v_mandatory
  from notify.categories c
  where c.key = p_category;

  if v_mandatory is null then
    raise exception 'there is no notification category %', p_category
      using errcode = 'foreign_key_violation';
  end if;

  -- Telling somebody what they have just done themselves is noise, so a
  -- producer may name the actor as the recipient and nothing happens. The
  -- mandatory three are exempt: an integrity failure on a file you uploaded
  -- is exactly the thing you have to be told, whoever triggered the check.
  if not v_mandatory and p_recipient = v_actor then
    return null;
  end if;

  -- An inactive or deleted recipient is nobody to tell.
  if not exists (
    select 1 from iam.users u
    where u.id = p_recipient and u.status = 'active' and u.deleted_at is null
  ) then
    return null;
  end if;

  -- Absence means on (PRD 12.2), and a mandatory category ignores the answer.
  select
    v_mandatory or coalesce(pr.in_app, true),
    v_mandatory or coalesce(pr.email, true)
  into v_want_in_app, v_want_email
  from (select 1) as one
  left join notify.preferences pr
    on pr.user_id = p_recipient and pr.category = p_category;

  insert into notify.notifications (
    recipient_id, category, title, detail, case_id, link,
    in_app_suppressed, created_by
  )
  values (
    p_recipient, p_category, p_title, nullif(btrim(p_detail), ''),
    p_case_id, nullif(btrim(p_link), ''), not v_want_in_app, v_actor
  )
  returning id into v_id;

  -- No email asked for, or not wanted: the in-app record is the whole of it.
  if p_email is null or not v_want_email then
    return v_id;
  end if;

  -- Read inside the function and used inside the function, so the address
  -- never travels back to the application. `iam.profile_basics` is the shared
  -- primaddc.com directory, which is where an employee's address lives.
  select pb.email into v_email
  from iam.profile_basics(array[p_recipient]) pb;

  -- Somebody with no usable address still gets the in-app record. An outbox
  -- row we could never send would be a dead letter from birth.
  if v_email is null or position('@' in v_email) < 2 then
    return v_id;
  end if;

  -- `params` is checked by 0053's constraint, which permits five keys and no
  -- others. The template is the category: one per kind of event.
  insert into notify.outbox (
    notification_id, idempotency_key, recipient_email, template, params
  )
  values (
    v_id, 'pddc-iims:' || v_id::text, v_email, p_category,
    coalesce(p_email, '{}'::jsonb)
  );

  return v_id;
end
$$;

comment on function notify.publish(uuid, text, text, text, uuid, text, jsonb) is
  'PRD 12.2: writes the in-app record and, if the recipient wants it, the '
  'outbox row, inside the caller''s transaction. SECURITY DEFINER because a '
  'producer is not the recipient and so cannot read their preferences under '
  'notify.preferences'' own policy.';

revoke all on function notify.publish(uuid, text, text, text, uuid, text, jsonb)
  from public;
grant execute on function notify.publish(uuid, text, text, text, uuid, text, jsonb)
  to iims_app;

-- ---------------------------------------------------------------------------
-- Claiming what is due.
--
-- A lease, not a status. 0053's status column holds what the provider has
-- told us and nothing else, so there is no `sending` to park a row in, and
-- inventing one would make the delivery record describe our scheduling
-- rather than the message. Instead the claim pushes `next_attempt_at` five
-- minutes out and counts the attempt, which means:
--
--   two workers cannot take the same row, because SKIP LOCKED plus the push
--   leaves nothing for the second one to find;
--
--   a worker that dies mid-send does not strand the row, because the lease
--   expires and it comes back round;
--
--   and a message that kills the worker every time still runs out of
--   attempts, because the attempt is counted at the claim rather than at the
--   outcome. A poison message counted only on a clean failure would retry
--   for ever.
-- ---------------------------------------------------------------------------
create or replace function notify.claim_due_emails(p_limit integer default 25)
returns table (
  id              uuid,
  notification_id uuid,
  idempotency_key text,
  recipient_email text,
  template        text,
  params          jsonb,
  status          text,
  attempts        integer,
  next_attempt_at timestamptz,
  last_error      text
)
language plpgsql
security definer
set search_path = ''
as $$
-- The OUT parameters above are named after the columns they carry, which is
-- what makes the result readable at the call site, and it also means an
-- unqualified `status` or `attempts` inside the body would be ambiguous.
-- Resolving in favour of the column is the only reading that could ever be
-- meant here.
#variable_conflict use_column
begin
  if nullif(current_setting('iims.system_process', true), '') is null
     or iam.current_user_id() is not null then
    raise exception
      'the outbox is drained by a system process, not by a request'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  with due as (
    select o.id
    from notify.outbox o
    where o.status = 'queued'
      and o.next_attempt_at <= now()
    order by o.next_attempt_at
    limit greatest(1, least(coalesce(p_limit, 25), 200))
    for update skip locked
  ),
  leased as (
    update notify.outbox o
    set attempts = o.attempts + 1,
        next_attempt_at = now() + interval '5 minutes'
    where o.id in (select due.id from due)
    returning
      o.id, o.notification_id, o.idempotency_key, o.recipient_email,
      o.template, o.params, o.status, o.attempts, o.next_attempt_at,
      o.last_error
  )
  -- A plain SELECT over the data-modifying CTE rather than
  -- `return query update ... returning`, which plpgsql does not accept.
  select * from leased;
end
$$;

comment on function notify.claim_due_emails(integer) is
  'Leases up to p_limit due rows to one worker, counting the attempt at the '
  'claim so a message that crashes the worker cannot retry for ever. '
  'Callable only from a system process with no signed-in user.';

revoke all on function notify.claim_due_emails(integer) from public;
grant execute on function notify.claim_due_emails(integer) to iims_app;

-- ---------------------------------------------------------------------------
-- What the attempt did.
--
-- One function for both outcomes, because the delivery event has to be
-- written in the same transaction as the status whichever way it went: a
-- status with no history is exactly what `delivery_events` exists to prevent.
-- ---------------------------------------------------------------------------
create or replace function notify.record_send_outcome(
  p_id          uuid,
  p_status      text,
  p_provider_id text default null,
  p_error       text default null,
  p_retry_at    timestamptz default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current text;
begin
  if nullif(current_setting('iims.system_process', true), '') is null
     or iam.current_user_id() is not null then
    raise exception
      'the outbox is drained by a system process, not by a request'
      using errcode = 'insufficient_privilege';
  end if;

  select o.status into v_current from notify.outbox o where o.id = p_id;

  if v_current is null then
    raise exception 'there is no outbox row %', p_id
      using errcode = 'no_data_found';
  end if;

  -- The one transition the database refuses outright. The full table of legal
  -- moves lives in the domain layer, where it is unit tested and where the
  -- message explaining a refusal can be written for a person; duplicating it
  -- here would give two copies to keep in step. This single rule is here
  -- because it is the one that would lose information: a delivered message
  -- has arrived, and nothing afterwards changes that.
  if v_current = 'delivered' and p_status <> 'delivered' then
    raise exception 'outbox row % was delivered and cannot be moved to %',
      p_id, p_status
      using errcode = 'check_violation';
  end if;

  update notify.outbox
  set status = p_status,
      provider_id = coalesce(p_provider_id, provider_id),
      last_error = case when p_status = 'queued' then null else p_error end,
      sent_at = case when p_status = 'sent' then now() else sent_at end,
      -- Only a row going back into the queue is waiting for anything, so
      -- only that one moves its attempt time.
      next_attempt_at = coalesce(p_retry_at, next_attempt_at)
  where id = p_id;

  insert into notify.delivery_events (outbox_id, status, detail, provider_id)
  values (p_id, p_status, p_error, p_provider_id);
end
$$;

comment on function notify.record_send_outcome(uuid, text, text, text, timestamptz) is
  'Records the result of one send attempt and its delivery event together, so '
  'a status never exists without the history behind it.';

revoke all on function notify.record_send_outcome(uuid, text, text, text, timestamptz)
  from public;
grant execute on function notify.record_send_outcome(uuid, text, text, text, timestamptz)
  to iims_app;

-- ---------------------------------------------------------------------------
-- What the provider said afterwards.
--
-- Keyed by the idempotency key rather than our row id, because that is what a
-- webhook has. Unused on SMTP, which reports nothing once the relay has
-- accepted a message; here so that wiring a provider which does report is a
-- route handler and not a migration.
-- ---------------------------------------------------------------------------
create or replace function notify.record_provider_event(
  p_idempotency_key text,
  p_status          text,
  p_detail          text default null,
  p_provider_id     text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if nullif(current_setting('iims.system_process', true), '') is null
     or iam.current_user_id() is not null then
    raise exception
      'delivery events come from a system process, not from a request'
      using errcode = 'insufficient_privilege';
  end if;

  select o.id into v_id
  from notify.outbox o
  where o.idempotency_key = p_idempotency_key;

  if v_id is null then
    -- A webhook about something we never sent. Not an error: a provider may
    -- report on a message from another environment sharing the mailbox.
    return;
  end if;

  perform notify.record_send_outcome(v_id, p_status, p_provider_id, p_detail, null);
end
$$;

comment on function notify.record_provider_event(text, text, text, text) is
  'Applies a provider delivery callback, matched by idempotency key. Silent '
  'about a key it does not recognise, because that is somebody else''s '
  'message rather than a fault.';

revoke all on function notify.record_provider_event(text, text, text, text)
  from public;
grant execute on function notify.record_provider_event(text, text, text, text)
  to iims_app;

-- ---------------------------------------------------------------------------
-- The queue is now unreadable to the application, as a privilege and not
-- only as a missing policy.
--
-- `iims_app` held SELECT and UPDATE on `notify.outbox` because the schema
-- grant gives those to every table in a content schema. Nothing could be
-- read through them, since row-level security is forced and 0053 wrote no
-- select policy, so this was never a leak. It was a trap: the next person to
-- add a select policy to that table, for an admin delivery screen or a
-- debugging view, would have opened the whole queue without having to grant
-- anything, and the grant is the part a reviewer looks at.
--
-- Taking the privilege away states the intention in the place where it can be
-- checked. The functions above are SECURITY DEFINER and run as the owner, so
-- they are unaffected; an admin screen that wants delivery health gets its
-- own function and shows what it decides to show.
-- ---------------------------------------------------------------------------
revoke select, update on notify.outbox from iims_app;

-- ---------------------------------------------------------------------------
-- Assertions.
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad text;
begin
  -- Every function added here is SECURITY DEFINER with search_path pinned. An
  -- unpinned definer function is a privilege escalation waiting for a caller
  -- who can create a schema, so this is checked rather than reviewed.
  select string_agg(p.proname, ', ')
  into v_bad
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'notify'
    and p.proname in ('publish', 'claim_due_emails', 'record_send_outcome',
                      'record_provider_event')
    and not (p.prosecdef and p.proconfig @> array['search_path=""']);

  if v_bad is not null then
    raise exception
      'these notify functions are not SECURITY DEFINER with a pinned search_path: %',
      v_bad;
  end if;

  -- And PUBLIC cannot execute any of them.
  select string_agg(p.proname, ', ')
  into v_bad
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'notify'
    and p.proname in ('publish', 'claim_due_emails', 'record_send_outcome',
                      'record_provider_event')
    and has_function_privilege('public', p.oid, 'execute');

  if v_bad is not null then
    raise exception 'PUBLIC can execute: %', v_bad;
  end if;

  -- The outbox is still unreadable to the application outside those
  -- functions. This is the guarantee 0053 set up and the one this migration
  -- is most at risk of having undone.
  if exists (
    select 1 from pg_policy
    where polrelid = 'notify.outbox'::regclass
      and polcmd <> 'a'
  ) then
    raise exception 'notify.outbox now has a policy other than insert';
  end if;

  if has_table_privilege('iims_app', 'notify.outbox', 'select') then
    -- The grant would be harmless on its own, since there is no select
    -- policy, but it would mean the next person to add one opened the queue
    -- without noticing.
    raise exception 'iims_app has been granted select on notify.outbox';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- A live check that the guard works.
--
-- Worth doing here rather than in the test suite: the integration tests
-- connect as `postgres`, which owns these functions, so they cannot exercise
-- the interesting part. This runs with the settings a request would have,
-- which is the case that matters, and leaves nothing behind.
-- ---------------------------------------------------------------------------
do $$
declare
  v_user uuid;
begin
  select id into v_user
  from iam.users
  where status = 'active' and deleted_at is null
  limit 1;

  if v_user is null then
    raise notice 'no active user to probe the outbox guard with, skipping';
    return;
  end if;

  perform set_config('iims.user_id', v_user::text, true);
  perform set_config('iims.system_process', 'probe', true);

  begin
    perform notify.claim_due_emails(1);
    raise exception 'a request-shaped caller drained the outbox';
  exception
    when insufficient_privilege then null;   -- refused, which is the point
  end;

  perform set_config('iims.user_id', '', true);
  perform set_config('iims.system_process', '', true);
end $$;
