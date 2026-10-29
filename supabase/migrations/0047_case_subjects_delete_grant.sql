-- ---------------------------------------------------------------------------
-- 0047: the DELETE grant that `intel.case_subjects` was missing.
--
-- `iims_app` holds DELETE on exactly the tables that record a link between
-- two things and nothing else: entity_aliases, finding_links,
-- information_corroboration, information_evidence. It deliberately holds no
-- DELETE on anything that is a record in its own right, because those are
-- soft-deleted and recoverable from the recycle bin.
--
-- `intel.case_subjects` is a link table by that test. It joins a case to an
-- entity with a role, it carries no `deleted_at`, and it is used in the merge
-- four lines away from `finding_links` in exactly the same shape: move the
-- rows whose case the survivor is not already on, then remove the leftovers,
-- which are the cases where both records were subjects and the link would
-- otherwise duplicate.
--
-- It was simply missed. `finding_links` got the grant and `case_subjects` did
-- not, so every entity merge failed with "permission denied for table
-- case_subjects" partway through its transaction. Nothing was corrupted, the
-- transaction rolled back every time, and nobody could merge a duplicate at
-- all. Found by the end-to-end journey; the three application-level checks
-- all passed, so no amount of reading the permission model would have shown
-- it.
--
-- Granted on this one table by name rather than through a default privilege,
-- so the allow-list stays an allow-list.
-- ---------------------------------------------------------------------------

grant delete on intel.case_subjects to iims_app;

-- ---------------------------------------------------------------------------
-- Assertions.
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad text;
begin
  -- Every link table can delete. These are the tables a merge and an unlink
  -- have to be able to clear, and a missing grant on any of them is the bug
  -- this migration fixes, in a different place.
  select string_agg(t, ', ')
  into v_bad
  from unnest(array[
    'case_subjects', 'entity_aliases', 'finding_links',
    'information_corroboration', 'information_evidence'
  ]) as t
  where not has_table_privilege('iims_app', 'intel.' || t, 'delete');

  if v_bad is not null then
    raise exception 'iims_app cannot delete from these link tables: %', v_bad;
  end if;

  -- And no record table can. This is the half that makes the grant above
  -- safe: records are soft-deleted so the recycle bin can restore them, and
  -- a hard delete would take a case subject's history with it.
  select string_agg(t, ', ')
  into v_bad
  from unnest(array[
    'entities', 'sources', 'information', 'findings', 'relationships',
    'entity_match_flags', 'entity_merges'
  ]) as t
  where has_table_privilege('iims_app', 'intel.' || t, 'delete');

  if v_bad is not null then
    raise exception
      'iims_app can hard-delete from these record tables, which must be soft-deleted instead: %',
      v_bad;
  end if;
end $$;
