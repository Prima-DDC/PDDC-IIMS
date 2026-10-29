-- PDDC IIMS 0016 : extension access for the application role.
--
-- TWO PROBLEMS, ONE CAUSE
--
-- 1. audit.write (0015) called extensions.gen_random_uuid(), and iims_app has
--    no USAGE on the `extensions` schema, so it failed with
--    "permission denied for schema extensions". Caught by the containment
--    test that calls audit.write as the application role.
--
--    gen_random_uuid() has been a Postgres BUILT-IN since version 13, living
--    in pg_catalog, which is always on the search path. Calling it unqualified
--    needs no extension and no grant, so that is what this does. The column
--    defaults that reference extensions.gen_random_uuid() are evaluated with
--    the table owner's rights and keep working either way.
--
-- 2. config.immutable_unaccent() runs with INVOKER rights and calls
--    extensions.unaccent(). Nothing exercises it yet, but the conflict
--    screening in the next milestone will call it, together with the pg_trgm
--    similarity function, from ordinary application queries. Those would have
--    failed the same way.
--
-- So USAGE on `extensions` is granted explicitly. It conveys the ability to
-- call the extension functions, not to read any data, and the IIMS boundary
-- rules are unaffected: the containment check asserts privileges on TABLES,
-- and this grants none.

grant usage on schema extensions to iims_app;

-- Specific function grants, so a future revoke of blanket PUBLIC execute does
-- not silently break conflict matching.
grant execute on function extensions.unaccent(text) to iims_app;
grant execute on function extensions.unaccent(regdictionary, text) to iims_app;
grant execute on function extensions.similarity(text, text) to iims_app;
grant execute on function extensions.digest(bytea, text) to iims_app;
grant execute on function extensions.digest(text, text) to iims_app;
grant execute on function config.immutable_unaccent(text) to iims_app;

-- ---------------------------------------------------------------------------
-- audit.write, using the built-in uuid generator.
-- ---------------------------------------------------------------------------
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
  -- pg_catalog is always searched, so this resolves with an empty search_path
  -- and needs no extension.
  v_id    uuid := gen_random_uuid();
  v_actor uuid := nullif(current_setting('iims.user_id', true), '')::uuid;
  v_req   uuid := nullif(current_setting('iims.request_id', true), '')::uuid;
  v_sys   text := nullif(current_setting('iims.system_process', true), '');
begin
  if v_actor is null and v_sys is null then
    raise exception
      'audit.write requires an identified actor: call it inside withActor() or withSystemActor()'
      using errcode = 'insufficient_privilege';
  end if;

  -- No RETURNING clause: reading the row back would need SELECT, which the
  -- application role deliberately does not have (see 0015).
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

-- The access log has the same shape of insert; it never used RETURNING, but
-- make its id generation consistent and extension-free too.
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

  insert into audit.access_log (access_id, actor_user_id, resource, resource_id,
                                case_id, action, ip, user_agent, correlation_id)
  values (
    gen_random_uuid(), v_actor, p_resource, p_resource_id, p_case_id, p_action,
    nullif(current_setting('iims.ip', true), '')::inet,
    nullif(current_setting('iims.user_agent', true), ''),
    nullif(current_setting('iims.request_id', true), '')::uuid
  );
end
$$;

grant execute on function audit.record_access(text, text, uuid, text) to iims_app;
