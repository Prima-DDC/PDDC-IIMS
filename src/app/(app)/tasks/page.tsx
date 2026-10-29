import type { Metadata } from "next";
import { Suspense } from "react";
import { forbidden } from "next/navigation";
import {
  Card,
  FiltersSkeleton,
  PageHeader,
  Pagination,
  StatTile,
  TableSkeleton,
} from "@/components/ui";
import { can, requireActor } from "@/lib/auth/session";
import { listTasks } from "@/features/tasks/queries";
import { TaskFilters } from "@/features/tasks/TaskFilters";
import { TaskForm } from "@/features/tasks/TaskForms";
import {
  TaskList,
  TaskViewSwitcher,
  TaskViews,
  type TaskView,
} from "@/features/tasks/TaskViews";

export const metadata: Metadata = { title: "Tasks" };

type Params = {
  search?: string;
  status?: string;
  priority?: string;
  assignedTo?: string;
  mine?: string;
  unassignedOnly?: string;
  overdueOnly?: string;
  sort?: string;
  view?: string;
  page?: string;
};

function viewFrom(value: string | undefined): TaskView {
  return value === "board" || value === "calendar" ? value : "list";
}

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const actor = await requireActor();
  if (!(await can(actor, "tasks", "view"))) {
    forbidden();
  }

  const params = await searchParams;
  const view = viewFrom(params.view);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Tasks"
        description="The work itself, across every case you can reach. Blocked and cancelled each need a reason, so neither can go unexplained."
        actions={<TaskViewSwitcher basePath="/tasks" current={view} />}
      />

      <Suspense key={JSON.stringify(params)} fallback={<TableSkeleton rows={8} />}>
        <TaskScreen params={params} view={view} />
      </Suspense>
    </div>
  );
}

async function TaskScreen({ params, view }: { params: Params; view: TaskView }) {
  const result = await listTasks({
    search: params.search,
    status: params.status,
    priority: params.priority,
    assignedTo: params.assignedTo,
    mine: params.mine === "1",
    unassignedOnly: params.unassignedOnly === "1",
    overdueOnly: params.overdueOnly === "1",
    sort: params.sort,
    page: params.page ? Number(params.page) : 1,
    // The board and the calendar are only honest if they hold the whole set,
    // because a column or a day that stops at page one reads as finished work.
    perPage: view === "list" ? 50 : 200,
  });

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile label="Open" value={result.summary.open} />
        <StatTile
          label="Assigned to me"
          value={result.mine.open}
          href="/tasks?mine=1"
        />
        <StatTile
          label="Overdue"
          value={result.summary.overdue}
          tone={result.summary.overdue > 0 ? "danger" : "ok"}
          href="/tasks?overdueOnly=1"
        />
        <StatTile
          label="Blocked"
          value={result.summary.blocked}
          tone={result.summary.blocked > 0 ? "warn" : "neutral"}
          href="/tasks?status=blocked"
        />
        <StatTile
          label="Unassigned"
          value={result.summary.unassigned}
          tone={result.summary.unassigned > 0 ? "warn" : "neutral"}
          href="/tasks?unassignedOnly=1"
        />
      </div>

      <Suspense fallback={<FiltersSkeleton selects={4} />}>
        <TaskFilters people={result.people} />
      </Suspense>

      {view === "list" && result.rows.length > 0 ? (
        <Card>
          <TaskList tasks={result.rows} />
          <Pagination
            basePath="/tasks"
            page={result.page}
            pageCount={result.pageCount}
            total={result.total}
            params={params}
            unit="task"
          />
        </Card>
      ) : (
        <TaskViews view={view} tasks={result.rows} />
      )}

      {result.can.create && (
        <Card
          title="Add a task"
          description="Work that falls outside the approved plan still belongs on the case, where it can be seen."
        >
          <TaskForm cases={result.cases} people={result.people} />
        </Card>
      )}
    </div>
  );
}
