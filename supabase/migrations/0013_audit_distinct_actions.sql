-- PDDC IIMS 0013 : the action list for the audit filter.
--
-- The audit screen needs the distinct action names to populate its filter,
-- but iims_app holds INSERT only on audit.audit_log, so a plain
-- `select distinct action from audit.audit_log` fails with
-- "permission denied for table audit_log".
--
-- Found by the end-to-end suite: the administration overview rendered, but
-- the server logged a 42501 and the filter came back empty. Every other read
-- of the trail already goes through a SECURITY DEFINER function; this one was
-- the exception, and it should not have been.
--
-- Unlike read_audit_log this does NOT write an access-log entry: it exposes
-- the vocabulary of action names, not any record, and logging a dropdown
-- being populated would bury the reads that matter.

create or replace function audit.distinct_actions()
  returns setof text
  language plpgsql
  stable
  security definer
  set search_path = ''
as $$
begin
  if not iam.has_permission('audit', 'view') then
    raise exception 'not permitted to read the audit trail'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select distinct a.action from audit.audit_log a order by a.action;
end
$$;

grant execute on function audit.distinct_actions() to iims_app;
