-- ---------------------------------------------------------------------------
-- 0053: notifications (PRD 12).
--
-- Four tables, and the shape of them is the requirement rather than a detail.
--
-- `notifications` is the in-app record and the durable one. It is what a
-- person sees in their feed, and it survives whatever happens to the email.
--
-- `outbox` is the email queue. PRD 12.2 asks for a transactional outbox so
-- that "no email is lost or sent for a rolled-back action": the business
-- action writes the row in its own transaction, and a worker sends later.
-- Nothing is sent inline, ever, because an action that emailed before it
-- committed would be announcing something that might not have happened.
--
-- THE CONFIDENTIALITY RULE IS STRUCTURAL. PRD 12.2 says emails "carry no case
-- detail beyond Case ID and a secure link; evidence, findings and subject
-- names are never put in email bodies". A rule like that cannot survive being
-- a convention, because the first person in a hurry writes the subject's name
-- into a subject line. So the outbox has nowhere to put case content: it
-- stores a template key and a `params` jsonb whose keys are restricted by a
-- CHECK constraint to a fixed, safe set. There is no `body` column. Rendering
-- happens in the worker from the template, so the only way to leak a name
-- into an email is to add a key to that constraint, in a migration, on
-- purpose.
--
-- `preferences` is per user per category, and PRD 12.2 says security alerts
-- cannot be disabled. That is enforced by a CHECK, not by the screen.
--
-- `delivery_events` is the Resend webhook trail: queued, sent, delivered,
-- bounced, failed. Append-only, because it is a delivery record.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The catalogue of PRD 12.1, as data.
-- ---------------------------------------------------------------------------
create table if not exists notify.categories (
  key          text primary key,
  label        text not null,
  description  text not null,
  -- PRD 12.2: "security alerts cannot be disabled".
  is_mandatory boolean not null default false,
  position     integer not null default 0
);

comment on table notify.categories is
  'PRD 12.1 catalogue. Data rather than an enum so PDDC can add a category '
  'without a release, and so preferences can reference it.';

insert into notify.categories (key, label, description, is_mandatory, position)
values
  ('case_assigned', 'New case assignment',
   'You have been assigned to a case.', false, 10),
  ('task_assigned', 'New task',
   'A task has been assigned to you.', false, 20),
  ('deadline_approaching', 'Approaching deadline',
   'Something you own is due soon.', false, 30),
  ('task_overdue', 'Overdue task',
   'A task you own has passed its due date.', false, 40),
  ('evidence_review', 'Evidence requiring review',
   'An item of evidence needs your attention.', false, 50),
  ('report_review', 'Report requiring review',
   'A report is waiting for you to read it.', false, 60),
  ('report_returned', 'Report returned',
   'A report you wrote has been sent back.', false, 70),
  ('case_status_change', 'Case status change',
   'A case you are on has moved stage.', false, 80),
  ('case_closure', 'Case closure',
   'A case you are on has been closed.', false, 90),
  ('conflict_detected', 'Conflict potentially detected',
   'A screening run found a possible conflict.', false, 100),
  ('safety_check_in_missed', 'Missed safety check-in',
   'Somebody in the field has missed a check-in.', true, 110),
  ('integrity_failure', 'Integrity check failure',
   'A stored file no longer matches its recorded hash.', true, 120),
  ('security_alert', 'Security alert',
   'Something happened to an account or a session that you have to know about.',
   true, 130)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- The in-app record.
-- ---------------------------------------------------------------------------
create table if not exists notify.notifications (
  id           uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references iam.users (id),
  category     text not null references notify.categories (key),

  -- What a person reads in the feed. This one MAY name things: it is shown
  -- inside the platform, to somebody whose permissions were checked, and the
  -- feed is useless if it cannot say what happened.
  title        text not null check (btrim(title) <> ''),
  detail       text,

  -- Where it points. A notification that cannot be acted on is noise.
  case_id      uuid references casework.cases (id),
  link         text,

  read_at      timestamptz,
  created_at   timestamptz not null default now(),
  created_by   uuid references iam.users (id)
);

comment on table notify.notifications is
  'The durable in-app record. Shown only to its recipient, and it survives '
  'whatever becomes of the email.';

create index if not exists notifications_unread_idx
  on notify.notifications (recipient_id, created_at desc)
  where read_at is null;

