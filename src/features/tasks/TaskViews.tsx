"use client";

import { AppLink } from "@/components/AppLink";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, CalendarDays, Columns3, List } from "lucide-react";
import { Badge, EmptyState, Id, Muted, NotSet, Table, Td, Th } from "@/components/ui";
import {
  CASE_PRIORITY_LABELS,
  TASK_STATUS_LABELS,
  TASK_STATUSES,
  type CasePriority,
  type Task,
  type TaskStatus,
} from "@/modules/casework/shared";

/**
 * The three views PRD 9.2 asks for: List, Kanban by status, Calendar by due
 * date.
 *
 * All three render the same `tasks` array, so the filters apply identically
 * and switching view never changes what is in scope. The view lives in the
 * URL like every other filter in the platform, so a particular view of a
 * particular set of tasks is a shareable link.
 *
 * The Kanban board is deliberately NOT drag-and-drop. A task's status is a
 * state machine with a reason requirement on two of its statuses (PRD 9.1):
 * dragging a card to Blocked cannot capture why it is blocked, and a board
 * that silently drops that requirement would make the blocked column useless.
 * Each card therefore links to the task, where the move is made properly.
 */

export type TaskView = "list" | "board" | "calendar";

const STATUS_TONES: Record<TaskStatus, "neutral" | "info" | "warn" | "ok" | "danger"> = {
  not_started: "neutral",
  in_progress: "info",
  blocked: "danger",
  completed: "ok",
  cancelled: "neutral",
};

const PRIORITY_TONES: Record<CasePriority, "neutral" | "warn" | "danger"> = {
  low: "neutral",
  medium: "neutral",
  high: "warn",
  urgent: "danger",
};

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return <Badge tone={STATUS_TONES[status]}>{TASK_STATUS_LABELS[status]}</Badge>;
}

export function TaskPriorityBadge({ priority }: { priority: CasePriority }) {
  if (priority === "low" || priority === "medium") return null;
  return <Badge tone={PRIORITY_TONES[priority]}>{CASE_PRIORITY_LABELS[priority]}</Badge>;
}

function OverdueFlag({ task }: { task: Task }) {
  if (!task.isOverdue || task.daysToDue === null) return null;
  const days = Math.abs(task.daysToDue);
  return (
    <Badge tone="danger">
      <AlertTriangle className="size-3" aria-hidden="true" />
      {days}d late
    </Badge>
  );
}

/**
 * The view switcher.
 *
 * On the cross-case screen the view belongs in the URL, alongside every other
 * filter, so a particular view of a particular set of tasks is a shareable
 * link. Inside a case it is just a local preference, and routing it through
 * the URL would mean the whole case page re-rendered to change a tab, so
 * `onChange` takes over there.
 */
