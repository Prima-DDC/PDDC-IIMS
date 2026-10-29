"use client";

import { useState } from "react";
import {
  ArrowRight,
  MessageSquarePlus,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { ActionForm } from "@/components/ActionForm";
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Muted,
  Select,
  Textarea,
} from "@/components/ui";
import {
  CASE_PRIORITIES,
  CASE_PRIORITY_LABELS,
  METHODOLOGY_LABELS,
  METHODOLOGY_STAGES,
  TASK_STATUS_LABELS,
  allowedTaskTransitions,
  type Task,
  type TaskComment,
} from "@/modules/casework/shared";
import {
  addTaskComment,
  createTask,
  reassignTask,
  removeTask,
  removeTaskComment,
  restoreTask,
  setTaskStatus,
  updateTask,
} from "./actions";

/**
 * The task form, used both to add a task and to edit one.
 *
 * The status is NOT a field here. PRD 9.1 gives two statuses a reason
 * requirement, and a status dropdown sitting among ordinary fields invites
 * somebody to change it without one. Moving a task is its own form, below,
 * where the reason appears when it is needed.
 */
export function TaskForm({
  caseRecordId,
  cases,
  task,
  people,
  parentOptions,
}: {
  /** Fixed when the form is on a case page. */
  caseRecordId?: string;
  /** Offered as a picker instead, on the cross-case task screen. */
  cases?: Array<{ id: string; label: string }>;
  task?: Task;
  people: Array<{ id: string; name: string }>;
  /** Tasks this one could sit under. Excludes itself and its descendants. */
  parentOptions?: Array<{ id: string; title: string }>;
}) {
  const editing = task !== undefined;
  const needsCasePicker = !editing && !caseRecordId;

  return (
    <ActionForm
      action={editing ? updateTask : createTask}
      submitLabel={
        editing ? (
          <>
            <Save className="size-4" aria-hidden="true" />
            Save changes
          </>
        ) : (
          <>
            <Plus className="size-4" aria-hidden="true" />
            Add the task
          </>
        )
      }
      submitSize="sm"
      hidden={
        editing
          ? { taskId: task.id, expectedVersion: task.version }
          : { caseRecordId }
      }
    >
      {(state) => (
        <div className="grid gap-3 sm:grid-cols-2">
          {needsCasePicker && (
            <div className="sm:col-span-2">
              <Field
                label="Case"
                htmlFor="task-case"
                required
                hint="Only cases you are on and that are still open."
                error={state.fieldErrors?.caseRecordId}
              >
                <Select id="task-case" name="caseRecordId" defaultValue="">
                  <option value="">Choose a case</option>
                  {(cases ?? []).map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )}

          <div className="sm:col-span-2">
            <Field
              label="What needs doing"
              htmlFor={`task-title-${task?.id ?? "new"}`}
              required
              error={state.fieldErrors?.title}
            >
              <Input
                id={`task-title-${task?.id ?? "new"}`}
                name="title"
                defaultValue={task?.title ?? ""}
                placeholder="Obtain the bank statements for the period"
              />
            </Field>
          </div>

          <Field
            label="Assigned to"
            htmlFor={`task-assignee-${task?.id ?? "new"}`}
            hint="A task nobody owns is the kind that quietly goes nowhere."
            error={state.fieldErrors?.assignedTo}
          >
            <Select
              id={`task-assignee-${task?.id ?? "new"}`}
              name="assignedTo"
              defaultValue={task?.assignedTo ?? ""}
            >
              <option value="">Unassigned</option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Priority"
            htmlFor={`task-priority-${task?.id ?? "new"}`}
            required
            error={state.fieldErrors?.priority}
          >
            <Select
              id={`task-priority-${task?.id ?? "new"}`}
              name="priority"
              defaultValue={task?.priority ?? "medium"}
            >
              {CASE_PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>
                  {CASE_PRIORITY_LABELS[priority]}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Starts"
            htmlFor={`task-start-${task?.id ?? "new"}`}
            error={state.fieldErrors?.startDate}
          >
            <Input
              id={`task-start-${task?.id ?? "new"}`}
              name="startDate"
              type="date"
              defaultValue={task?.startDate?.slice(0, 10) ?? ""}
            />
          </Field>

          <Field
            label="Due"
            htmlFor={`task-due-${task?.id ?? "new"}`}
            hint="Overdue tasks are flagged automatically from this date."
            error={state.fieldErrors?.dueDate}
          >
            <Input
              id={`task-due-${task?.id ?? "new"}`}
              name="dueDate"
              type="date"
              defaultValue={task?.dueDate?.slice(0, 10) ?? ""}
            />
          </Field>

          <Field
            label="Methodology stage"
            htmlFor={`task-stage-${task?.id ?? "new"}`}
            error={state.fieldErrors?.methodologyStage}
          >
            <Select
              id={`task-stage-${task?.id ?? "new"}`}
              name="methodologyStage"
              defaultValue={task?.methodologyStage ?? ""}
            >
              <option value="">Not assigned to a stage</option>
              {METHODOLOGY_STAGES.map((stage) => (
                <option key={stage} value={stage}>
                  {METHODOLOGY_LABELS[stage]}
                </option>
              ))}
            </Select>
          </Field>

          {parentOptions && parentOptions.length > 0 && (
            <Field
              label="Sits under"
              htmlFor={`task-parent-${task?.id ?? "new"}`}
              hint="Makes this a sub-task. A parent cannot be completed while its sub-tasks are open."
              error={state.fieldErrors?.parentTaskId}
            >
              <Select
                id={`task-parent-${task?.id ?? "new"}`}
                name="parentTaskId"
                defaultValue={task?.parentTaskId ?? ""}
              >
                <option value="">Nothing, it stands on its own</option>
                {parentOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.title}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <div className="sm:col-span-2">
            <Field
              label="Detail"
              htmlFor={`task-description-${task?.id ?? "new"}`}
              error={state.fieldErrors?.description}
            >
              <Textarea
                id={`task-description-${task?.id ?? "new"}`}
                name="description"
                rows={3}
                defaultValue={task?.description ?? ""}
              />
            </Field>
          </div>
        </div>
      )}
    </ActionForm>
  );
}

/**
 * Moving a task between statuses.
 *
 * The dropdown offers only the moves the machine permits from here, and the
 * reason field announces itself as required when the chosen status demands one
 * (PRD 9.1). That is why this is a separate form from the task's fields.
 */
export function TaskStatusForm({ task }: { task: Task }) {
  const transitions = allowedTaskTransitions(task.status);
  const [target, setTarget] = useState<string>(transitions[0] ?? "");

  // After a successful move the task arrives with a new status, and the status
  // just chosen is no longer among the moves available from it. The state is
  // adjusted in place rather than by keying the whole component on the status,
  // because remounting would throw away the confirmation of the move that
  // caused it. The select itself is keyed, which resets just that control.
  const [statusShown, setStatusShown] = useState(task.status);
  if (statusShown !== task.status) {
    setStatusShown(task.status);
    setTarget(transitions[0] ?? "");
  }

  const needsReason = target === "blocked" || target === "cancelled";

  if (transitions.length === 0) {
    return (
      <Alert tone="info">
        {TASK_STATUS_LABELS[task.status]} is final. If the work needs doing
        again, raise a new task so this one stays readable as the thing that was
        closed.
      </Alert>
    );
  }

  return (
    <ActionForm
      action={setTaskStatus}
      submitLabel={
        <>
          <ArrowRight className="size-4" aria-hidden="true" />
          Move the task
        </>
      }
      submitSize="sm"
      hidden={{ taskId: task.id }}
    >
      {(state) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="New status"
            htmlFor="task-status"
            required
            error={state.fieldErrors?.status}
          >
            {/* Uncontrolled, with a key. A controlled select is reset to its
                state value when React hydrates, which silently discards a
                choice made before the JavaScript arrived: on a slow
                connection somebody would pick "Blocked", submit, and move
                the task somewhere else entirely. The key resets the control
                when the task's status changes, and `target` drives only the
                labels below. */}
            <Select
              key={task.status}
              id="task-status"
              name="status"
              defaultValue={transitions[0] ?? ""}
              onChange={(e) => setTarget(e.target.value)}
            >
              {transitions.map((status) => (
                <option key={status} value={status}>
                  {TASK_STATUS_LABELS[status]}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label={
              target === "blocked"
                ? "What is blocking it"
                : target === "cancelled"
                  ? "Why it is being cancelled"
                  : "Note"
            }
            htmlFor="task-status-reason"
            required={needsReason}
            hint={
              needsReason
                ? "Required. A blocker nobody wrote down cannot be cleared by anybody else."
                : undefined
            }
            error={state.fieldErrors?.reason}
          >
            <Input
              id="task-status-reason"
              name="reason"
              placeholder={
                target === "blocked"
                  ? "Waiting on the registry search"
                  : undefined
              }
            />
          </Field>
        </div>
      )}
    </ActionForm>
  );
}

export function TaskReassignForm({
  task,
  people,
}: {
  task: Task;
  people: Array<{ id: string; name: string }>;
}) {
  return (
    <ActionForm
      action={reassignTask}
      submitLabel="Reassign"
      submitSize="sm"
      hidden={{ taskId: task.id }}
    >
      {(state) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Assign to"
            htmlFor="reassign-user"
            error={state.fieldErrors?.assignedTo}
          >
            <Select
              id="reassign-user"
              name="assignedTo"
              defaultValue={task.assignedTo ?? ""}
            >
              <option value="">Unassigned</option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Reason"
            htmlFor="reassign-reason"
            required
            error={state.fieldErrors?.reason}
          >
            <Input
              id="reassign-reason"
              name="reason"
              placeholder="First investigator is on leave"
            />
          </Field>
        </div>
      )}
    </ActionForm>
  );
}

/** The conversation on a task (PRD 9.1's `comments[]`). */
export function TaskComments({
  task,
  comments,
  actorId,
}: {
  task: Task;
  comments: TaskComment[];
  actorId: string;
}) {
  const [adding, setAdding] = useState(false);

  return (
    <Card
      title="Comments"
      description="Where the detail of how the work went lives. Material facts belong in the case activity log instead, which is append-only."
      actions={
        !adding ? (
          <Button size="sm" onClick={() => setAdding(true)}>
            <MessageSquarePlus className="size-4" aria-hidden="true" />
            Add a comment
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {adding && (
          <div className="rounded-lg border border-line bg-surface-sunken p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-medium text-body">New comment</p>
              <Button size="sm" tone="ghost" onClick={() => setAdding(false)}>
                <X className="size-4" aria-hidden="true" />
                Cancel
              </Button>
            </div>
            <ActionForm
              action={addTaskComment}
              submitLabel="Post"
              submitSize="sm"
              hidden={{ taskId: task.id }}
            >
              {(state) => (
                <Field
                  label="Comment"
                  htmlFor="comment-body"
                  required
                  error={state.fieldErrors?.body}
                >
                  <Textarea id="comment-body" name="body" rows={3} />
                </Field>
              )}
            </ActionForm>
          </div>
        )}

        {comments.length === 0 ? (
          <EmptyState title="No comments yet" />
        ) : (
          <ol className="space-y-2">
            {comments.map((comment) => (
              <li
                key={comment.id}
                className="rounded-lg border border-line p-3"
              >
                <div className="flex items-baseline gap-2">
                  <span className="text-xs font-medium text-body">
                    {comment.createdByName ?? "Somebody"}
                  </span>
                  <span className="text-[11px] text-muted">
                    {new Date(comment.createdAt).toLocaleString("en-GB")}
                  </span>
                  {comment.updatedAt !== comment.createdAt && (
                    <Muted>edited</Muted>
                  )}
                </div>
                <p className="mt-1 text-xs whitespace-pre-line text-body">
                  {comment.body}
                </p>

                {comment.createdBy === actorId && (
                  <div className="mt-2 flex justify-end">
                    <ActionForm
                      action={removeTaskComment}
                      submitLabel={
                        <>
                          <Trash2 className="size-3.5" aria-hidden="true" />
                          <span className="sr-only">Remove this comment</span>
                        </>
                      }
                      submitTone="danger"
                      submitSize="sm"
                      hidden={{
                        commentId: comment.id,
                        taskId: task.id,
                        reason: "removed by its author",
                      }}
                      confirm="Remove this comment?"
                      compact
                    />
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </Card>
  );
}

export function TaskRemovalForm({ task }: { task: Task }) {
  return (
    <ActionForm
      action={removeTask}
      submitLabel={
        <>
          <Trash2 className="size-4" aria-hidden="true" />
          Remove this task
        </>
      }
      submitTone="danger"
      submitSize="sm"
      hidden={{ taskId: task.id }}
      confirm="Remove this task? Cancelling it with a reason leaves a better record."
    >
      {(state) => (
        <Field
          label="Reason for removal"
          htmlFor="task-remove-reason"
          required
          hint="If the work simply is not needed, cancel the task instead: that keeps it and its reason on the case."
          error={state.fieldErrors?.reason}
        >
          <Input
            id="task-remove-reason"
            name="reason"
            placeholder="Raised against the wrong case"
          />
        </Field>
      )}
    </ActionForm>
  );
}

/**
 * Brings a removed task back.
 *
 * It lives in its own component because the removal form cannot show it: that
 * form is only rendered while the task is live, so the moment it succeeds it
 * unmounts itself and its own confirmation with it.
 */
export function TaskRestoreForm({ task }: { task: Task }) {
  return (
    <ActionForm
      action={restoreTask}
      submitLabel={
        <>
          <RotateCcw className="size-3.5" aria-hidden="true" />
          Restore
        </>
      }
      submitSize="sm"
      hidden={{ taskId: task.id, reason: "restored from the recycle bin" }}
      confirm={`Restore ${task.taskId}?`}
      compact
    />
  );
}
