import "server-only";
import type postgres from "postgres";
import type { Actor } from "@/lib/auth/session";
import { actorContext } from "@/lib/auth/session";
import { createClientRepository } from "./infrastructure/client-repository";
import { createEngagementRepository } from "./infrastructure/engagement-repository";
import { createIntakeRepository } from "./infrastructure/intake-repository";

/**
 * The CRM module's public surface, and its composition root.
 *
 * Clients, engagements and intake, which is the Client -> Engagement -> Case
 * chain the rest of the platform hangs off (PRD 8). Everything outside this
 * module imports from here and nothing deeper, which eslint enforces.
 *
 * Repositories are built per request from the caller's Actor, so the identity
 * used for row-level security and for the audit trail is never ambient.
 */

export function crm(actor: Actor, tx?: postgres.TransactionSql) {
  const ctx = actorContext(actor);

  return {
    clients: createClientRepository(ctx, tx),
    engagements: createEngagementRepository(ctx, tx),
    intake: createIntakeRepository(ctx, tx),
  };
}

export type Crm = ReturnType<typeof crm>;

/* ------------------------------------------- domain, types and pure rules */

// Re-exported from the client-safe barrel so server code needs one import.
// A client component must import "@/modules/crm/shared" directly, because
// this file pulls in the database client.
export * from "./shared";

/* ------------------------------------------------------------------ ports */

export type {
  ClientRepository,
  CreateClientInput,
  CreateEnquiryInput,
  CreateEngagementInput,
  EngagementRepository,
  IntakeRepository,
  ListClientsFilter,
  ListEngagementsFilter,
  ListEnquiriesFilter,
  Page,
  UpdateClientInput,
  UpdateEngagementInput,
  UpdateEnquiryInput,
} from "./application/ports";
