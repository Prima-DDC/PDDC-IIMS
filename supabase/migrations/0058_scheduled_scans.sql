-- ---------------------------------------------------------------------------
-- 0058: the notifications nobody triggers.
--
-- Three of PRD 12.1's categories have no action behind them. Nobody clicks
-- "my task is overdue"; the deadline simply passes. They have to be found by
-- looking, which means a scan on a schedule, and a scan on a schedule needs
-- one thing the request-driven producers do not: it must be safe to run
-- again.
--
-- IDEMPOTENCE, AS A KEY ON THE ROW. A scan that runs hourly and notified on
-- what it found would tell somebody about the same overdue task twenty-four
-- times a day, and the only thing that teaches is to ignore the feed. So
-- `notify.notifications` gains a `source_key`: a caller's own name for the
-- thing being notified about, unique per recipient and category. Publishing
-- twice under one key does nothing the second time and says so by returning
-- null.
--
-- The key is the caller's to choose, and choosing it is the real design
-- decision in each scan below:
--
--   an overdue task is keyed on the task, so it is announced once and not
--   once per scan;
--
--   an approaching deadline is keyed on the task AND the due date, so moving
--   a deadline out and back in again is a fresh warning rather than silence;
--
--   a missed check-in is keyed on the check-in that was missed, so one
--   failure to report is one alert however long it lasts.
--
-- This also makes every request-driven producer idempotent for free, which
-- is what PRD 21.7 asks of a retried request: two submissions of the same
-- assignment under the same key produce one notification.
-- ---------------------------------------------------------------------------

alter table notify.notifications
  add column if not exists source_key text;

comment on column notify.notifications.source_key is
  'The caller''s own name for what this is about, unique per recipient and '
  'category. Scans use it so a repeated run does not repeat itself, and a '
  'retried request uses it so a retry does not duplicate.';

-- Partial, because only a keyed notification is constrained. Most are
-- one-off events that neither need a key nor should collide.
create unique index if not exists notifications_source_key_idx
  on notify.notifications (recipient_id, category, source_key)
  where source_key is not null;

