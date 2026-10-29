import "server-only";
import type postgres from "postgres";
import type { Actor } from "@/lib/auth/session";
import { actorContext } from "@/lib/auth/session";
import {
  createActivityRepository,
  createPlanRepository,
} from "./infrastructure/activity-repository";
import { createCaseRepository } from "./infrastructure/case-repository";
import { createFinanceRepository } from "./infrastructure/finance-repository";
import { createSafetyRepository } from "./infrastructure/safety-repository";
import { createTaskRepository } from "./infrastructure/task-repository";
import { createWorkflowRepository } from "./infrastructure/workflow-repository";

/**
 * The casework module's public surface, and its composition root.
 *
 * The case is the centre of the platform (PRD 18, "every screen is
 * case-centric"), and this is where the chain
 * Case -> Subject -> Source -> Information -> Evidence -> Analysis -> Finding
 * -> Report starts. Everything outside this module imports from here and
 * nothing deeper, which eslint enforces.
 *
 * An optional transaction can be passed in, and the read paths do: a screen
 * that calls eight repository methods opens eight transactions otherwise, and
 * each one costs a BEGIN, a set_config, the query and a COMMIT. Measured
 * against this database, ten reads as ten transactions took 2843ms and the
 * same ten inside one transaction took 633ms, because postgres.js pipelines
 * concurrent queries down a single connection. A write still opens its own,
 * so a failure rolls back exactly what it should.
 *
 * Repositories are built per request from the caller's Actor, so the identity
 * used for row-level security and for the audit trail is never ambient. That
 * matters more here than anywhere else: casework row-level security is
 * assignment-aware, so a repository built with the wrong actor would see the
 * wrong cases rather than merely attribute a change to the wrong person.
 */

export function casework(actor: Actor, tx?: postgres.TransactionSql) {
  const ctx = actorContext(actor);

  return {
    cases: createCaseRepository(ctx, tx),
    tasks: createTaskRepository(ctx, tx),
    activities: createActivityRepository(ctx, tx),
    plans: createPlanRepository(ctx, tx),
    workflow: createWorkflowRepository(ctx, tx),
    safety: createSafetyRepository(ctx, tx),
    finance: createFinanceRepository(ctx, tx),
  };
}

export type Casework = ReturnType<typeof casework>;

/* ------------------------------------------- domain, types and pure rules */

// Re-exported from the client-safe barrel so server code needs one import.
// A client component must import "@/modules/casework/shared" directly,
// because this file pulls in the database client.
export * from "./shared";

/* ------------------------------------------------------------------ ports */

export type {
  CaseRepository,
  CreateCaseInput,
  ListCasesFilter,
  Page,
  UpdateCaseInput,
  WorkflowRepository,
} from "./application/ports";

export type {
  ListCheckInsFilter,
  ListIncidentsFilter,
  SafetyPlanInput,
  SafetyRepository,
} from "./application/safety-ports";

export type {
  FinanceRepository,
  FinancialsInput,
  ListExpensesFilter,
  ListTimeEntriesFilter,
} from "./application/finance-ports";

export type {
  ActivityRepository,
  CreateTaskInput,
  ListActivitiesFilter,
  ListTasksFilter,
  PlanRepository,
  TaskRepository,
  UpdateTaskInput,
} from "./application/task-ports";
