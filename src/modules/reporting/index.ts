import "server-only";
import type postgres from "postgres";
import type { Actor } from "@/lib/auth/session";
import { actorContext } from "@/lib/auth/session";
import { createReportRepository } from "./infrastructure/report-repository";
import {
  createDeliveryRepository,
  createQaRepository,
} from "./infrastructure/qa-repository";
import {
  createClosureRepository,
  createManagementRepository,
} from "./infrastructure/closure-repository";

/**
 * The reporting module's public surface, and its composition root.
 *
 * The end of the chain the platform exists to keep intact:
 *
 *   Case -> Subject -> Source -> Information -> Evidence -> Analysis ->
 *   Finding -> **Report**
 *
 * Closure lives here too, because PRD 5.9's gate is mostly a question about
 * reports and deliveries, and because the thing it produces is the archive.
 * Everything outside this module imports from here and nothing deeper, which
 * eslint enforces.
 */

export function reporting(actor: Actor, tx?: postgres.TransactionSql) {
  const ctx = actorContext(actor);

  return {
    reports: createReportRepository(ctx, tx),
    qa: createQaRepository(ctx, tx),
    deliveries: createDeliveryRepository(ctx, tx),
    closure: createClosureRepository(ctx, tx),
    management: createManagementRepository(ctx, tx),
  };
}

export type Reporting = ReturnType<typeof reporting>;

/* ------------------------------------------- domain, types and pure rules */

// Re-exported from the client-safe barrel so server code needs one import.
// A client component must import "@/modules/reporting/shared" directly,
// because this file pulls in the database client.
export * from "./shared";

/* ------------------------------------------------------------------ ports */

export type {
  ClosureRepository,
  DeliveryRepository,
  ListReportsFilter,
  ManagementRepository,
  Page,
  QaRepository,
  ReportRepository,
} from "./application/ports";
