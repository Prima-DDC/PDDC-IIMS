-- ---------------------------------------------------------------------------
-- 0062: three grants and two ceilings brought back to PRD 16.
--
-- Found by `tests/integration/permission-matrix.test.ts`, which transcribes
-- PRD 16's matrix cell by cell and compares the seed against it. That
-- direction matters: a test that read the grants and asserted they were what
-- they were would have passed for ever. This is what it caught.
--
-- THREE GRANTS WIDER THAN THE MATRIX.
--
--   analyst cases:edit            PRD 16 gives the Analyst "V (assigned)" on
--                                 Cases and nothing more. An analyst does the
--                                 work on a case, which is why they have
--                                 `V C E` on tasks, entities, sources,
--                                 information and findings; editing the CASE
--                                 record is a different act, and it is the
--                                 title, the scope, the dates and the risk
--                                 rating.
--
--   supervisor cases:create       PRD 16 gives the Supervisor "V E A". Opening
--                                 a case follows engagement approval (PRD
--                                 4.1) and belongs to the Operations Manager,
--                                 who holds `V C E A`.
--
--   operations_manager            PRD 16 gives the Operations Manager "V" on
--     findings:approve            Findings. Approving a finding is the
--                                 Supervisor's "V A", and it is a judgement
--                                 about analysis rather than about
--                                 operations.
--
-- TWO CEILINGS THAT CONTRADICT A HARD RULE. PRD 16 ends with "STRICTLY
-- RESTRICTED items require named-user grants for every role except
-- Administrator, whose access is automatic and always logged." Two
-- permissions were seeded with a STRICTLY_RESTRICTED ceiling and granted to
-- an ordinary role, which means a supervisor could merge or approve
-- strictly-restricted material by role alone. That is precisely the thing the
-- rule exists to prevent.
--
-- Both are lowered to RESTRICTED. Nothing a supervisor does today changes:
-- RESTRICTED outranks CONFIDENTIAL, which is what case material normally is.
-- What changes is that strictly-restricted material now needs a named-user
-- override, which is the Permission Builder's job and is audited.
--
-- WHY NARROWING IS THE RIGHT DIRECTION HERE, since it has a visible
-- consequence for whoever was relying on it. PRD 16 calls the matrix "the
-- default starting set" that an administrator may change, and the seed IS
-- that default starting set. A default wider than the document is a decision
-- nobody took. Widening any of these again is one click in the Permission
-- Builder, recorded, with a person's name on it: which is how a deliberate
-- widening should look, and is not how any of these got here.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The three grants. The catalogue rows stay: the permission still exists and
-- can be granted again deliberately.
-- ---------------------------------------------------------------------------
delete from iam.role_permissions rp
using iam.roles r, iam.permissions p
where rp.role_id = r.id
  and rp.permission_id = p.id
  and (
    (r.key = 'analyst' and p.resource = 'cases' and p.action = 'edit')
    or (r.key = 'supervisor' and p.resource = 'cases' and p.action = 'create')
    or (r.key = 'operations_manager' and p.resource = 'findings' and p.action = 'approve')
  );

-- ---------------------------------------------------------------------------
-- The two ceilings.
--
-- Updated in place rather than re-pointed at a new permission row, so every
-- existing grant follows without being rewritten. The unique key is
-- (resource, action, scope, classification_ceiling), so the update is only
-- safe if nothing already occupies the target, which is asserted first.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from iam.permissions
    where (resource, action, scope, classification_ceiling)
      in (('findings', 'approve', 'all', 'RESTRICTED'),
          ('entities', 'merge', 'all', 'RESTRICTED'))
  ) then
    raise exception
      'a RESTRICTED-ceiling row already exists for one of these, so the update would collide; merge the grants by hand instead';
  end if;
end $$;

update iam.permissions
set classification_ceiling = 'RESTRICTED'
where scope = 'all'
  and classification_ceiling = 'STRICTLY_RESTRICTED'
  and (
    (resource = 'findings' and action = 'approve')
    or (resource = 'entities' and action = 'merge')
  );

-- Effective permissions are cached per user and invalidated by this, so the
-- narrowing takes effect without anybody signing in again (PRD 3.4).
update iam.users set permissions_version = permissions_version + 1;

-- ---------------------------------------------------------------------------
-- Assertions.
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad text;
begin
  -- The three grants are gone.
  select string_agg(r.key || ' ' || p.resource || ':' || p.action, ', ')
  into v_bad
  from iam.role_permissions rp
  join iam.roles r on r.id = rp.role_id
  join iam.permissions p on p.id = rp.permission_id
  where (r.key = 'analyst' and p.resource = 'cases' and p.action = 'edit')
     or (r.key = 'supervisor' and p.resource = 'cases' and p.action = 'create')
     or (r.key = 'operations_manager' and p.resource = 'findings' and p.action = 'approve');

  if v_bad is not null then
    raise exception 'these grants are still wider than PRD 16: %', v_bad;
  end if;

  -- And nothing an ordinary role holds reaches STRICTLY_RESTRICTED any more,
  -- which is PRD 16's hard rule stated as an assertion.
  select string_agg(r.key || ' ' || p.resource || ':' || p.action, ', ')
  into v_bad
  from iam.role_permissions rp
  join iam.roles r on r.id = rp.role_id
  join iam.permissions p on p.id = rp.permission_id
  where p.classification_ceiling = 'STRICTLY_RESTRICTED'
    and r.key <> 'administrator'
    and r.key not like 'e2e_role_%';

  if v_bad is not null then
    raise exception
      'these role grants still reach STRICTLY_RESTRICTED, which PRD 16 allows only for the Administrator: %',
      v_bad;
  end if;

  -- The catalogue rows survive, so a deliberate re-grant needs no migration.
  if not exists (
    select 1 from iam.permissions where resource = 'cases' and action = 'edit'
  ) or not exists (
    select 1 from iam.permissions where resource = 'findings' and action = 'approve'
  ) then
    raise exception
      'a catalogue row was removed rather than a grant, so the permission can no longer be given back';
  end if;

  -- A supervisor can still approve ordinary case material, which is the thing
  -- most at risk of having been broken by lowering a ceiling.
  if not exists (
    select 1
    from iam.role_permissions rp
    join iam.roles r on r.id = rp.role_id
    join iam.permissions p on p.id = rp.permission_id
    join iam.classification_levels held on held.code = p.classification_ceiling
    join iam.classification_levels want on want.code = 'CONFIDENTIAL'
    where r.key = 'supervisor'
      and p.resource = 'findings' and p.action = 'approve'
      and held.rank >= want.rank
  ) then
    raise exception
      'a supervisor can no longer approve a CONFIDENTIAL finding, which the ceiling change was not meant to do';
  end if;
end $$;
