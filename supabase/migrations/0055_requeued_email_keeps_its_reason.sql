-- ---------------------------------------------------------------------------
-- 0055: a requeued email keeps the reason it was requeued for.
--
-- 0054 cleared `last_error` whenever a row went back into the queue, on the
-- reasoning that a queued row is waiting rather than broken. That reads
-- nicely and is wrong in practice: the first question anybody asks about a
-- message that has not arrived is why, and under the old expression a row
-- that had failed three times and was waiting for its fourth attempt showed
-- nothing at all. The history was in `notify.delivery_events`, but reaching
-- it needs a join and a privilege the application does not have, so the one
-- field an operator can actually see said the least.
--
-- Now the error survives a requeue and is cleared only by a send that
-- worked. A row therefore carries the last thing that went wrong until
-- nothing is wrong, which is what the column is for.
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
      -- Cleared by success, kept by everything else. A requeued row is
      -- waiting BECAUSE of something, and that something is the useful part.
      last_error = case
                     when p_status in ('sent', 'delivered') then null
                     else coalesce(p_error, last_error)
                   end,
      sent_at = case when p_status = 'sent' then now() else sent_at end,
      next_attempt_at = coalesce(p_retry_at, next_attempt_at)
  where id = p_id;

  insert into notify.delivery_events (outbox_id, status, detail, provider_id)
  values (p_id, p_status, p_error, p_provider_id);
end
$$;

-- ---------------------------------------------------------------------------
-- Assertions. The replacement must still be a pinned definer function, and
-- the constraint that a dead letter carries a reason must still hold.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'notify' and p.proname = 'record_send_outcome'
      and p.prosecdef and p.proconfig @> array['search_path=""']
  ) then
    raise exception
      'notify.record_send_outcome is no longer SECURITY DEFINER with a pinned search_path';
  end if;

  if has_function_privilege(
       'public',
       'notify.record_send_outcome(uuid, text, text, text, timestamptz)',
       'execute') then
    raise exception 'PUBLIC can execute notify.record_send_outcome';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'notify.outbox'::regclass
      and conname = 'outbox_failure_has_a_reason'
  ) then
    raise exception 'the constraint requiring a dead letter to say why has gone';
  end if;
end $$;
