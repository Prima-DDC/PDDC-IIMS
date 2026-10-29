-- PDDC IIMS 0033 : a soft delete has to leave the row visible to whoever did it.
--
-- THE FAULT
-- Removing a task comment failed with
-- `new row violates row-level security policy for table "task_comments"`,
-- which reads like a permission problem on the write and is not one. The
-- author held the permission, the UPDATE policy's USING and WITH CHECK both
-- passed, and an ordinary UPDATE of the same row by the same actor succeeded.
-- Only the UPDATE that set `deleted_at` was refused.
--
-- The reason is a rule that is easy to miss: Postgres applies the SELECT
-- policies to the NEW row of an UPDATE. So a table whose SELECT policy says
-- `deleted_at is null` cannot have a row soft-deleted BY ANYBODY, because the
-- row the statement produces is one the policy forbids its author to see. Not
-- a narrow permission edge case: the operation was impossible for every role,
-- and the message pointed somewhere else.
--
-- Proven against the live database rather than reasoned about: as `iims_app`
-- with the author's own GUCs,
--   update ... set body = '...'        -> 1 row
--   update ... set deleted_at = now()  -> new row violates row-level security
--
-- THREE TABLES HAD IT
-- `casework.task_comments`, `casework.case_communications` and
-- `crm.client_documents` all hide deleted rows and had no policy admitting
-- them. The four tables with a recycle bin (clients, engagements, cases,
-- tasks) were already safe, because each has a `*_select_deleted` policy and
-- each removal action requires the same permission that policy asks for.
--
-- THE RULE, stated once so later milestones inherit it
-- Every table with `deleted_at` needs a SELECT policy admitting removed rows
-- to whoever is allowed to remove them. Where that is a recycle bin, the
-- permission is `<resource>:delete`. Where removal is part of ordinary
-- editing, as it is for a comment or a logged communication, it is whoever
-- could have removed it. Reads filter `deleted_at is null` in the query, as
-- the repositories already do, so admitting the row to the policy does not
-- put removed rows back on anybody's screen.

-- ---------------------------------------------------------------------------
-- A comment's author may see their own removed comment.
--
-- Only the author can remove one (`task_comments_update`), so only the author
-- needs it back. Nobody else sees it at all, which is the right reading of a
-- comment somebody withdrew.
-- ---------------------------------------------------------------------------
drop policy if exists task_comments_select_deleted on casework.task_comments;

create policy task_comments_select_deleted on casework.task_comments
  for select to iims_app
  using (
    deleted_at is not null
    and created_by = iam.current_user_id()
  );

-- ---------------------------------------------------------------------------
-- A removed communication stays visible to whoever may edit the case.
--
-- The same reach the removal itself needs (`case_communications_update`), and
-- the entry's own classification still applies: removing something does not
-- lower it.
-- ---------------------------------------------------------------------------
drop policy if exists case_communications_select_deleted on casework.case_communications;

create policy case_communications_select_deleted on casework.case_communications
  for select to iims_app
  using (
    deleted_at is not null
    and iam.has_permission('cases', 'edit', casework.case_communications.classification)
    and casework.can_reach_case(casework.case_communications.case_id, 'edit')
  );

-- ---------------------------------------------------------------------------
-- A removed client document stays visible to whoever may edit the client.
-- ---------------------------------------------------------------------------
drop policy if exists client_documents_select_deleted on crm.client_documents;

create policy client_documents_select_deleted on crm.client_documents
  for select to iims_app
  using (
    deleted_at is not null
    and iam.has_permission('clients', 'edit', crm.client_documents.classification)
    and exists (
      select 1 from crm.clients c where c.id = crm.client_documents.client_id
    )
  );

-- ---------------------------------------------------------------------------
-- And an assertion, so the rule is enforced rather than remembered.
--
-- Fails the migration if any table in the application schemas hides its
-- removed rows without admitting them to somebody. A later milestone that
-- adds a soft-deletable table and forgets the second policy finds out here,
-- rather than when somebody tries to remove a row in production.
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad text;
begin
  select string_agg(format('%s.%s', s, t), ', ')
  into v_bad
  from (
    select c.table_schema as s, c.table_name as t
    from information_schema.columns c
    where c.column_name = 'deleted_at'
      and c.table_schema in ('iam', 'crm', 'casework', 'config')
  ) tabs
  where exists (
      select 1 from pg_catalog.pg_policies p
      where p.schemaname = tabs.s and p.tablename = tabs.t
        and p.cmd in ('SELECT', 'ALL')
        and p.qual ilike '%deleted_at IS NULL%'
    )
    and not exists (
      select 1 from pg_catalog.pg_policies p
      where p.schemaname = tabs.s and p.tablename = tabs.t
        and p.cmd in ('SELECT', 'ALL')
        and p.qual ilike '%deleted_at IS NOT NULL%'
    );

  if v_bad is not null then
    raise exception
      'These tables hide removed rows with nothing admitting them, so a soft delete is impossible on them: %',
      v_bad;
  end if;
end
$$;
