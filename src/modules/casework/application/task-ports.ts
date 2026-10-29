import type { ClassificationLevel } from "@/modules/iam/domain/classification";
import type {
  Activity,
  ActivityType,
  CasePriority,
  InvestigationPlan,
  PlanVersion,
  Task,
  TaskComment,
  TaskStatus,
} from "../domain/types";
import type { Page } from "./ports";

/**
 * Ports for the work that happens on a case: tasks, the activity log and the
 * investigation plan (PRD 9).
 *
 * Separate from ports.ts because these are read from two places the case
 * record is not: the cross-case task list ("everything assigned to me") and
 * the overdue scan. A task repository that could only be reached through a
 * case would make both of those awkward.
 */

export interface ListTasksFilter {
  /** Omit to search across every case the caller can reach. */
  caseId?: string;
  search?: string;
  status?: TaskStatus | "all";
  /** Everything not completed or cancelled, which is the usual view. */
  openOnly?: boolean;
  priority?: CasePriority;
  assignedTo?: string;
  /** Unassigned tasks, which are the ones that quietly go nowhere. */
  unassignedOnly?: boolean;
  overdueOnly?: boolean;
  methodologyStage?: string;
  /** Top-level tasks only, for a list that shows its own hierarchy. */
  topLevelOnly?: boolean;
  parentTaskId?: string;
  includeDeleted?: boolean;
  onlyDeleted?: boolean;
  limit?: number;
  offset?: number;
  sort?: "due" | "priority" | "status" | "created" | "title";
}

export interface CreateTaskInput {
  caseId: string;
  title: string;
  description?: string | null;
  assignedTo?: string | null;
  priority: CasePriority;
  startDate?: string | null;
  dueDate?: string | null;
  methodologyStage?: string | null;
  parentTaskId?: string | null;
  /** Set when the task comes from an approved plan rather than ad hoc. */
  planVersionId?: string | null;
}

export type UpdateTaskInput = Partial<Omit<CreateTaskInput, "caseId">> & {
  expectedVersion: number;
};

export interface TaskRepository {
  list(filter: ListTasksFilter): Promise<Page<Task>>;
  findById(id: string): Promise<Task | null>;
  create(input: CreateTaskInput): Promise<Task>;
  update(id: string, input: UpdateTaskInput): Promise<Task>;

  /**
   * Moves a task between statuses.
   *
   * The caller has applied the transition rules and the reason requirement;
   * this records the move. `completedAt` is set and cleared here rather than
   * by the caller, so it can never disagree with the status.
   */
  setStatus(input: {
    id: string;
    status: TaskStatus;
    reason?: string | null;
  }): Promise<Task>;

  reassign(id: string, userId: string | null, reason: string): Promise<Task>;

  softDelete(id: string, reason: string): Promise<void>;
  restore(id: string, reason: string): Promise<void>;

  /** The chain of parents above a task, used to refuse a cycle. */
  ancestorIds(taskId: string): Promise<string[]>;
  /** Open sub-tasks, which block completing the parent. */
  openSubTaskCount(taskId: string): Promise<number>;

  comments(taskId: string): Promise<TaskComment[]>;
  addComment(taskId: string, body: string): Promise<TaskComment>;
  updateComment(
    id: string,
    input: { body: string; expectedVersion: number },
  ): Promise<TaskComment>;
  removeComment(id: string, reason: string): Promise<void>;

  /** Counts for the task list header and the case page. */
  summary(filter: { caseId?: string; assignedTo?: string }): Promise<{
    total: number;
    open: number;
    overdue: number;
    blocked: number;
    unassigned: number;
    dueThisWeek: number;
  }>;
}

/* ------------------------------------------------------------ activities */

export interface ListActivitiesFilter {
  caseId: string;
  activityType?: ActivityType;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface ActivityRepository {
  list(filter: ListActivitiesFilter): Promise<Page<Activity>>;
  findById(id: string): Promise<Activity | null>;

  /**
   * Records an activity. There is no update and no delete, by design.
   *
   * PRD 9.4 makes the log append-only, so the only way to change what it says
   * is `correct`, which writes a new entry pointing at the original.
   */
  record(input: {
    caseId: string;
    occurredAt?: string | null;
    activityType: ActivityType;
    description: string;
    location?: string | null;
    relatedTaskId?: string | null;
    classification: ClassificationLevel;
  }): Promise<Activity>;

  correct(input: {
    correctsActivityId: string;
    correctionReason: string;
    occurredAt?: string | null;
    activityType: ActivityType;
    description: string;
    location?: string | null;
    classification: ClassificationLevel;
  }): Promise<Activity>;
}

/* --------------------------------------------------- investigation plans */

export interface PlanRepository {
  /** The plan for a case, with every version. Null until one is started. */
  forCase(caseId: string): Promise<InvestigationPlan | null>;

  /**
   * Starts the next version.
   *
   * Version 1 creates the plan itself. A later version copies nothing: PRD
   * 9.3's "changes require re-approval" means the new version is drafted on
   * its own terms, and the caller supplies it.
   */
  createVersion(input: {
    caseId: string;
    objective: string;
    scope?: string | null;
    methodology: string;
    sourcesToConsult: string[];
    assignedPersonnel: string[];
    timeline?: string | null;
    risks?: string | null;
    resources?: string | null;
    expectedDeliverables: string[];
  }): Promise<PlanVersion>;

  updateVersion(
    id: string,
    input: {
      objective?: string;
      scope?: string | null;
      methodology?: string;
      sourcesToConsult?: string[];
      assignedPersonnel?: string[];
      timeline?: string | null;
      risks?: string | null;
      resources?: string | null;
      expectedDeliverables?: string[];
      expectedVersion: number;
    },
  ): Promise<PlanVersion>;

  submitVersion(id: string): Promise<PlanVersion>;

  /**
   * Approves or returns a submitted version.
   *
   * Approving supersedes whatever was approved before, in the same
   * transaction, so a case never has two approved plans.
   */
  reviewVersion(input: {
    id: string;
    approve: boolean;
    notes?: string | null;
  }): Promise<PlanVersion>;
}
