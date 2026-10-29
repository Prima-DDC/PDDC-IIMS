-- PDDC IIMS 0008: the audit write helper.
--
-- Application code never INSERTs into audit.audit_log directly. It calls
-- audit.write(), which fills the actor, correlation id and classification from
-- the transaction-local settings that withActor() published. That means an
-- audit row cannot be written with a forged actor, and it cannot be forgotten
-- in the shape of its columns.
--
-- Not SECURITY DEFINER: iims_app already holds INSERT, and keeping the
-- invoker's rights means the INSERT policy still applies.

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
  v_id    uuid;
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

  insert into audit.audit_log (
    actor_user_id, actor_email, action, record_type, record_id, case_id,
    ip, user_agent, before_value, after_value, reason, correlation_id,
    classification
  )
  values (
    v_actor,
    coalesce(p_actor_email, case when v_sys is not null then 'system:' || v_sys end),
    p_action, p_record_type, p_record_id, p_case_id,
    nullif(current_setting('iims.ip', true), '')::inet,
    nullif(current_setting('iims.user_agent', true), ''),
    p_before, p_after, p_reason, v_req,
    coalesce(p_classification, nullif(current_setting('iims.classification', true), ''))
  )
  returning audit_id into v_id;

  return v_id;
end
$$;

grant execute on function audit.write(text, text, text, uuid, jsonb, jsonb, text, text, text)
  to iims_app;

/**
 * Records a read of a protected resource (PRD §13: evidence and document
 * access, downloads and exports are all logged).
 */
create or replace function audit.record_access(
  p_resource    text,
  p_resource_id text default null,
  p_case_id     uuid default null,
  p_action      text default 'view'
)
  returns void
  language plpgsql
  set search_path = ''
as $$
declare
  v_actor uuid := nullif(current_setting('iims.user_id', true), '')::uuid;
begin
  if v_actor is null then
    raise exception 'audit.record_access requires an identified actor'
      using errcode = 'insufficient_privilege';
  end if;

  insert into audit.access_log (actor_user_id, resource, resource_id, case_id, action,
                                ip, user_agent, correlation_id)
  values (
    v_actor, p_resource, p_resource_id, p_case_id, p_action,
    nullif(current_setting('iims.ip', true), '')::inet,
    nullif(current_setting('iims.user_agent', true), ''),
    nullif(current_setting('iims.request_id', true), '')::uuid
  );
end
$$;

grant execute on function audit.record_access(text, text, uuid, text) to iims_app;

-- ---------------------------------------------------------------------------
-- Reading the audit trail requires the audit permission. read_audit_log() is
-- SECURITY DEFINER (it must see rows iims_app cannot SELECT), so the
-- permission check has to live inside it rather than in a policy.
-- ---------------------------------------------------------------------------
create or replace function audit.read_audit_log(
  p_case_id     uuid    default null,
  p_actor       uuid    default null,
  p_action      text    default null,
  p_from        timestamptz default null,
  p_to          timestamptz default null,
  p_limit       int     default 100,
  p_before_seq  bigint  default null
)
  returns setof audit.audit_log
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v_reader uuid := nullif(current_setting('iims.user_id', true), '')::uuid;
begin
  if v_reader is null then
    raise exception 'audit read requires an identified reader'
      using errcode = 'insufficient_privilege';
  end if;

  -- Case-scoped readers (e.g. Supervisor, PRD §16) may read their case's
  -- entries; a global read needs the unscoped audit permission.
  if not iam.has_permission('audit', 'view') then
    raise exception 'not permitted to read the audit trail'
      using errcode = 'insufficient_privilege';
  end if;

  if p_case_id is null and iam.permission_scope('audit', 'view') not in ('all','country','office') then
    raise exception 'your audit access is case-scoped: supply a case id'
      using errcode = 'insufficient_privilege';
  end if;

  insert into audit.access_log (actor_user_id, resource, case_id, action, correlation_id)
  values (v_reader, 'audit.audit_log', p_case_id, 'search',
          nullif(current_setting('iims.request_id', true), '')::uuid);

  return query
  select *
  from audit.audit_log a
  where (p_case_id is null or a.case_id = p_case_id)
    and (p_actor is null or a.actor_user_id = p_actor)
    and (p_action is null or a.action = p_action)
    and (p_from is null or a.occurred_at >= p_from)
    and (p_to is null or a.occurred_at <= p_to)
    and (p_before_seq is null or a.seq < p_before_seq)
  order by a.seq desc
  limit least(coalesce(p_limit, 100), 500);
end
$$;

grant execute on function
  audit.read_audit_log(uuid, uuid, text, timestamptz, timestamptz, int, bigint)
to iims_app;
