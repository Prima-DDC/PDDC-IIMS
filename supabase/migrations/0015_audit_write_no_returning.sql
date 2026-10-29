-- PDDC IIMS 0015 : audit.write must not use INSERT ... RETURNING.
--
-- THE BUG THIS FIXES
-- audit.write ended with `insert into audit.audit_log (...) returning
-- audit_id into v_id`. RETURNING reads the row back, so it requires SELECT on
-- the table, and iims_app deliberately holds INSERT only. Every audit write
-- from the application therefore failed with
--
--     permission denied for table audit_log
--
-- which meant edits in the administration screens failed outright. The
-- integration tests missed it because they drive the repository through a
-- `postgres` connection, which has BYPASSRLS and full privileges; the
-- containment test missed it because it inserts directly without RETURNING.
-- Found by the end-to-end suite, editing a user in a real browser.
--
-- The fix keeps least privilege rather than working around it. Making the
-- function SECURITY DEFINER would also work, but it would mean every audit
-- write ran with the table owner's rights and the INSERT policy would stop
-- applying. Generating the id in the function instead needs no read at all,
-- so iims_app keeps INSERT-only and the RLS policy still governs the write.

create or replace function audit.write(
  p_action        text,
  p_record_type   text default null,
  p_record_id     text default null,
  p_case_id       uuid default null,
  p_before        jsonb default null,
  p_after         jsonb default null,
  p_reason        text default null,
  p_classification text default null,
  p_actor_email   text default null
)
  returns uuid
  language plpgsql
  set search_path = ''
as $$
declare
  v_id    uuid := extensions.gen_random_uuid();
  v_actor uuid := nullif(current_setting('iims.user_id', true), '')::uuid;
  v_req   uuid := nullif(current_setting('iims.request_id', true), '')::uuid;
  v_sys   text := nullif(current_setting('iims.system_process', true), '');
begin
  -- Either a user or a named system process must own every action. An
  -- anonymous audit row would be worse than none: it would look accountable
  -- while naming nobody.
  if v_actor is null and v_sys is null then
    raise exception
      'audit.write requires an identified actor: call it inside withActor() or withSystemActor()'
      using errcode = 'insufficient_privilege';
  end if;

  -- The id is generated here and inserted explicitly, so no RETURNING clause
  -- is needed and no SELECT privilege is required.
  insert into audit.audit_log (
    audit_id, actor_user_id, actor_email, action, record_type, record_id,
    case_id, ip, user_agent, before_value, after_value, reason,
    correlation_id, classification
  )
  values (
    v_id,
    v_actor,
    coalesce(p_actor_email, case when v_sys is not null then 'system:' || v_sys end),
    p_action, p_record_type, p_record_id, p_case_id,
    nullif(current_setting('iims.ip', true), '')::inet,
    nullif(current_setting('iims.user_agent', true), ''),
    p_before, p_after, p_reason, v_req,
    coalesce(p_classification, nullif(current_setting('iims.classification', true), ''))
  );

  return v_id;
end
$$;

grant execute on function audit.write(text, text, text, uuid, jsonb, jsonb, text, text, text)
  to iims_app;

comment on function audit.write(text, text, text, uuid, jsonb, jsonb, text, text, text) is
  'Appends an audit row. Runs with invoker rights so the INSERT policy applies, '
  'and never uses RETURNING, because the application role holds no SELECT on '
  'the audit trail.';
