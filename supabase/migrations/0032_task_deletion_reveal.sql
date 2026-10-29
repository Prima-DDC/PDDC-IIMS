-- PDDC IIMS 0032 : who sees a removed task.
--
-- 0027 wrote `tasks_select_deleted` as `can_reach_case(case_id, 'delete')`,
-- which copies the rule the CRM tables use: a soft-deleted row is visible to
-- whoever may delete that kind of record. On tasks that reasoning lands on the
-- wrong permission.
--
-- `can_reach_case(id, 'delete')` asks for cases:delete. PRD 16 grants
-- cases:delete to nobody at all: a case that has started is taken to closure,
-- not deleted, and only the Administrator's wildcard reaches it. The Operations
-- Manager holds tasks:edit, which is what the removal action checks, so the
-- manager could remove a task and then never see it again: not on the task
-- page, which returned a 404, and not in the recycle bin, whose card is gated
-- the same way. The task simply disappeared, with no confirmation that it had
-- been removed and no way to restore it.
--
-- The resolution follows PRD 16 rather than papering over it. The matrix gives
-- no X on "Tasks and activities" to any role, because PRD 9.1 retires work
-- through the `cancelled` status with a reason, which keeps the task and the
-- reason on the case. Deleting one is therefore an administrative act, and
-- PRD 3.5's Administrator wildcard already covers it: nothing is added to the
-- catalogue here.
--
-- So the reveal rule becomes "whoever may delete a task, and may see the case
-- it is on", and the application checks tasks:delete before removing or
-- restoring one. Whoever can remove a task can see it afterwards, which is
-- the property that was missing.

drop policy if exists tasks_select_deleted on casework.tasks;

create policy tasks_select_deleted on casework.tasks
  for select to iims_app
  using (
    deleted_at is not null
    and iam.has_permission('tasks', 'delete')
    and casework.can_reach_case(casework.tasks.case_id, 'view')
  );

comment on table casework.tasks is
  'PRD 9.1 tasks. Work is retired by cancelling it with a reason; removal is an '
  'administrative act needing tasks:delete, which PRD 16 grants to no role but '
  'the Administrator wildcard.';
