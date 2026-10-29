-- PDDC IIMS 0024 : the no-erasure rule, as a reusable convention.
--
-- 0021 revoked DELETE and TRUNCATE on `crm` by hand, and the reasoning applies
-- to every schema that holds case content: PRD 3.5 makes removal a soft delete
-- that moves a record to the recycle bin, so the application never needs to
-- erase a row. `iam` is the exception, where removing a role assignment or an
-- override genuinely is a deletion and keeping tombstones of them would make
-- the effective-permission calculation harder to read rather than safer.
--
-- Doing it per schema by hand would mean remembering it four more times, for
-- casework, intel, evidence, docs, reporting and notify. So it becomes a
-- function the later milestones call, and `casework` is its first caller.

create or replace function config.revoke_erasure(p_schema text)
  returns void
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v_table record;
  v_bad   text;
begin
  if p_schema = 'iam' then
    raise exception
      'iam deliberately keeps DELETE: removing a role assignment or an override is a deletion, not a state change.';
  end if;

  -- Existing tables.
  for v_table in
    select tablename from pg_catalog.pg_tables where schemaname = p_schema
  loop
    execute format('revoke delete, truncate on %I.%I from iims_app',
                   p_schema, v_table.tablename);
  end loop;

  -- And tables added later: default privileges apply only to objects created
  -- after they are set, which is exactly what stops a new table in a later
  -- milestone from quietly inheriting a DELETE nothing wants it to have.
  execute format(
    'alter default privileges for role postgres in schema %I '
    'revoke delete on tables from iims_app', p_schema);

  -- Assert the outcome rather than trusting the loop, so a change elsewhere
  -- that re-widens the grant fails here instead of silently.
  select string_agg(table_name || ':' || privilege_type, ', ')
  into v_bad
  from information_schema.table_privileges
  where grantee = 'iims_app'
    and table_schema = p_schema
    and privilege_type in ('DELETE', 'TRUNCATE');

  if v_bad is not null then
    raise exception
      'iims_app still holds erasing privileges in %: %', p_schema, v_bad;
  end if;
end
$$;

comment on function config.revoke_erasure(text) is
  'Removes DELETE and TRUNCATE from iims_app on a schema and on anything '
  'added to it later, then asserts the result. Called once per content schema; '
  'refuses iam, which needs DELETE (PRD 3.5).';

-- casework is the first caller. crm was done by hand in 0021 and is re-run
-- here so both schemas are governed by the same code rather than by one
-- migration each.
select config.revoke_erasure('crm');
select config.revoke_erasure('casework');

comment on schema casework is
  'Cases, tasks, activities and closure (PRD 5, 9). The application role holds '
  'no DELETE or TRUNCATE here: removal is a soft delete, assignments record '
  'their own removal, and activities and scope versions are append-only.';