create index if not exists notifications_recipient_idx
  on notify.notifications (recipient_id, created_at desc);

-- ---------------------------------------------------------------------------
-- The email queue.
-- ---------------------------------------------------------------------------
create table if not exists notify.outbox (
  id              uuid primary key default gen_random_uuid(),
  notification_id uuid not null references notify.notifications (id),

  -- PRD 12.2: "each notification has a unique idempotency key, passed to
  -- Resend, so retries never duplicate emails".
  idempotency_key text not null unique,

  recipient_email text not null check (position('@' in recipient_email) > 1),

  -- NO BODY COLUMN. See the note at the top: the worker renders from the
  -- template, and `params` can only hold the keys named here, so case
  -- content has nowhere to travel.
  template        text not null,
  params          jsonb not null default '{}'::jsonb,

  status          text not null default 'queued'
    check (status in ('queued', 'sent', 'delivered', 'bounced', 'failed')),
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  provider_id     text,

  created_at      timestamptz not null default now(),
  sent_at         timestamptz,

  -- Strip the permitted keys; anything left over is a key nobody allowed.
  -- Written as an expression rather than a subquery because a CHECK cannot
  -- contain one, and the expression is the clearer statement anyway: these
  -- five keys and nothing else.
  constraint outbox_params_only_safe_keys check (
    params - array[
      'caseReference', 'link', 'categoryLabel', 'recipientName', 'dueAt'
    ]::text[] = '{}'::jsonb
  ),
  -- A dead letter has to say why it died.
  constraint outbox_failure_has_a_reason check (
    status <> 'failed' or last_error is not null
  )
);

comment on table notify.outbox is
  'PRD 12.2 transactional outbox. Written in the business action''s own '
  'transaction and drained by a worker, so nothing is sent for an action that '
  'rolled back. Carries a template and a restricted set of parameters rather '
  'than a body, so an email cannot contain case content.';

comment on column notify.outbox.params is
  'Only caseReference, link, categoryLabel, recipientName and dueAt, enforced '
  'by a CHECK. PRD 12.2 forbids evidence, findings and subject names in an '
  'email, and this is how that is kept true rather than remembered.';

create index if not exists outbox_due_idx
  on notify.outbox (next_attempt_at)
  where status = 'queued';

-- ---------------------------------------------------------------------------
-- Preferences.
-- ---------------------------------------------------------------------------
create table if not exists notify.preferences (
  user_id   uuid not null references iam.users (id),
  category  text not null references notify.categories (key),
  in_app    boolean not null default true,
  email     boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (user_id, category)
);

comment on table notify.preferences is
  'In-app and email per category (PRD 12.2). A row is only needed to turn '
  'something off: absence means on.';

-- ---------------------------------------------------------------------------
-- The delivery trail from Resend's webhooks.
-- ---------------------------------------------------------------------------
create table if not exists notify.delivery_events (
  id          bigserial primary key,
  outbox_id   uuid not null references notify.outbox (id),
  status      text not null
    check (status in ('queued', 'sent', 'delivered', 'bounced', 'failed')),
  detail      text,
  provider_id text,
  occurred_at timestamptz not null default now()
);

comment on table notify.delivery_events is
  'Append-only delivery history from the Resend webhook, so a bounce is a '
  'record rather than a changed status with no history.';

create index if not exists delivery_events_outbox_idx
  on notify.delivery_events (outbox_id, occurred_at);

-- ---------------------------------------------------------------------------
-- A mandatory category can never be switched off (PRD 12.2).
--
-- A CHECK cannot see `notify.categories`, so this is a trigger. It refuses
-- rather than silently correcting, because a screen that appeared to accept
-- the change and did not would be worse.
-- ---------------------------------------------------------------------------
create or replace function notify.refuse_disabling_mandatory()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_label text;
begin
  select label into v_label
  from notify.categories
  where key = new.category and is_mandatory;

  if v_label is not null and (new.in_app is false or new.email is false) then
    raise exception
      '% cannot be switched off: PRD 12.2 makes it mandatory', v_label
      using errcode = 'check_violation';
  end if;

  return new;
end
$$;

drop trigger if exists preferences_keep_mandatory_on on notify.preferences;
create trigger preferences_keep_mandatory_on
  before insert or update on notify.preferences
  for each row execute function notify.refuse_disabling_mandatory();

