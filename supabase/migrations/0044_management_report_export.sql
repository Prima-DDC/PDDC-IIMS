-- ---------------------------------------------------------------------------
-- 0044: the permission the management reports screen was already asking for.
--
-- PRD 10.4 ends "All exportable to CSV/PDF with permission checks applied",
-- and the screen and the CSV route both check `reports:export`. That
-- permission was never in the catalogue, so `iam.has_permission` answered
-- false for every role and the only person who could open PRD 10.4 was an
-- administrator, by virtue of the administrator wildcard. The feature was
-- therefore built, reachable, and useless to the people it is for.
--
-- Reading across the firm is a different act from reading one report, which
-- is why it is its own action rather than a wider scope on `reports:view`: a
-- supervisor may read every report their team wrote without being the person
-- who takes the firm's turnaround figures out of the platform in a file.
--
-- Who gets it follows PRD 11, which is the document's own statement of who
-- sees firm-wide figures: the CEO/management dashboard, the Operations
-- Manager and the Supervisor. The supervisor's is scoped to their team,
-- because that is the scope their dashboard row describes; row-level security
-- then does the actual narrowing, so the export cannot show more than the
-- screen.
-- ---------------------------------------------------------------------------

insert into iam.permissions (resource, action, scope, classification_ceiling, description)
values
  ('reports', 'export', 'all', 'RESTRICTED',
   'Read and export the management reports across the firm (PRD 10.4).'),
  ('reports', 'export', 'team', 'RESTRICTED',
   'Read and export the management reports for your own team (PRD 10.4).')
on conflict (resource, action, scope, classification_ceiling) do nothing;

insert into iam.role_permissions (role_id, permission_id)
select r.id, p.id
from iam.roles r
cross join iam.permissions p
where p.resource = 'reports'
  and p.action = 'export'
  and (
    (r.key in ('ceo', 'coo', 'operations_manager') and p.scope = 'all')
    or (r.key = 'supervisor' and p.scope = 'team')
  )
on conflict (role_id, permission_id) do nothing;

-- Anyone holding a role whose permissions just changed has to see the change
-- without signing out again (PRD 3.4). Every request reads this version, so
-- bumping it is what makes that true.
update iam.users u
set permissions_version = u.permissions_version + 1
where exists (
  select 1
  from iam.user_roles ur
  join iam.roles r on r.id = ur.role_id
  where ur.user_id = u.id
    and r.key in ('ceo', 'coo', 'operations_manager', 'supervisor')
);

-- ---------------------------------------------------------------------------
-- Assertions, so the above is enforced rather than believed.
-- ---------------------------------------------------------------------------
do $$
declare
  v_missing text;
begin
  -- The four roles PRD 11 names can now reach PRD 10.4. Checked through the
  -- role grant rather than through iam.has_permission, because this migration
  -- runs as a role that FORCE row-level security refuses.
  select string_agg(k, ', ')
  into v_missing
  from unnest(array['ceo', 'coo', 'operations_manager', 'supervisor']) as k
  where not exists (
    select 1
    from iam.roles r
    join iam.role_permissions rp on rp.role_id = r.id
    join iam.permissions p on p.id = rp.permission_id
    where r.key = k and p.resource = 'reports' and p.action = 'export'
  );

  if v_missing is not null then
    raise exception 'reports:export was not granted to: %', v_missing;
  end if;

  -- An investigator must NOT acquire it. Their own reports are theirs to
  -- write; the firm's figures are not theirs to take out.
  if exists (
    select 1
    from iam.roles r
    join iam.role_permissions rp on rp.role_id = r.id
    join iam.permissions p on p.id = rp.permission_id
    where r.key = 'investigator'
      and p.resource = 'reports'
      and p.action = 'export'
  ) then
    raise exception 'reports:export leaked to the investigator role';
  end if;
end $$;
