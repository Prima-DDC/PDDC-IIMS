-- ---------------------------------------------------------------------------
-- 0051: the person who uploads an evidence file can record it on the item.
--
-- PRD 16 gives the Investigator V C U D on Evidence: view, create, upload,
-- download, and deliberately NOT edit. Recording an uploaded file against its
-- item is an UPDATE of `evidence.evidence_items`, and that table's update
-- policy requires `evidence:edit`. So the investigator who collects an exhibit
-- and uploads it could not record it, and nothing said so: the browser hashed
-- the file, the object landed in `evidence-originals`, row-level security
-- refused the update, and the item went on reporting "No file".
--
-- The bytes were left in the bucket with nothing pointing at them. Four items
-- in this database are in that state, which is how it was found: the
-- end-to-end journey uploads as the investigator who collected the item,
-- exactly as PRD 4.4's journey C describes, and an administrator driving the
-- same screens by hand succeeds, which is why it had not been noticed.
--
-- WHY NOT JUST WIDEN THE POLICY. `evidence:upload` could be added to the
-- update policy, but row-level security cannot restrict WHICH columns a
-- statement touches, so that would let an uploader rewrite an item's
-- description or its classification. PRD 16 withholds edit from them on
-- purpose. Migration 0046 rejected the same shortcut for entity merges and
-- for the same reason: a permission is not a licence to rewrite everything the
-- operation it names happens to touch.
--
-- WHY NOT GRANT `evidence:edit`. That contradicts PRD 16's matrix, which is
-- the document's own statement of who may change an exhibit's record.
--
-- So the write is done by a function that can only ever do this one thing. It
-- checks, as itself, exactly what the policy would have checked except that it
-- asks for `upload` instead of `edit`, and it refuses an original that already
-- has a file, so write-once is enforced inside the same statement that writes.
-- ---------------------------------------------------------------------------

create or replace function evidence.record_uploaded_file(
  p_item_id uuid,
  p_file_name text,
  p_file_type text,
  p_file_size bigint,
  p_declared_sha256 text,
  p_storage_bucket text,
  p_storage_path text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_classification text;
  v_case_id uuid;
  v_copy_status text;
  v_existing text;
  v_reference text;
begin
  -- Read as the definer, so the checks below are made on the real row rather
  -- than on whatever the caller can see.
  select classification, case_id, copy_status, storage_path, evidence_id
  into v_classification, v_case_id, v_copy_status, v_existing, v_reference
  from evidence.evidence_items
  where id = p_item_id and deleted_at is null;

  if not found then
    raise exception 'that evidence item no longer exists'
      using errcode = 'no_data_found';
  end if;

  -- Exactly the policy's test, with `upload` in place of `edit`: may this
  -- actor upload evidence at this classification, and can they reach the
  -- case at all. Both read the request's GUCs, so a caller outside
  -- `withActor` is denied rather than trusted.
  if not iam.has_permission('evidence', 'upload', v_classification) then
    raise exception 'you do not have permission to upload evidence of this classification'
      using errcode = 'insufficient_privilege';
  end if;

  if not casework.can_reach_case(v_case_id, 'view') then
    raise exception 'that evidence item is on a case you cannot reach'
      using errcode = 'insufficient_privilege';
  end if;

  -- Write-once originals (PRD 6.3), enforced in the same statement as the
  -- write so an original that acquired a file a moment ago is still caught.
  if v_copy_status = 'original' and v_existing is not null then
    raise exception
      '% is an original with a file already attached', v_reference
      using errcode = 'unique_violation';
  end if;

  update evidence.evidence_items set
    file_name = p_file_name,
    file_type = p_file_type,
    file_size = p_file_size,
    declared_sha256 = p_declared_sha256,
    storage_bucket = p_storage_bucket,
    storage_path = p_storage_path,
    integrity_status = 'hash_unverified',
    computed_sha256 = null,
    verified_at = null,
    updated_by = iam.current_user_id()
  where id = p_item_id;
end
$$;

comment on function evidence.record_uploaded_file is
  'PRD 16 gives the Investigator upload but not edit, and recording a file is '
  'an update. This does that one write, checking `evidence:upload` and case '
  'reach as the update policy would, so an uploader never gains the ability '
  'to change anything else about the item.';

revoke all on function evidence.record_uploaded_file(
  uuid, text, text, bigint, text, text, text
) from public;

grant execute on function evidence.record_uploaded_file(
  uuid, text, text, bigint, text, text, text
) to iims_app;

-- ---------------------------------------------------------------------------
-- Assertions.
-- ---------------------------------------------------------------------------
do $$
declare
  v_ok boolean;
begin
  -- The function exists, is a definer, and has its search_path pinned. An
  -- unpinned definer function is a privilege-escalation hole.
  -- `set search_path = ''` is stored as the literal `search_path=""`.
  select p.prosecdef and p.proconfig @> array['search_path=""']
  into v_ok
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'evidence' and p.proname = 'record_uploaded_file';

  if v_ok is not true then
    raise exception
      'evidence.record_uploaded_file must be SECURITY DEFINER with search_path pinned';
  end if;

  -- Only the application role may call it, and PUBLIC may not.
  if has_function_privilege(
    'public', 'evidence.record_uploaded_file(uuid, text, text, bigint, text, text, text)', 'execute'
  ) then
    raise exception 'PUBLIC can execute evidence.record_uploaded_file';
  end if;

  if not has_function_privilege(
    'iims_app', 'evidence.record_uploaded_file(uuid, text, text, bigint, text, text, text)', 'execute'
  ) then
    raise exception 'iims_app cannot execute evidence.record_uploaded_file';
  end if;

  -- And the update policy still demands `edit`, so nothing else about an
  -- item became writable by an uploader.
  if exists (
    select 1 from pg_policy p
    where p.polrelid = 'evidence.evidence_items'::regclass
      and p.polname = 'evidence_items_update'
      and pg_get_expr(p.polqual, p.polrelid) like '%upload%'
  ) then
    raise exception
      'the evidence update policy was widened to uploaders, which 0051 exists to avoid';
  end if;
end $$;
