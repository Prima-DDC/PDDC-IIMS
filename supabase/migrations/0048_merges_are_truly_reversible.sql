-- ---------------------------------------------------------------------------
-- 0048: make a merge reversible in fact, and stop it destroying anything.
--
-- PRD 8.4 makes two promises about a merge: it is "reversible through a
-- retained merge log", and it "never delete[s] source records". Neither was
-- kept, and 0036's own comment on intel.entity_merges records the intention
-- that was missed: "`moved` records exactly what was reassigned, so a
-- reversal puts it back rather than guessing." What `moved` actually holds is
-- counts. A count cannot be put back.
--
-- So a reversal restored the two entity records, their names and the match
-- flag, and left every statement, case link, relationship and finding link on
-- the survivor. The aliases were the sole exception, and only because the
-- merge writes a breadcrumb into each one that the reversal matches on.
--
-- This matters more than a missing feature. `information` is a hop in the
-- chain the platform exists to keep intact, Source to Information to Evidence
-- to Finding to Report. After a merge and a reversal, statements gathered
-- against one company stayed attributed to another, the screens said the
-- reversal had succeeded, and a finding citing that information still
-- resolved, so it read as sound while its attribution was wrong.
--
-- Two changes, which are two halves of one idea: record what was touched, and
-- never touch anything you cannot give back.
--
-- 1. `intel.entity_merge_rows` records every row a merge repointed or
--    withdrew, by identity. The reversal walks it. This is the table 0036's
--    comment assumed existed.
--
-- 2. The DELETE on `intel.case_subjects` that migration 0047 granted is
--    revoked. 0047 unblocked the merge, which had never once completed, by
--    reading case_subjects as a join table. That reading was wrong:
--    case_subjects carries `removed_at`, `removed_by`, `removal_reason` and a
--    restore path, so it has its own history, and 0036's privilege comment is
--    explicit that "everything that carries a history keeps the no-erasure
--    rule". The merge's conflict delete was the only hard delete against it
--    anywhere in the codebase.
--
--    The merge no longer needs it, because it no longer destroys anything.
--    Refusing such a merge was considered and rejected: 0036's comment makes
--    the right objection, that two records being subjects of one case is
--    evidence they are the same thing, so a merge failing there would fail
--    exactly when it is most obviously correct. The better answer is to stop
--    deleting. case_subjects is UNIQUE on (case_id, entity_id) and already
--    carries removed_at, removed_by and removal_reason with a restore path,
--    so the loser's row is soft-removed where it stands, keeping its role and
--    its notes and its place in the case's history.
--
--    finding_links needed no change of policy at all: it has no unique
--    constraint, so nothing ever required that delete. Its rows are simply
--    all repointed. It keeps its DELETE grant, because unlinking a finding
--    by hand is a real deletion and the only one it is for.
-- ---------------------------------------------------------------------------

create table if not exists intel.entity_merge_rows (
  id          uuid primary key default gen_random_uuid(),
  merge_id    uuid not null references intel.entity_merges (id),

  -- Which row moved, and which column of it pointed at the merged record.
  -- `relationships` has two such columns, so the column has to be named.
  table_name  text not null check (
    table_name in ('entity_aliases', 'case_subjects', 'relationships',
                   'information', 'finding_links')
  ),
  row_id      uuid not null,
  -- `deleted_at` on relationships and `removed_at` on case_subjects are the
  -- two soft-removal columns a merge touches; they are named rather than
  -- assumed because the two tables spell the same idea differently.
  column_name text not null check (
    column_name in ('entity_id', 'from_entity_id', 'to_entity_id',
                    'deleted_at', 'removed_at')
  ),

  -- 'repointed': the column held `previous_entity_id` and now holds the
  -- survivor. 'withdrawn': the row was soft-deleted, because keeping it would
  -- have made a relationship loop the table refuses.
  action      text not null check (action in ('repointed', 'withdrawn')),
  previous_entity_id uuid references intel.entities (id),

  restored_at timestamptz,
  recorded_at timestamptz not null default now(),

  constraint merge_rows_repointed_knows_where_from check (
    (action = 'repointed' and previous_entity_id is not null
       and column_name in ('entity_id', 'from_entity_id', 'to_entity_id'))
    or (action = 'withdrawn'
        and column_name in ('deleted_at', 'removed_at'))
  ),
  constraint merge_rows_one_entry_per_column
    unique (merge_id, table_name, row_id, column_name)
);