export function TaskViewSwitcher({
  basePath,
  current,
  onChange,
}: {
  basePath?: string;
  current: TaskView;
  onChange?: (view: TaskView) => void;
}) {
  const router = useRouter();
  const params = useSearchParams();

  function go(view: TaskView) {
    if (onChange || !basePath) {
      onChange?.(view);
      return;
    }
    const next = new URLSearchParams(params.toString());
    if (view === "list") next.delete("view");
    else next.set("view", view);
    const query = next.toString();
    router.replace(query ? `${basePath}?${query}` : basePath);
  }

  const views: Array<{ key: TaskView; label: string; Icon: typeof List }> = [
    { key: "list", label: "List", Icon: List },
    { key: "board", label: "Board", Icon: Columns3 },
    { key: "calendar", label: "Calendar", Icon: CalendarDays },
  ];

  return (
    <div
      role="group"
      aria-label="Task view"
      className="inline-flex rounded-md border border-line p-0.5"
    >
      {views.map(({ key, label, Icon }) => (
        <button
          key={key}
          type="button"
          onClick={() => go(key)}
          aria-pressed={current === key}
          className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors ${
            current === key
              ? "bg-signal/10 text-signal-dark"
              : "text-muted hover:bg-surface-sunken hover:text-body"
          }`}
        >
          <Icon className="size-3.5" aria-hidden="true" />
          {label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ list */

export function TaskList({
  tasks,
  showCase = true,
}: {
  tasks: Task[];
  showCase?: boolean;
}) {
  if (tasks.length === 0) {
    return (
      <EmptyState
        title="No tasks match those filters"
        description="Clear the filters, or add the work that needs doing."
      />
    );
  }

  return (
    <Table>
      <thead>
        <tr>
          <Th>Task</Th>
          {showCase && <Th>Case</Th>}
          <Th>Status</Th>
          <Th>Assigned to</Th>
          <Th className="text-right">Due</Th>
        </tr>
      </thead>
      <tbody>
        {tasks.map((task) => (
          <tr key={task.id} className="transition-colors hover:bg-surface-sunken/60">
            <Td>
              <AppLink
                href={`/tasks/${task.id}`}
                className="block min-w-0 font-medium text-body hover:text-signal-dark hover:underline"
              >
                {task.title}
              </AppLink>
              <span className="flex flex-wrap items-center gap-1.5">
                <Id>{task.taskId}</Id>
                <TaskPriorityBadge priority={task.priority} />
                <OverdueFlag task={task} />
                {task.subTaskCount > 0 && (
                  <Muted>
                    {task.subTaskCount} sub-task{task.subTaskCount === 1 ? "" : "s"}
                  </Muted>
                )}
              </span>
            </Td>
            {showCase && (
              <Td className="text-xs">
                <AppLink
                  href={`/cases/${task.caseId}`}
                  className="text-signal-dark hover:underline"
                >
                  {task.caseReference}
                </AppLink>
                <p className="max-w-48 truncate text-[11px] text-faint">
                  {task.caseTitle}
                </p>
              </Td>
            )}
            <Td>
              <TaskStatusBadge status={task.status} />
              {task.status === "blocked" && task.statusReason && (
                <p className="mt-1 max-w-48 text-[11px] text-danger">
                  {task.statusReason}
                </p>
              )}
            </Td>
            <Td className="text-xs text-muted">
              {task.assignedToName ?? <Muted>unassigned</Muted>}
            </Td>
            <Td className="text-right text-xs whitespace-nowrap text-muted">
              {task.dueDate ? (
                new Date(task.dueDate).toLocaleDateString("en-GB")
              ) : (
                <NotSet />
              )}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/* ----------------------------------------------------------------- board */

export function TaskBoard({ tasks }: { tasks: Task[] }) {
  // Cancelled tasks are left off the board: a column of work nobody is doing
  // takes a fifth of the width and tells nobody anything. They are still in
  // the list view, which is where somebody goes looking for one.
  const columns = TASK_STATUSES.filter((s) => s !== "cancelled");

  return (
    <div className="no-scrollbar -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <div className="flex min-w-max gap-3">
        {columns.map((status) => {
          const inColumn = tasks.filter((t) => t.status === status);
          return (
            <section
              key={status}
              aria-label={TASK_STATUS_LABELS[status]}
              className="w-64 shrink-0"
            >
              <header className="mb-2 flex items-center justify-between">
                <h3 className="text-xs font-semibold tracking-wide text-body">
                  {TASK_STATUS_LABELS[status]}
                </h3>
                <span className="text-[11px] tabular-nums text-muted">
                  {inColumn.length}
                </span>
              </header>

              <div className="space-y-2">
                {inColumn.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-line-strong px-3 py-6 text-center text-[11px] text-faint">
                    Nothing here
                  </p>
                ) : (
                  inColumn.map((task) => (
                    <AppLink
                      key={task.id}
                      href={`/tasks/${task.id}`}
                      className="card block rounded-lg p-3 transition-colors hover:border-signal/40"
                    >
                      <p className="text-xs font-medium text-body">{task.title}</p>
                      <p className="mt-1">
                        <Id>{task.taskId}</Id>
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <TaskPriorityBadge priority={task.priority} />
                        <OverdueFlag task={task} />
                      </div>
                      <p className="mt-2 text-[11px] text-muted">
                        {task.assignedToName ?? "unassigned"}
                        {task.dueDate
                          ? `, due ${new Date(task.dueDate).toLocaleDateString("en-GB")}`
                          : ""}
                      </p>
                    </AppLink>
                  ))
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- calendar */

/**
 * Tasks by due date.
 *
 * Grouped by day rather than drawn as a month grid, because a month grid of
 * mostly empty cells wastes the screen and is unreadable on a phone, which
 * every screen here has to work on. Tasks with no due date are listed at the
 * end rather than hidden: a task nobody has dated is exactly the kind that
 * quietly goes nowhere.
 */
export function TaskCalendar({ tasks }: { tasks: Task[] }) {
  const dated = tasks.filter((t) => t.dueDate !== null);
  const undated = tasks.filter((t) => t.dueDate === null);

  const byDay = new Map<string, Task[]>();
  for (const task of dated) {
    const day = task.dueDate!.slice(0, 10);
    const existing = byDay.get(day);
    if (existing) existing.push(task);
    else byDay.set(day, [task]);
  }
  const days = [...byDay.keys()].sort();

  if (tasks.length === 0) {
    return (
      <EmptyState
        title="No tasks match those filters"
        description="Clear the filters, or add the work that needs doing."
      />
    );
  }

  return (
    <div className="space-y-4">
      {days.map((day) => {
        // Whether a day is past or today is read from `daysToDue`, which the
        // database computed against its own clock, rather than from a fresh
        // `new Date()` here. Every task in a group shares the due date, so
        // the first one decides. A clock in this component would disagree
        // with the overdue badges beside it for any viewer in a different
        // time zone from the server, and differ between the server render
        // and the client one.
        const sample = byDay.get(day)![0];
        const past = sample.daysToDue !== null && sample.daysToDue < 0;
        const isToday = sample.daysToDue === 0;
        return (
          <section key={day}>
            <header className="mb-2 flex items-center gap-2">
              <h3
                className={`text-xs font-semibold ${
                  past ? "text-danger" : isToday ? "text-signal-dark" : "text-body"
                }`}
              >
                {new Date(day).toLocaleDateString("en-GB", {
                  weekday: "short",
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })}
              </h3>
              {isToday && <Badge tone="signal">Today</Badge>}
              {past && <Badge tone="danger">Past</Badge>}
              <span className="ml-auto text-[11px] tabular-nums text-muted">
                {byDay.get(day)!.length}
              </span>
            </header>

            <ul className="space-y-1.5">
              {byDay.get(day)!.map((task) => (
                <li key={task.id}>
                  <AppLink
                    href={`/tasks/${task.id}`}
                    className="card flex flex-wrap items-center gap-2 rounded-lg p-2.5 transition-colors hover:border-signal/40"
                  >
                    <TaskStatusBadge status={task.status} />
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-body">
                      {task.title}
                    </span>
                    <TaskPriorityBadge priority={task.priority} />
                    <span className="text-[11px] whitespace-nowrap text-muted">
                      {task.assignedToName ?? "unassigned"}
                    </span>
                  </AppLink>
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      {undated.length > 0 && (
        <section>
          <header className="mb-2 flex items-center gap-2">
            <h3 className="text-xs font-semibold text-muted">No due date</h3>
            <span className="ml-auto text-[11px] tabular-nums text-muted">
              {undated.length}
            </span>
          </header>
          <p className="mb-2 text-[11px] text-muted">
            A task nobody has dated is the kind that quietly goes nowhere.
          </p>
          <ul className="space-y-1.5">
            {undated.map((task) => (
              <li key={task.id}>
                <AppLink
                  href={`/tasks/${task.id}`}
                  className="card flex flex-wrap items-center gap-2 rounded-lg p-2.5 transition-colors hover:border-signal/40"
                >
                  <TaskStatusBadge status={task.status} />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-body">
                    {task.title}
                  </span>
                  <TaskPriorityBadge priority={task.priority} />
                  <span className="text-[11px] whitespace-nowrap text-muted">
                    {task.assignedToName ?? "unassigned"}
                  </span>
                </AppLink>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** Picks the view from the URL, defaulting to the list. */
export function TaskViews({
  view,
  tasks,
  showCase = true,
}: {
  view: TaskView;
  tasks: Task[];
  showCase?: boolean;
}) {
  if (view === "board") return <TaskBoard tasks={tasks} />;
  if (view === "calendar") return <TaskCalendar tasks={tasks} />;
  return <TaskList tasks={tasks} showCase={showCase} />;
}
