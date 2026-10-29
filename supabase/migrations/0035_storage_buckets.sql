-- PDDC IIMS 0035 : the buckets evidence and documents live in (PRD 6.3, 7).
--
-- Three new private buckets, and the policy that matters most is the one that
-- is missing: `evidence-originals` has an INSERT policy and no UPDATE or
-- DELETE policy at all, which is what makes an original genuinely write-once
-- rather than write-once by convention. Without `x-upsert` a repeated upload
-- to the same path returns "Asset Already Exists", which is also the
-- idempotency PRD 21.7 asks for.
--
-- The website's own buckets (avatars, main, ops-attachments, ops-pdfs,
-- public-media) are untouched, as are its policies. Nothing here is a change
-- to anything primaddc.com uses.
--
-- WHY THESE POLICIES READ auth.uid() AND NOT iam.current_user_id()
-- Everywhere else in this platform the actor comes from a transaction-local
-- setting published by the application. An upload does not go through the
-- application: the browser talks to the Storage API with its own JWT, so the
-- identity available in the policy is `auth.uid()`. The reach rule is
-- therefore given a variant that takes the user explicitly, rather than
-- reading a setting that will not be there.

-- ---------------------------------------------------------------------------
-- The reach rule, over a user passed in.
-- ---------------------------------------------------------------------------
create or replace function casework.can_reach_case_for(
  p_user_id uuid,
  p_case_id uuid,
  p_action text default 'view'
)
  returns boolean
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select exists (
    select 1
    from casework.cases c
    where c.id = p_case_id
      and c.deleted_at is null
      and iam.has_permission('cases', p_action, c.classification, p_user_id)
      and (
        iam.scope_rank(iam.permission_scope('cases', p_action, p_user_id))
          >= iam.scope_rank('all')
        or exists (
          select 1 from casework.case_assignments a
          where a.case_id = c.id
            and a.user_id = p_user_id
            and a.unassigned_at is null
        )
      )
  )
$$;

comment on function casework.can_reach_case_for(uuid, uuid, text) is
  'The case reach rule for a user named explicitly, for storage policies: an '
  'upload comes from the browser rather than through the application, so '
  'auth.uid() is the identity available and iims.user_id is not set.';

-- Granted to the application only: the storage policies reach it through
-- `evidence.may_store`, which is SECURITY DEFINER.
grant execute on function casework.can_reach_case_for(uuid, uuid, text)
  to iims_app;

-- ---------------------------------------------------------------------------
-- One question, one function.
--
-- The policies below could check the permission and the reach separately, but
-- then `authenticated` would need EXECUTE on `iam.has_permission` and
-- `iam.permission_scope`, which would let any signed-in website user probe
-- the authorization catalogue. A SECURITY DEFINER function runs with its
-- owner's privileges, so folding both checks inside it keeps those functions
-- granted to the application alone.
--
-- The case folder arrives as text and is validated before it is cast: a
-- policy that cast it blindly would raise rather than return false for an
-- object whose path does not start with a case id, and Postgres does not
-- promise to evaluate the bucket check first.
-- ---------------------------------------------------------------------------
create or replace function evidence.may_store(
  p_user_id     uuid,
  p_case_folder text,
  p_resource    text,
  p_action      text
)
  returns boolean
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select case
    when p_user_id is null then false
    when p_case_folder !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then false
    else
      iam.has_permission(p_resource, p_action, null, p_user_id)
      and casework.can_reach_case_for(p_user_id, p_case_folder::uuid, 'view')
  end
$$;

comment on function evidence.may_store(uuid, text, text, text) is
  'Whether this user may put a file in, or read a file from, the folder of '
  'this case. Used by the storage policies, where the identity is auth.uid() '
  'because an upload comes from the browser rather than the application.';

grant execute on function evidence.may_store(uuid, text, text, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- The buckets.
--
-- 50MB per object, which is the free tier's hard ceiling. PRD open question 6
-- asks PDDC for the largest evidence file they must hold: CCTV exports and
-- disk images do not fit here, and that decides when the plan moves to Pro.
-- The limit is stated on the bucket rather than left implicit, so an upload
-- that is too large fails at the start with a clear reason instead of part
-- way through.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values
  ('evidence-originals', 'evidence-originals', false, 52428800),
  ('evidence-copies',    'evidence-copies',    false, 52428800),
  ('documents',          'documents',          false, 52428800)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit;

-- ---------------------------------------------------------------------------
-- evidence-originals: insert and read, never change or remove.
--
-- The path is {case_id}/{evidence_id}/{file}, so the first folder names the
-- case the reach rule is checked against.
-- ---------------------------------------------------------------------------
drop policy if exists evidence_originals_insert on storage.objects;
create policy evidence_originals_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'evidence-originals'
    and evidence.may_store(
      auth.uid(), (storage.foldername(name))[1], 'evidence', 'upload'
    )
  );

drop policy if exists evidence_originals_select on storage.objects;
create policy evidence_originals_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'evidence-originals'
    and evidence.may_store(
      auth.uid(), (storage.foldername(name))[1], 'evidence', 'download'
    )
  );

-- There is deliberately no UPDATE and no DELETE policy on this bucket. An
-- original is the thing a report rests on, and nothing in the application
-- needs to change or remove it: a working copy is a new object, and removing
-- the record is a soft delete that leaves the file alone.

-- ---------------------------------------------------------------------------
-- evidence-copies: the same, for the copies analysts actually work on.
-- ---------------------------------------------------------------------------
drop policy if exists evidence_copies_insert on storage.objects;
create policy evidence_copies_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'evidence-copies'
    and evidence.may_store(
      auth.uid(), (storage.foldername(name))[1], 'evidence', 'upload'
    )
  );

drop policy if exists evidence_copies_select on storage.objects;
create policy evidence_copies_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'evidence-copies'
    and evidence.may_store(
      auth.uid(), (storage.foldername(name))[1], 'evidence', 'download'
    )
  );

-- ---------------------------------------------------------------------------
-- documents: a version is a new object, so this bucket is append-only too.
-- ---------------------------------------------------------------------------
drop policy if exists documents_insert on storage.objects;
create policy documents_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'documents'
    and evidence.may_store(
      auth.uid(), (storage.foldername(name))[1], 'documents', 'upload'
    )
  );

drop policy if exists documents_select on storage.objects;
create policy documents_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'documents'
    and evidence.may_store(
      auth.uid(), (storage.foldername(name))[1], 'documents', 'download'
    )
  );

-- ---------------------------------------------------------------------------
-- An assertion, so the write-once property is enforced rather than believed.
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad text;
begin
  select string_agg(policyname || ' (' || cmd || ')', ', ')
  into v_bad
  from pg_catalog.pg_policies
  where schemaname = 'storage'
    and tablename = 'objects'
    and cmd in ('UPDATE', 'DELETE', 'ALL')
    and (qual ilike '%evidence-originals%' or with_check ilike '%evidence-originals%');

  if v_bad is not null then
    raise exception
      'evidence-originals has a policy that can change or remove an original, which must never exist: %',
      v_bad;
  end if;
end
$$;
