-- PDDC IIMS 0021 : the application cannot erase anything in the CRM schema.
--
-- 0002 grants `select, insert, update, delete` on every IIMS schema except
-- `audit`, which is insert-only. That blanket grant is right for `iam`, where
-- the application genuinely deletes join rows: removing a role assignment, an
-- override or a feature grant is a deletion, not a state change, and keeping
-- tombstones of them would make the effective-permission calculation harder to
-- read rather than safer.
--
-- It is wrong for `crm`. Nothing in this schema is ever erased by the
-- application: PRD 3.5 makes removal a soft delete that moves the record to a
-- recycle bin, and PRD 4.1 keeps intake history permanently, so
-- `crm.enquiries` has no `deleted_at` to set in the first place. Every
-- repository method here applies an UPDATE.
--
-- The policies already deny it: there is no DELETE policy on any crm table, and
-- RLS denies by default, so a DELETE from `iims_app` affects zero rows today.
-- This migration removes the privilege as well, which is the stronger
-- statement and the one that survives somebody later adding a permissive
-- policy by mistake. A test in tests/integration/app-role-containment.test.ts
-- asserts it, which is how the gap was found.
--
-- TRUNCATE is revoked in the same breath. It was never granted, but it is a
-- separate privilege that row triggers do not catch, so it is worth being
-- explicit rather than relying on it having been left out.

do $$
declare
  t record;
begin
  -- Existing tables.
  for t in
    select tablename from pg_tables where schemaname = 'crm'
  loop
    execute format('revoke delete, truncate on crm.%I from iims_app', t.tablename);
  end loop;

  -- And tables added later. Default privileges apply only to objects created
  -- afterwards, so this is what stops M3's casework tables from inheriting a
  -- DELETE the application should not have. Re-granting the three that ARE
  -- wanted is clearer than revoking one from a wider grant.
  execute 'alter default privileges for role postgres in schema crm '
          'revoke delete on tables from iims_app';
end
$$;

-- Assert the outcome rather than trusting the loop, so a future change to 0002
-- that re-widens the grant fails here instead of silently.
do $$
declare
  v_bad text;
begin
  select string_agg(table_name || ':' || privilege_type, ', ')
  into v_bad
  from information_schema.table_privileges
  where grantee = 'iims_app'
    and table_schema = 'crm'
    and privilege_type in ('DELETE', 'TRUNCATE');

  if v_bad is not null then
    raise exception
      'iims_app still holds erasing privileges in crm: %. Removal in this schema is a soft delete (PRD 3.5).',
      v_bad;
  end if;
end
$$;

comment on schema crm is
  'Clients, engagements and intake (PRD 8). The application role holds no '
  'DELETE or TRUNCATE here: removal is a soft delete applied as an UPDATE, so '
  'every record stays recoverable, and intake history is kept permanently.';
