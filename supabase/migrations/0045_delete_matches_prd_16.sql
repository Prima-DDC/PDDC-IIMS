-- ---------------------------------------------------------------------------
-- 0045: bring soft delete back in line with PRD 16's default matrix.
--
-- PRD 16 uses X, its letter for a restricted soft delete, in exactly one cell
-- of the whole matrix: "Users and roles" for CEO/Admin. On the Clients and
-- engagements row and the Cases row the Operations Manager has `V C E A`, so
-- no delete. The seed granted them `cases:delete`, `clients:delete` and
-- `engagements:delete` anyway, which is wider than the document's own stated
-- default.
--
-- The grants are removed; the permission rows stay. That distinction is the
-- point. PRD 16 calls the matrix "the default starting set" that an
-- administrator may change through the Permission Builder (PRD 3.3), so the
-- right end state is a permission that exists, is held by the administrator
-- through the wildcard, and can be granted to a role by PDDC as a decision
-- somebody makes and the audit trail records. Deleting the catalogue rows
-- would take that choice away.
--
-- What this costs: an Operations Manager can no longer send a case, client or
-- engagement to the recycle bin. The recycle bin itself already lives under
-- Administration, so the screen does not move; what changes is that the
-- delete control stops being offered on those three, which is the UI telling
-- the truth about what the server would allow. Restoring and purging were
-- already gated behind the same permissions.
--
-- Nothing is deleted here and nothing becomes unreachable: every record a
-- manager could previously soft-delete is still readable, editable and
-- closeable by them.
-- ---------------------------------------------------------------------------

delete from iam.role_permissions rp
using iam.roles r, iam.permissions p
where rp.role_id = r.id
  and rp.permission_id = p.id
  and r.key = 'operations_manager'
  and p.action = 'delete'
  and p.resource in ('cases', 'clients', 'engagements');

-- Permission changes take effect without signing out again (PRD 3.4), which
-- is only true because every request reads this version.
update iam.users u
set permissions_version = u.permissions_version + 1
where exists (
  select 1
  from iam.user_roles ur
  join iam.roles r on r.id = ur.role_id
  where ur.user_id = u.id and r.key = 'operations_manager'
);

-- ---------------------------------------------------------------------------
-- Assertions.
-- ---------------------------------------------------------------------------
do $$
declare
  v_left text;
begin
  -- No non-administrator role holds a delete on these three any more.
  select string_agg(distinct r.key || ' -> ' || p.resource, ', ')
  into v_left
  from iam.roles r
  join iam.role_permissions rp on rp.role_id = r.id
  join iam.permissions p on p.id = rp.permission_id
  where p.action = 'delete'
    and p.resource in ('cases', 'clients', 'engagements')
    and r.is_administrator is not true;

  if v_left is not null then
    raise exception 'a non-administrator role still holds a delete: %', v_left;
  end if;

  -- The catalogue rows survive, so PDDC can grant them deliberately later.
  if (
    select count(*)
    from iam.permissions
    where action = 'delete' and resource in ('cases', 'clients', 'engagements')
  ) = 0 then
    raise exception 'the delete permissions were removed from the catalogue, not just ungranted';
  end if;

  -- The manager keeps what PRD 16 does give them on a case, including the
  -- archive step that closure depends on. Removing a delete must not have
  -- touched any of it.
  if not exists (
    select 1
    from iam.roles r
    join iam.role_permissions rp on rp.role_id = r.id
    join iam.permissions p on p.id = rp.permission_id
    where r.key = 'operations_manager'
      and p.resource = 'cases'
      and p.action in ('close', 'archive', 'approve', 'edit', 'create', 'assign')
    group by r.key
    having count(distinct p.action) = 6
  ) then
    raise exception 'the operations manager lost a case permission PRD 16 grants them';
  end if;
end $$;
