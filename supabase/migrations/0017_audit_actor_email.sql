-- PDDC IIMS 0017 : record who performed every audited action, by name.
--
-- THE BUG THIS FIXES
-- audit.write set actor_email only when the caller passed one, and no caller
-- ever did. Every row written by a person therefore had actor_user_id set but
-- actor_email null, and the audit screen renders a null email as "system".
-- So the trail showed real human actions as if the platform had done them by
-- itself, which is the opposite of what an audit trail is for.
--
-- PRD 13 requires the record to identify the user, and the whole point of the
-- trail is that it stays readable years later, when the uuid alone means
-- nothing and the person may have left.
--
-- Found by the end-to-end suite, which looked for the acting administrator's
-- address in the audit table and could not find it.
--
-- The address is resolved here rather than passed in by every caller, because
-- a field that each of fifty call sites must remember to populate is a field
-- that will be null somewhere. It is denormalised on purpose: the audit row
-- must survive the user record being removed.

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
  v_id    uuid := gen_random_uuid();
  v_actor uuid := nullif(current_setting('iims.user_id', true), '')::uuid;
  v_req   uuid := nullif(current_setting('iims.request_id', true), '')::uuid;
  v_sys   text := nullif(current_setting('iims.system_process', true), '');
  v_email text := p_actor_email;
begin
  if v_actor is null and v_sys is null then
    raise exception
      'audit.write requires an identified actor: call it inside withActor() or withSystemActor()'
      using errcode = 'insufficient_privilege';
  end if;

  if v_email is null then
    if v_actor is not null then
      -- iam.profile_basics is SECURITY DEFINER, which is what lets this read
      -- the shared directory that the application role cannot reach directly.
      select pb.email into v_email
      from iam.profile_basics(array[v_actor]) pb
      limit 1;
    elsif v_sys is not null then
      v_email := 'system:' || v_sys;
    end if;
  end if;

  -- No RETURNING clause: reading the row back would need SELECT, which the
  -- application role deliberately does not have (see 0015).
  insert into audit.audit_log (
    audit_id, actor_user_id, actor_email, action, record_type, record_id,
    case_id, ip, user_agent, before_value, after_value, reason,
    correlation_id, classification
  )
  values (
    v_id, v_actor, v_email,
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

-- ---------------------------------------------------------------------------
-- Backfill. Existing rows carry the actor id but no address, and the trail is
-- append-only, so the rows cannot be updated. Rather than leave them reading
-- as "system", the audit reader resolves a missing address at read time from
-- the actor id. New rows have it stored; old ones are resolved on the way out.
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

  if not iam.has_permission('audit', 'view') then
    raise exception 'not permitted to read the audit trail'
      using errcode = 'insufficient_privilege';
  end if;

  if p_case_id is null
     and iam.permission_scope('audit', 'view') not in ('all','country','office') then
    raise exception 'your audit access is case-scoped: supply a case id'
      using errcode = 'insufficient_privilege';
  end if;

  insert into audit.access_log (access_id, actor_user_id, resource, case_id, action,
                                correlation_id)
  values (gen_random_uuid(), v_reader, 'audit.audit_log', p_case_id, 'search',
          nullif(current_setting('iims.request_id', true), '')::uuid);

  return query
  select
    a.audit_id, a.seq, a.actor_user_id,
    -- Resolve an address for rows written before 0017 stored one. The stored
    -- row is untouched; this only affects what a reader is shown.
    coalesce(
      a.actor_email,
      (select pb.email from iam.profile_basics(array[a.actor_user_id]) pb limit 1)
    ) as actor_email,
    a.action, a.occurred_at, a.record_type, a.record_id, a.case_id, a.ip,
    a.user_agent, a.before_value, a.after_value, a.reason, a.correlation_id,
    a.classification, a.prev_hash, a.row_hash
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
