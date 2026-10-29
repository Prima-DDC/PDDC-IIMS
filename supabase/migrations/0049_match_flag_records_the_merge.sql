-- ---------------------------------------------------------------------------
-- 0049: a match flag records that its decision was acted on.
--
-- The flag's statuses were open, same_entity, different_entities and
-- undecided. Nothing said "decided the same thing, and merged", so a merge
-- left the flag reading `same_entity` for ever.
--
-- Three consequences, in increasing order of seriousness.
--
-- The screen kept offering "Merge ENT-NNNN into this record" for a pair it
-- had already merged. `assertMergeable` refuses it, because the merged record
-- is no longer a record but a pointer, so this was a control that could only
-- produce an error. Offering something the server will refuse is the one
-- thing this platform does not do anywhere else, and the end-to-end journey
-- found it by asserting the button had gone.
--
-- Nothing recorded whether a decision had been carried out. Two flags both
-- reading `same_entity`, one merged and one not, were indistinguishable
-- without going to intel.entity_merges to look, which is the sort of question
-- a register should answer about itself.
--
-- And the reversal already assumed this status existed. It sets the flag back
-- to `undecided` so that "the decision has to be made again rather than
-- silently standing", which only makes sense as the undoing of a state the
-- merge should have set and never did. The reversal was reopening a flag that
-- had never been closed.
--
-- `merged` is terminal in the sense that matters: the only way out of it is
-- reversing the merge, which the reversal already handles by moving the flag
-- to `undecided` with a reason.
-- ---------------------------------------------------------------------------

alter table intel.entity_match_flags
  drop constraint if exists entity_match_flags_status_check;

alter table intel.entity_match_flags
  add constraint entity_match_flags_status_check
  check (status = any (array[
    'open', 'same_entity', 'different_entities', 'undecided', 'merged'
  ]));

-- The existing rows whose merge is still in force. Written from
-- intel.entity_merges rather than guessed: a flag is `merged` exactly when a
-- merge of that pair exists and has not been reversed.
update intel.entity_match_flags f
set status = 'merged'
where f.status = 'same_entity'
  and exists (
    select 1
    from intel.entity_merges m
    where m.reversed_at is null
      and ((m.surviving_entity_id = f.entity_a_id and m.merged_entity_id = f.entity_b_id)
        or (m.surviving_entity_id = f.entity_b_id and m.merged_entity_id = f.entity_a_id))
  );

-- ---------------------------------------------------------------------------
-- Assertions.
-- ---------------------------------------------------------------------------
do $$
declare
  v_count integer;
begin
  -- The new status is accepted.
  begin
    insert into intel.entity_match_flags (
      entity_a_id, entity_b_id, flag_type, status, detected_by,
      decided_by, decided_at, decision_reason, created_by, updated_by
    )
    select least(a.id, b.id), greatest(a.id, b.id), 'potential_duplicate',
           'merged', 'manual',
           (select id from iam.users limit 1), now(),
           'migration 0049 probe, rolled back',
           (select id from iam.users limit 1), (select id from iam.users limit 1)
    from (select id from intel.entities order by created_at limit 1) a,
         (select id from intel.entities order by created_at desc limit 1) b
    where a.id <> b.id;
    -- Never kept: this is a constraint probe, not data.
    raise exception 'rollback the probe';
  exception
    when others then
      if sqlerrm <> 'rollback the probe' then
        raise exception 'the merged status was refused: %', sqlerrm;
      end if;
  end;

  -- No flag claims a merge that is not in force, and none that is in force
  -- still reads as merely decided.
  select count(*)
  into v_count
  from intel.entity_match_flags f
  where f.status = 'merged'
    and not exists (
      select 1 from intel.entity_merges m
      where m.reversed_at is null
        and ((m.surviving_entity_id = f.entity_a_id and m.merged_entity_id = f.entity_b_id)
          or (m.surviving_entity_id = f.entity_b_id and m.merged_entity_id = f.entity_a_id))
    );

  if v_count > 0 then
    raise exception '% flags claim a merge that is not in force', v_count;
  end if;

  select count(*)
  into v_count
  from intel.entity_match_flags f
  where f.status = 'same_entity'
    and exists (
      select 1 from intel.entity_merges m
      where m.reversed_at is null
        and ((m.surviving_entity_id = f.entity_a_id and m.merged_entity_id = f.entity_b_id)
          or (m.surviving_entity_id = f.entity_b_id and m.merged_entity_id = f.entity_a_id))
    );

  if v_count > 0 then
    raise exception
      '% flags have a merge in force but still read same_entity, so the screen would offer the merge again',
      v_count;
  end if;
end $$;
