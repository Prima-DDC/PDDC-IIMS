import { AppLink } from "@/components/AppLink";
import type { Metadata } from "next";
import { forbidden, notFound } from "next/navigation";
import {
  Alert,
  Card,
  DescriptionList,
  EmptyState,
  Id,
  Muted,
  NotSet,
  PageHeader,
} from "@/components/ui";
import { can, requireActor } from "@/lib/auth/session";
import { getTaskDetail } from "@/features/tasks/queries";
import {
  TaskComments,
  TaskForm,
  TaskReassignForm,
  TaskRemovalForm,
  TaskRestoreForm,
  TaskStatusForm,
} from "@/features/tasks/TaskForms";
import {
  TaskList,
  TaskPriorityBadge,
  TaskStatusBadge,
} from "@/features/tasks/TaskViews";
import { METHODOLOGY_LABELS, type MethodologyStage } from "@/modules/casework/shared";

export const metadata: Metadata = { title: "Task" };

export default async function TaskPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await requireActor();
  if (!(await can(actor, "tasks", "view"))) {
    forbidden();
  }

  const { id } = await params;
  const detail = await getTaskDetail(id);
  // 404 rather than 403, for the same reason a case does it: whether a task
  // exists on a case this person cannot reach is not theirs to learn.
  if (!detail) notFound();

  const { task } = detail;
  const stageLabel = task.methodologyStage
    ? (METHODOLOGY_LABELS[task.methodologyStage as MethodologyStage] ??
      task.methodologyStage)
    : null;

  return (
    <div className="space-y-5">
      <PageHeader
        title={task.title}
        description={`On ${task.caseReference}, ${task.caseTitle}`}
        breadcrumb={[{ label: "Tasks", href: "/tasks" }, { label: task.taskId }]}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <TaskStatusBadge status={task.status} />
            <TaskPriorityBadge priority={task.priority} />
          </div>
        }
      />

      {task.deletedAt !== null && (
        <Alert tone="warn" title="Task removed">
          Removed on {new Date(task.deletedAt).toLocaleString("en-GB")} and now in
          the recycle bin. It no longer counts as outstanding work, and the audit
          trail still refers to it.
          {detail.can.remove && (
            <div className="mt-3">
              <TaskRestoreForm task={task} />
            </div>
          )}
        </Alert>
      )}

      {task.status === "blocked" && task.statusReason && (
        <Alert tone="danger">Blocked: {task.statusReason}</Alert>
      )}

      <Card title="The task">
        <DescriptionList
          items={[
            { label: "Task ID", value: <Id>{task.taskId}</Id> },
            {
              label: "Case",
              value: (
                <AppLink
                  href={`/cases/${task.caseId}`}
                  className="text-signal-dark hover:underline"
                >
                  <Id>{task.caseReference}</Id> {task.caseTitle}
                </AppLink>
              ),
            },
            {
              label: "Assigned to",
              value: task.assignedToName ?? <Muted>unassigned</Muted>,
            },
            {
              label: "Starts",
              value: task.startDate ? (
                new Date(task.startDate).toLocaleDateString("en-GB")
              ) : (
                <NotSet />
              ),
            },
            {
              label: "Due",
              value: task.dueDate ? (
                <span className={task.isOverdue ? "font-medium text-danger" : undefined}>
                  {new Date(task.dueDate).toLocaleDateString("en-GB")}
                  {task.isOverdue && task.daysToDue !== null
                    ? ` (${Math.abs(task.daysToDue)} days late)`
                    : ""}
                </span>
              ) : (
                <NotSet />
              ),
            },
            {
              label: "Completed",
              value: task.completedAt ? (
                new Date(task.completedAt).toLocaleString("en-GB")
              ) : (
                <NotSet />
              ),
            },
            { label: "Methodology stage", value: stageLabel ?? <NotSet /> },
            {
              label: "Sits under",
              value: task.parentTaskId ? (
                <AppLink
                  href={`/tasks/${task.parentTaskId}`}
                  className="text-signal-dark hover:underline"
                >
                  {task.parentTaskTitle ?? "the parent task"}
                </AppLink>
              ) : (
                <NotSet />
              ),
            },
            {
              label: "From the plan",
              value: task.planVersionId ? (
                "Raised from the approved investigation plan"
              ) : (
                <Muted>added directly</Muted>
              ),
            },
            {
              label: "Created",
              value: `${new Date(task.createdAt).toLocaleString("en-GB")}${
                task.createdByName ? ` by ${task.createdByName}` : ""
              }`,
            },
          ]}
        />

        {task.description && (
          <div className="mt-4 border-t border-line pt-4">
            <p className="text-[10.5px] font-medium tracking-wide text-faint uppercase">
              Detail
            </p>
            <p className="mt-1 text-sm whitespace-pre-line text-body">
              {task.description}
            </p>
          </div>
        )}
      </Card>

      {detail.can.edit && task.deletedAt === null && (
        <Card
          title="Where it has got to"
          description="Blocked and cancelled each need a reason, so a stalled task cannot go unexplained."
        >
          <TaskStatusForm task={task} />
        </Card>
      )}

      {detail.can.edit && task.deletedAt === null && (
        <Card
          title="Who is doing it"
          description="The reason goes on the case record, which is what makes a handover readable later."
        >
          <TaskReassignForm task={task} people={detail.people} />
        </Card>
      )}

      <Card
        title="Sub-tasks"
        description="This task cannot be completed while any of these is still open."
      >
        {detail.subTasks.length === 0 ? (
          <EmptyState
            title="No sub-tasks"
            description="Break the work down by adding a task to the case and putting it under this one."
          />
        ) : (
          <TaskList tasks={detail.subTasks} showCase={false} />
        )}
      </Card>

      <TaskComments task={task} comments={detail.comments} actorId={detail.actorId} />

      {detail.can.edit && task.deletedAt === null && (
        <Card title="Details">
          <TaskForm task={task} people={detail.people} caseRecordId={task.caseId} />
        </Card>
      )}

      {detail.can.remove && task.deletedAt === null && (
        <Card
          title="Remove this task"
          description="A soft delete. It stays in the recycle bin and in the audit trail."
        >
          <TaskRemovalForm task={task} />
        </Card>
      )}
    </div>
  );
}
