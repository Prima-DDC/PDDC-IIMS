-- PDDC IIMS 0037 : an entity is reachable by whoever recorded it.
--
-- 0036 answered "can this person see this entity" from the cases the entity
-- is a subject of, because an entity is not case-scoped and there is nothing
-- else to answer it from. That is right, and it had one consequence nobody
-- would want: an entity on no case is reachable only at 'all' scope, and an
-- Investigator holds `entities:view` at 'assigned' scope.
--
-- So the role PRD 16 gives entity registration to could create a subject and
-- then not see it. Found by working out what the end-to-end journey would do:
-- registering a subject writes the entity, reads it back to return it, and
-- the read came back empty because the subject had not been attached to the
-- case yet. The row was written and the screen reported a failure.
--
-- Three ways to fix it, and the choice matters:
--
--   Attach the entity to a case inside the same statement, so the reach rule
--   always has a case to read. That makes an entity registered for the
--   register's own sake impossible, which is the opposite of what a
--   cross-case register is for.
--
--   Read back with the check suspended. That is a hole, and holes of that
--   shape are how need-to-know quietly stops meaning anything.
--
--   Say that whoever recorded an entity can see it. That is the rule a person
--   would state without being asked, it gives away nothing (the creator typed
--   the data), and it is the one that makes the register usable before a
--   subject is attached to anything.
--
-- The third. Note what it does NOT do: it does not let the author see the
-- entity's identity reference, which has its own permission check inside
-- `intel.id_reference`, and it does not extend to the cases the entity later
-- appears on.

create or replace function intel.can_reach_entity(p_entity_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select
    iam.scope_rank(iam.permission_scope('entities', 'view'))
      >= iam.scope_rank('all')
    -- Whoever recorded it. An author who has since lost the permission
    -- altogether is still refused, because `entities_select` checks
    -- `iam.has_permission` separately.
    or exists (
      select 1
      from intel.entities e
      where e.id = p_entity_id
        and e.created_by = iam.current_user_id()
    )
    or exists (
      select 1
      from intel.case_subjects s
      where s.entity_id = p_entity_id
        and s.removed_at is null
        and casework.can_reach_case(s.case_id, 'view')
    )
$$;

comment on function intel.can_reach_entity(uuid) is
  'Whether the current actor can see an entity: at "all" scope, because they '
  'recorded it, or through a case the entity is a subject of. The author '
  'clause is what lets an Investigator register a subject before it is '
  'attached to a case and still read it back.';

-- ---------------------------------------------------------------------------
-- The same gap, one layer out.
--
-- A relationship is visible only when both its ends are, which is right. A
-- relationship between two entities the actor recorded is now visible to
-- them, which falls out of the entity rule above and needs nothing here.
--
-- `intel.entity_match_flags` and `intel.entity_merges` likewise read through
-- `intel.entities`, so they follow.
-- ---------------------------------------------------------------------------

do $$
begin
  -- The author clause must not let somebody with no entity permission at all
  -- see anything: that check lives in the policy, not in the reach rule, and
  -- this asserts the policy still carries it.
  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'intel' and tablename = 'entities'
      and policyname = 'entities_select'
      and qual like '%has_permission%'
  ) then
    raise exception
      'entities_select no longer checks iam.has_permission, so intel.can_reach_entity''s author clause would be the only gate';
  end if;
end
$$;
