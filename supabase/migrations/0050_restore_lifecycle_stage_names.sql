-- ---------------------------------------------------------------------------
-- 0050: put the case lifecycle's stage names back to PRD 4.2.
--
-- The live lifecycle had been renamed by test runs, and wrongly:
--
--   assigned     was "Analysis"             (PRD 4.2: "Assigned")
--   in_progress  was "Analysis and Review"  (PRD 4.2: "Investigation in Progress")
--
-- leaving two different stages both called "Analysis" in the list every case
-- screen reads, and no stage called "Assigned" at all. The stage KEYS were
-- never touched, which is why nothing broke: permissions, saved filters and
-- the transition table all key off `key`, and `name` is only what a person
-- reads. That is also why it went unnoticed for so long.
--
-- How it happened is worth recording, because it is a trap in the test rather
-- than in the product. The administration journey renames a stage and renames
-- it back, to prove PRD 4.2's "administrators can rename without code
-- changes". It selected the stage with `hasText: "Analysis"`, which is a
-- substring match, and "Analysis and Review" contains "Analysis". So the
-- moment a run failed between the rename and the restore, the next run's
-- selector matched the already-renamed stage or its neighbour, and renamed
-- something else again. Not idempotent, against shared configuration, in a
-- live database.
--
-- Restored by key, to the names PRD 4.2 lists, for the seeded keys only. An
-- administrator may legitimately rename any of these afterwards, which is the
-- point of the feature; this is a correction of damage, not a policy that
-- they must keep these names.
-- ---------------------------------------------------------------------------

do $$
declare
  v_def uuid;
  v_stage record;
  v_fixed text[] := '{}';
begin
  select id into v_def
  from config.workflow_definitions
  where key = 'pddc_default';

  if v_def is null then
    raise exception 'the default case lifecycle is missing';
  end if;

  -- The names from PRD 4.2, in its order. `report_approved` is the second
  -- "Approved" in that sentence, disambiguated as migration 0023 did.
  for v_stage in
    select * from (values
      ('new',                 'New'),
      ('pending_approval',    'Pending Approval'),
      ('approved',            'Approved'),
      ('assigned',            'Assigned'),
      ('in_progress',         'Investigation in Progress'),
      ('awaiting_information','Awaiting Information'),
      ('analysis',            'Analysis'),
      ('draft_report',        'Draft Report'),
      ('quality_review',      'Quality Review'),
      ('report_approved',     'Report Approved'),
      ('delivered',           'Delivered'),
      ('completed',           'Completed'),
      ('closed',              'Closed'),
      ('archived',            'Archived')
    ) as s(key, name)
  loop
    update config.workflow_stages
    set name = v_stage.name
    where definition_id = v_def
      and key = v_stage.key
      and name <> v_stage.name;

    if found then
      v_fixed := v_fixed || v_stage.key;
    end if;
  end loop;

  if array_length(v_fixed, 1) > 0 then
    raise notice 'restored stage names: %', array_to_string(v_fixed, ', ');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Assertions.
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad text;
  v_count integer;
begin
  -- No two stages of one lifecycle share a name. This is what made the
  -- damage visible: a list with two rows called "Analysis" is a list nobody
  -- can act on, and it is also what let the test's substring selector go
  -- wrong in the first place.
  -- `s.name`, qualified: config.workflow_definitions also has a `name`, so
  -- the bare column is ambiguous across this join.
  select string_agg(dupes.stage_name || ' x' || dupes.n, ', ')
  into v_bad
  from (
    select s.name as stage_name, count(*) as n
    from config.workflow_stages s
    join config.workflow_definitions d on d.id = s.definition_id
    where d.key = 'pddc_default'
    group by s.name
    having count(*) > 1
  ) as dupes;

  if v_bad is not null then
    raise exception 'the default lifecycle has duplicate stage names: %', v_bad;
  end if;

  -- All fourteen of PRD 4.2's stages are present and named as it names them.
  select count(*)
  into v_count
  from config.workflow_stages s
  join config.workflow_definitions d on d.id = s.definition_id
  where d.key = 'pddc_default';

  if v_count <> 14 then
    raise exception 'expected PRD 4.2 to have 14 stages, found %', v_count;
  end if;

  select string_agg(k, ', ')
  into v_bad
  from unnest(array[
    'New', 'Pending Approval', 'Approved', 'Assigned',
    'Investigation in Progress', 'Awaiting Information', 'Analysis',
    'Draft Report', 'Quality Review', 'Report Approved', 'Delivered',
    'Completed', 'Closed', 'Archived'
  ]) as k
  where not exists (
    select 1
    from config.workflow_stages s
    join config.workflow_definitions d on d.id = s.definition_id
    where d.key = 'pddc_default' and s.name = k
  );

  if v_bad is not null then
    raise exception 'these PRD 4.2 stages are missing or renamed: %', v_bad;
  end if;
end $$;
