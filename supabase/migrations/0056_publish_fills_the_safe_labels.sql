-- ---------------------------------------------------------------------------
-- 0056: the two email parameters nobody should have to pass.
--
-- Of the five keys an email may carry, two are not facts about the event at
-- all. `categoryLabel` is the catalogue's own label for the kind of
-- notification, and `recipientName` is the name of the person it is addressed
-- to. Both are already known to the database at the moment the row is
-- written, and making every producer pass them would have two costs:
--
--   The label would be duplicated in application code. 0053 deliberately made
--   the catalogue DATA so PDDC can relabel a category or add one without a
--   release, and that is worth nothing if a second copy of every label sits
--   in TypeScript, drifts from the first, and shows the old wording in email
--   while the screen shows the new.
--
--   The name would mean a directory lookup at every call site, for a value
--   the function is about to look up anyway: it already reads
--   `iam.profile_basics` for the address.
--
-- So `publish` fills both when the caller has not, and a caller may still
-- override either. Producers are left passing only what is actually about
-- the event: the case reference, the link, and a due date.
--
-- Nothing here widens what an email may carry. The five permitted keys are
-- unchanged and 0053's CHECK still decides; this only populates two of them
-- from the right source.
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

  -- Telling somebody what they have just done themselves is noise, so a
  -- producer may name the actor as the recipient and nothing happens. The
  -- mandatory three are exempt: an integrity failure on a file you uploaded
  -- is exactly the thing you have to be told, whoever triggered the check.
  if not v_mandatory and p_recipient = v_actor then
    return null;
  end if;

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

  if p_email is null or not v_want_email then
    return v_id;
  end if;

  -- Read inside the function and used inside the function, so neither the
  -- address nor the name travels back to the application.
  select pb.email, pb.full_name
  into v_email, v_name
  from iam.profile_basics(array[p_recipient]) pb;

  if v_email is null or position('@' in v_email) < 2 then
    return v_id;
  end if;

  -- The caller's parameters win where they were given, which keeps this a
  -- default and not an override: a producer with a better label for a
  -- particular event can still say so.
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

-- ---------------------------------------------------------------------------
-- Assertions.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'notify' and p.proname = 'publish'
      and p.prosecdef and p.proconfig @> array['search_path=""']
  ) then
    raise exception
      'notify.publish is no longer SECURITY DEFINER with a pinned search_path';
  end if;

  -- The permitted set has not changed. The whole point of the function above
  -- is that it fills two of these and invents none, so the constraint that
  -- decides is checked here rather than assumed.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'notify.outbox'::regclass
      and conname = 'outbox_params_only_safe_keys'
      and pg_get_constraintdef(oid) like '%categoryLabel%'
      and pg_get_constraintdef(oid) like '%recipientName%'
  ) then
    raise exception
      'the constraint restricting email parameters is missing or no longer covers these keys';
  end if;
end $$;
