-- ---------------------------------------------------------------------------
-- 0046: a role that may merge entities must also be able to edit them.
--
-- Migration 0036 granted `entities:merge` to the Supervisor and the
-- Operations Manager, reading PRD 8.4's "merging requires authorised
-- confirmation" as a supervisory act. For the Supervisor that is right: PRD
-- 16 gives them `V C E` on Subjects/entities, so they can do the thing the
-- permission authorises. For the Operations Manager it is not. PRD 16 gives
-- them `V` on that row, and a merge is not a single write to one flag: it
-- moves aliases, case subjects, relationships, information and finding links
-- onto the surviving record and then updates both entities. Every one of
-- those tables requires `entities:edit` at the policy level.
--
-- So the Operations Manager held a permission that could never complete.
-- Found by the end-to-end journey performing the merge as the role PRD 16
-- gives it to, which is the only way it could have been found: each of the
-- three gates looked correct on its own, the application checks passed, and
-- the refusal came from row-level security six tables into the operation.
--
-- The tempting fix was to let `entities:merge` satisfy those six policies.
-- That is rejected. It would give the Operations Manager write access to the
-- whole entity graph at all times, not just while merging, which is far
-- wider than the `V` PRD 16 gives them and exactly the kind of over-grant
-- migration 0045 has just removed elsewhere. A permission is not a licence to
-- rewrite everything the operation it names happens to touch.
--
-- PRD 8.4 names no role, PRD 16 gives the Supervisor the edit rights a merge
-- needs, and the Administrator has it through the wildcard. That is the
-- authority the document describes, so that is who keeps it.
-- ---------------------------------------------------------------------------

delete from iam.role_permissions rp
using iam.roles r, iam.permissions p
where rp.role_id = r.id
  and rp.permission_id = p.id
  and r.key = 'operations_manager'
  and p.resource = 'entities'
  and p.action = 'merge';

update iam.users u
set permissions_version = u.permissions_version + 1
where exists (
  select 1
  from iam.user_roles ur
  join iam.roles r on r.id = ur.role_id
  where ur.user_id = u.id and r.key = 'operations_manager'
);

-- ---------------------------------------------------------------------------
-- The invariant, asserted rather than trusted.
--
-- This is the part that matters more than the delete. PRD 16 lets an
-- administrator change any cell through the Permission Builder, so somebody
-- can grant `entities:merge` to a view-only role again next year and
-- reintroduce precisely this bug: a control that appears, an application
-- check that passes, and a database that refuses. Stating the dependency here
-- means the next migration that breaks it fails loudly at deploy time.
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad text;
begin
  select string_agg(r.key, ', ')
  into v_bad
  from iam.roles r
  where r.is_administrator is not true
    and exists (
      select 1 from iam.role_permissions rp
      join iam.permissions p on p.id = rp.permission_id
      where rp.role_id = r.id and p.resource = 'entities' and p.action = 'merge'
    )
    and not exists (
      select 1 from iam.role_permissions rp
      join iam.permissions p on p.id = rp.permission_id
      where rp.role_id = r.id and p.resource = 'entities' and p.action = 'edit'
    );

  if v_bad is not null then
    raise exception
      'these roles hold entities:merge without entities:edit, so a merge would be refused by row-level security partway through: %',
      v_bad;
  end if;

  -- And the authority PRD 8.4 requires still exists: removing the wrong
  -- grant must not have left nobody able to resolve a duplicate.
  if not exists (
    select 1
    from iam.roles r
    join iam.role_permissions rp on rp.role_id = r.id
    join iam.permissions p on p.id = rp.permission_id
    where p.resource = 'entities' and p.action = 'merge'
  ) then
    raise exception 'no role can merge entities any more, which PRD 8.4 requires somebody to be able to do';
  end if;
end $$;