comment on table intel.entity_merge_rows is
  'PRD 8.4: what a merge actually moved, by row identity, so a reversal puts '
  'it back rather than guessing. intel.entity_merges.moved holds counts, '
  'which are a summary for a reader and not enough to reverse anything.';

create index if not exists entity_merge_rows_merge_idx
  on intel.entity_merge_rows (merge_id)
  where restored_at is null;

alter table intel.entity_merge_rows enable row level security;
alter table intel.entity_merge_rows force  row level security;

-- Readable by anyone who may read the register, because it is the evidence
-- that a merge can be undone; writable only by whoever may merge.
drop policy if exists entity_merge_rows_select on intel.entity_merge_rows;
create policy entity_merge_rows_select on intel.entity_merge_rows
  for select to iims_app
  using (iam.has_permission('entities', 'view', null));

drop policy if exists entity_merge_rows_insert on intel.entity_merge_rows;
create policy entity_merge_rows_insert on intel.entity_merge_rows
  for insert to iims_app
  with check (iam.has_permission('entities', 'merge', null));

drop policy if exists entity_merge_rows_update on intel.entity_merge_rows;
create policy entity_merge_rows_update on intel.entity_merge_rows
  for update to iims_app
  using (iam.has_permission('entities', 'merge', null))
  with check (iam.has_permission('entities', 'merge', null));

grant select, insert, update on intel.entity_merge_rows to iims_app;

-- The log of what a merge moved is never erased, like every other history
-- here. A restored row is marked, not removed.
revoke delete on intel.entity_merge_rows from iims_app;

-- And the grant 0047 added, which the refusal above makes unnecessary.
revoke delete on intel.case_subjects from iims_app;

-- ---------------------------------------------------------------------------
-- Assertions.
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad text;
begin
  -- No table that carries a history may be hard-deleted by the application.
  -- case_subjects is in this list now, which is the point of the migration.
  select string_agg(t, ', ')
  into v_bad
  from unnest(array[
    'entities', 'sources', 'information', 'findings', 'relationships',
    'case_subjects', 'entity_match_flags', 'entity_merges',
    'entity_merge_rows'
  ]) as t
  where has_table_privilege('iims_app', 'intel.' || t, 'delete');

  if v_bad is not null then
    raise exception
      'iims_app can hard-delete from these, but they carry a history and must be soft-deleted: %',
      v_bad;
  end if;

  -- The genuine join tables still can, so unlinking still works.
  select string_agg(t, ', ')
  into v_bad
  from unnest(array[
    'entity_aliases', 'finding_links',
    'information_corroboration', 'information_evidence'
  ]) as t
  where not has_table_privilege('iims_app', 'intel.' || t, 'delete');

  if v_bad is not null then
    raise exception 'iims_app can no longer unlink from: %', v_bad;
  end if;

  -- The new table is reachable for the three things the merge and the
  -- reversal need to do with it, and nothing else.
  if not (
    has_table_privilege('iims_app', 'intel.entity_merge_rows', 'select')
    and has_table_privilege('iims_app', 'intel.entity_merge_rows', 'insert')
    and has_table_privilege('iims_app', 'intel.entity_merge_rows', 'update')
  ) then
    raise exception 'iims_app cannot use intel.entity_merge_rows';
  end if;

  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'intel' and c.relname = 'entity_merge_rows'
      and c.relrowsecurity and c.relforcerowsecurity
  ) then
    raise exception 'row-level security is not enabled and forced on intel.entity_merge_rows';
  end if;
end $$;