-- ---------------------------------------------------------------------------
-- Publishing, now with a key.
--
-- The signature grows one optional argument at the end, so every existing
-- caller is unaffected. The body is otherwise 0056's.
-- ---------------------------------------------------------------------------
create or replace function notify.publish(
  p_recipient  uuid,
  p_category   text,
  p_title      text,
  p_detail     text default null,
  p_case_id    uuid default null,
  p_link       text default null,
  p_email      jsonb default null,
  p_source_key text default null
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
  v_label       text;
  v_want_in_app boolean;
  v_want_email  boolean;
  v_email       text;
  v_name        text;
  v_params      jsonb;
  v_id          uuid;
begin
  if v_actor is null and v_system is null then
    raise exception
      'a notification needs an identified actor or a named system process'
      using errcode = 'insufficient_privilege';
  end if;

  select c.is_mandatory, c.label
  into v_mandatory, v_label
  from notify.categories c
  where c.key = p_category;

  if v_mandatory is null then
    raise exception 'there is no notification category %', p_category
      using errcode = 'foreign_key_violation';
  end if;

  if not v_mandatory and p_recipient = v_actor then
    return null;
  end if;

  if not exists (
    select 1 from iam.users u
    where u.id = p_recipient and u.status = 'active' and u.deleted_at is null
  ) then
    return null;
  end if;

  select
    v_mandatory or coalesce(pr.in_app, true),
    v_mandatory or coalesce(pr.email, true)
  into v_want_in_app, v_want_email
  from (select 1) as one
  left join notify.preferences pr
    on pr.user_id = p_recipient and pr.category = p_category;

  insert into notify.notifications (
    recipient_id, category, title, detail, case_id, link,
    in_app_suppressed, created_by, source_key
  )
  values (
    p_recipient, p_category, p_title, nullif(btrim(p_detail), ''),
    p_case_id, nullif(btrim(p_link), ''), not v_want_in_app, v_actor,
    nullif(btrim(p_source_key), '')
  )
  on conflict (recipient_id, category, source_key)
    where source_key is not null
    do nothing
  returning id into v_id;

  -- Already told, under the same key. Not an error and not a silent success
  -- either: null is the answer to "did this notify anybody", and it did not.
  if v_id is null then
    return null;
  end if;

  if p_email is null or not v_want_email then
    return v_id;
  end if;

  select pb.email, pb.full_name
  into v_email, v_name
  from iam.profile_basics(array[p_recipient]) pb;

  if v_email is null or position('@' in v_email) < 2 then
    return v_id;
  end if;

  v_params := coalesce(p_email, '{}'::jsonb);

  if not v_params ? 'categoryLabel' then
    v_params := v_params || jsonb_build_object('categoryLabel', v_label);
  end if;

  if not v_params ? 'recipientName' and nullif(btrim(v_name), '') is not null then
    v_params := v_params || jsonb_build_object('recipientName', btrim(v_name));
  end if;

  insert into notify.outbox (
    notification_id, idempotency_key, recipient_email, template, params
  )
  values (
    v_id, 'pddc-iims:' || v_id::text, v_email, p_category, v_params
  );

  return v_id;
end
$$;

comment on function notify.publish(uuid, text, text, text, uuid, text, jsonb, text) is
  'PRD 12.2: writes the in-app record and, if the recipient wants it, the '
  'outbox row, inside the caller''s transaction. Returns null when there was '
  'nobody to tell or when the same source_key has already been used, so a '
  'scan and a retry are both safe to repeat.';

revoke all on function
  notify.publish(uuid, text, text, text, uuid, text, jsonb, text) from public;
grant execute on function
  notify.publish(uuid, text, text, text, uuid, text, jsonb, text) to iims_app;

-- The seven-argument version is now ambiguous with the eight-argument one for
-- a seven-argument call, because the eighth has a default. Postgres resolves
-- that by preferring the exact arity, so the old function would keep taking
-- every existing call and silently ignore the key. It has to go.
drop function if exists
  notify.publish(uuid, text, text, text, uuid, text, jsonb);

-- ---------------------------------------------------------------------------
-- The scans.
--
-- All three run as a system process and publish on behalf of nobody, which
-- `publish` already allows: the audit row records the named process rather
-- than a user, which is the truth about who noticed.
--
-- Each returns how many people it told, so the route that calls it can log
-- something meaningful and a quiet scan is distinguishable from a broken one.
-- ---------------------------------------------------------------------------

create or replace function notify.require_system_process()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if nullif(current_setting('iims.system_process', true), '') is null
     or iam.current_user_id() is not null then
    raise exception 'this runs on a schedule, not from a request'
      using errcode = 'insufficient_privilege';
  end if;
end
$$;

revoke all on function notify.require_system_process() from public;
grant execute on function notify.require_system_process() to iims_app;

-- ---------------------------------------------------------------------------
-- A task whose due date has passed (PRD 12.1 "task overdue").
--
-- To its assignee, once. The supervisor is not copied: an overdue task is
-- ordinary, and a platform that reported every one of them upward would be
-- read as an accusation rather than a reminder. The management reports are
-- where somebody looks at overdue work in aggregate.
-- ---------------------------------------------------------------------------
create or replace function notify.scan_overdue_tasks()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task  record;
  v_told  integer := 0;
begin
  perform notify.require_system_process();

  for v_task in
    select t.id, t.task_id, t.title, t.assigned_to, t.due_date,
           c.id as case_id, c.case_id as case_reference
    from casework.tasks t
    join casework.cases c on c.id = t.case_id
    where t.deleted_at is null
      and t.assigned_to is not null
      and t.due_date is not null
      and t.due_date < current_date
      and t.status not in ('completed', 'cancelled')
  loop
    if notify.publish(
         v_task.assigned_to,
         'task_overdue',
         v_task.task_id || ': ' || v_task.title,
         'Due ' || v_task.due_date || ' on case ' || v_task.case_reference || '.',
         v_task.case_id,
         '/tasks/' || v_task.id::text,
         jsonb_build_object(
           'caseReference', v_task.case_reference,
           'link', '/tasks/' || v_task.id::text,
           'dueAt', v_task.due_date::text
         ),
         'task-overdue:' || v_task.id::text
       ) is not null then
      v_told := v_told + 1;
    end if;
  end loop;

  return v_told;
end
$$;

revoke all on function notify.scan_overdue_tasks() from public;
grant execute on function notify.scan_overdue_tasks() to iims_app;

-- ---------------------------------------------------------------------------
-- A deadline coming up (PRD 12.1 "deadline approaching").
--
-- Two days out, which is the shortest warning that still leaves a working
-- day to act on it. Keyed on the task AND the date, so a deadline that moves
-- out and comes back round warns again: the key says "this task, due then",
-- and that is a different fact from "this task, due on the old date".
-- ---------------------------------------------------------------------------
create or replace function notify.scan_approaching_deadlines()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task record;
  v_told integer := 0;
begin
  perform notify.require_system_process();

  for v_task in
    select t.id, t.task_id, t.title, t.assigned_to, t.due_date,
           c.id as case_id, c.case_id as case_reference
    from casework.tasks t
    join casework.cases c on c.id = t.case_id
    where t.deleted_at is null
      and t.assigned_to is not null
      and t.due_date is not null
      and t.due_date >= current_date
      and t.due_date <= current_date + 2
      and t.status not in ('completed', 'cancelled')
  loop
    if notify.publish(
         v_task.assigned_to,
         'deadline_approaching',
         v_task.task_id || ' is due ' || v_task.due_date,
         v_task.title || ' on case ' || v_task.case_reference || '.',
         v_task.case_id,
         '/tasks/' || v_task.id::text,
         jsonb_build_object(
           'caseReference', v_task.case_reference,
           'link', '/tasks/' || v_task.id::text,
           'dueAt', v_task.due_date::text
         ),
         'deadline:' || v_task.id::text || ':' || v_task.due_date::text
       ) is not null then
      v_told := v_told + 1;
    end if;
  end loop;

  return v_told;
end
$$;

revoke all on function notify.scan_approaching_deadlines() from public;
grant execute on function notify.scan_approaching_deadlines() to iims_app;

-- ---------------------------------------------------------------------------
-- A missed safety check-in (PRD 5.8).
--
-- The one notification in this platform where being late matters, so it is
-- the one with the widest audience: the person who is out, everybody on the
-- case in a supervisory role, and whoever holds `cases:assign`, which is the
-- permission the Operations Manager has and PRD 5.8 names explicitly.
--
-- A check-in is missed when the latest event for somebody on a case is a
-- check_in whose `next_due_at` has passed. A check_out ends the obligation,
-- which is what checking out means, and the latest row is the only one that
-- can be late: an earlier one has already been answered by the one after it.
--
-- This is a mandatory category, so preferences do not apply to it and
-- `publish` ignores them. It is also why the person who is out is told as
-- well: if their phone is working, a notification is the cheapest possible
-- prompt, and if it is not, somebody else has had the same alert.
-- ---------------------------------------------------------------------------
create or replace function notify.scan_missed_check_ins()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_late      record;
  v_recipient uuid;
  v_told      integer := 0;
  v_minutes   integer;
  v_title     text;
begin
  perform notify.require_system_process();

  for v_late in
    select distinct on (ci.case_id, ci.user_id)
           ci.id, ci.case_id, ci.user_id, ci.next_due_at, ci.location,
           c.case_id as case_reference,
           coalesce(nullif(btrim(p.full_name), ''), p.email) as person
    from casework.check_ins ci
    join casework.cases c on c.id = ci.case_id
    left join public.profiles p on p.id = ci.user_id
    order by ci.case_id, ci.user_id, ci.seq desc
  loop
    continue when v_late.next_due_at is null or v_late.next_due_at > now();

    -- The latest event has to be the check_in itself, which the ordering
    -- above does not guarantee: a check_out is also the latest row for
    -- somebody who came back, and it carries no obligation.
    continue when not exists (
      select 1 from casework.check_ins c2
      where c2.id = v_late.id and c2.event = 'check_in'
    );

    v_minutes := greatest(1, (extract(epoch from now() - v_late.next_due_at) / 60)::integer);
    v_title := coalesce(v_late.person, 'Somebody')
               || ' has missed a check-in on ' || v_late.case_reference;

    for v_recipient in
      -- The person who is out.
      select v_late.user_id
      union
      -- Everybody supervising the case.
      select a.user_id
      from casework.case_assignments a
      where a.case_id = v_late.case_id
        and a.unassigned_at is null
        and a.role in ('supervisor', 'operations_manager', 'lead_investigator')
      union
      -- And whoever can staff a case, which is PRD 5.8's Operations Manager.
      select h.id from iam.permission_holders('cases', 'assign') h
    loop
      if notify.publish(
           v_recipient,
           'safety_check_in_missed',
           v_title,
           'Due ' || to_char(v_late.next_due_at, 'DD Mon YYYY HH24:MI')
             || ', ' || v_minutes || ' minutes ago'
             || coalesce('. Last known location: ' || v_late.location, '') || '.',
           v_late.case_id,
           '/cases/' || v_late.case_id::text,
           jsonb_build_object(
             'caseReference', v_late.case_reference,
             'link', '/cases/' || v_late.case_id::text,
             'dueAt', to_char(v_late.next_due_at, 'YYYY-MM-DD HH24:MI')
           ),
           'missed-check-in:' || v_late.id::text
         ) is not null then
        v_told := v_told + 1;
      end if;
    end loop;
  end loop;

  return v_told;
end
$$;

revoke all on function notify.scan_missed_check_ins() from public;
grant execute on function notify.scan_missed_check_ins() to iims_app;

-- ---------------------------------------------------------------------------
-- Assertions.
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad text;
begin
  select string_agg(p.proname, ', ')
  into v_bad
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'notify'
    and p.proname in ('publish', 'require_system_process', 'scan_overdue_tasks',
                      'scan_approaching_deadlines', 'scan_missed_check_ins')
    and not (p.prosecdef and p.proconfig @> array['search_path=""']);

  if v_bad is not null then
    raise exception
      'these notify functions are not SECURITY DEFINER with a pinned search_path: %',
      v_bad;
  end if;

  select string_agg(p.proname, ', ')
  into v_bad
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'notify'
    and p.proname in ('publish', 'require_system_process', 'scan_overdue_tasks',
                      'scan_approaching_deadlines', 'scan_missed_check_ins')
    and has_function_privilege('public', p.oid, 'execute');

  if v_bad is not null then
    raise exception 'PUBLIC can execute: %', v_bad;
  end if;

  -- Exactly one `publish`, so no call site can reach a version that ignores
  -- the source key. This is the thing most likely to have gone wrong above.
  if (select count(*) from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'notify' and p.proname = 'publish') <> 1 then
    raise exception 'there is more than one notify.publish, so a call could reach the wrong one';
  end if;

  -- And the scans refuse a request-shaped caller, which is what stops a page
  -- from mailing the whole staff list.
  perform set_config('iims.user_id', gen_random_uuid()::text, true);
  perform set_config('iims.system_process', 'probe', true);

  begin
    perform notify.scan_overdue_tasks();
    raise exception 'a request-shaped caller ran the overdue scan';
  exception
    when insufficient_privilege then null;
  end;

  perform set_config('iims.user_id', '', true);
  perform set_config('iims.system_process', '', true);
end $$;