-- ---------------------------------------------------------------------------
-- Row-level security.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['categories', 'notifications', 'outbox',
                           'preferences', 'delivery_events']
  loop
    execute format('alter table notify.%I enable row level security', t);
    execute format('alter table notify.%I force  row level security', t);
  end loop;
end
$$;

-- The catalogue is a lookup: readable by anybody signed in, written by
-- migrations only.
drop policy if exists categories_select on notify.categories;
create policy categories_select on notify.categories
  for select to iims_app
  using (iam.current_user_id() is not null);

-- A notification belongs to one person. Not even an administrator reads
-- somebody else's feed from here: it is their correspondence, and the audit
-- trail is where oversight belongs.
drop policy if exists notifications_select on notify.notifications;
create policy notifications_select on notify.notifications
  for select to iims_app
  using (recipient_id = iam.current_user_id());

drop policy if exists notifications_insert on notify.notifications;
create policy notifications_insert on notify.notifications
  for insert to iims_app
  with check (iam.current_user_id() is not null);

-- Marking your own as read is the only update anybody makes.
drop policy if exists notifications_update on notify.notifications;
create policy notifications_update on notify.notifications
  for update to iims_app
  using (recipient_id = iam.current_user_id())
  with check (recipient_id = iam.current_user_id());

-- The outbox is infrastructure. A business action inserts into it; nobody
-- reads it through the application, because it is a queue of addresses and
-- not somebody's mail.
drop policy if exists outbox_insert on notify.outbox;
create policy outbox_insert on notify.outbox
  for insert to iims_app
  with check (iam.current_user_id() is not null);

drop policy if exists delivery_events_insert on notify.delivery_events;
create policy delivery_events_insert on notify.delivery_events
  for insert to iims_app
  with check (iam.current_user_id() is not null);

-- Your own preferences, and only your own.
drop policy if exists preferences_select on notify.preferences;
create policy preferences_select on notify.preferences
  for select to iims_app
  using (user_id = iam.current_user_id());

drop policy if exists preferences_write on notify.preferences;
create policy preferences_write on notify.preferences
  for all to iims_app
  using (user_id = iam.current_user_id())
  with check (user_id = iam.current_user_id());

-- ---------------------------------------------------------------------------
-- Privileges. Notifications and the delivery trail are history.
-- ---------------------------------------------------------------------------
select config.revoke_erasure('notify');

-- A preference row is genuinely deletable: removing it means "back to the
-- default", which is the only way to say that.
grant delete on notify.preferences to iims_app;

-- Nothing updates the delivery trail or a sent notification's text.
revoke update on notify.delivery_events from iims_app;

-- ---------------------------------------------------------------------------
-- Assertions.
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad text;
begin
  -- RLS enabled AND forced everywhere: the owner is postgres, which bypasses
  -- its own policies without FORCE.
  select string_agg(c.relname, ', ')
  into v_bad
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'notify' and c.relkind = 'r'
    and not (c.relrowsecurity and c.relforcerowsecurity);

  if v_bad is not null then
    raise exception 'row-level security is not enabled and forced on: %', v_bad;
  end if;

  -- The outbox cannot be given case content. This is the confidentiality
  -- rule of PRD 12.2, so it is tested rather than trusted.
  begin
    insert into notify.outbox (
      notification_id, idempotency_key, recipient_email, template, params
    ) values (
      gen_random_uuid(), 'probe', 'probe@example.invalid', 'probe',
      '{"subjectName": "Someone Real"}'::jsonb
    );
    raise exception 'the outbox accepted a parameter naming a subject';
  exception
    when check_violation then null;       -- refused, which is the point
    when foreign_key_violation then
      raise exception
        'the outbox checked the foreign key before the parameter keys, so the confidentiality constraint was not exercised';
  end;

  -- And no table in notify can be erased by the application except
  -- preferences.
  select string_agg(t, ', ')
  into v_bad
  from unnest(array['notifications', 'outbox', 'delivery_events', 'categories']) as t
  where has_table_privilege('iims_app', 'notify.' || t, 'delete');

  if v_bad is not null then
    raise exception 'iims_app can delete from: %', v_bad;
  end if;

  if not has_table_privilege('iims_app', 'notify.preferences', 'delete') then
    raise exception 'a preference cannot be reset to its default';
  end if;
end $$;
