import "server-only";
import type postgres from "postgres";
import type { Actor } from "@/lib/auth/session";
import { actorContext } from "@/lib/auth/session";
import {
  createCustodyRepository,
  createEvidenceRepository,
} from "./infrastructure/evidence-repository";
import { createDocumentRepository } from "./infrastructure/document-repository";

/**
 * The evidence module's public surface, and its composition root.
 *
 * This is the middle of the chain the whole platform exists to keep intact:
 * Case -> Subject -> Source -> Information -> **Evidence** -> Analysis ->
 * Finding -> Report. Everything outside this module imports from here and
 * nothing deeper, which eslint enforces.
 *
 * Documents live here rather than in a module of their own because they share
 * the same two problems: a file in object storage with a hash that has to be
 * shown to still match, and a version history that cannot be rewritten. The
 * rules differ (PRD 6 is write-once, PRD 7 is versioned) and the mechanics do
 * not.
 */

export function evidence(actor: Actor, tx?: postgres.TransactionSql) {
  const ctx = actorContext(actor);

  return {
    items: createEvidenceRepository(ctx, tx),
    custody: createCustodyRepository(ctx, tx),
    documents: createDocumentRepository(ctx, tx),
  };
}

export type Evidence = ReturnType<typeof evidence>;

/* ------------------------------------------- domain, types and pure rules */

// Re-exported from the client-safe barrel so server code needs one import.
// A client component must import "@/modules/evidence/shared" directly,
// because this file pulls in the database client.
export * from "./shared";

/* ------------------------------------------------------------------ ports */

export type {
  AttachFileInput,
  CustodyRepository,
  DocumentRepository,
  EvidenceRepository,
  ListDocumentsFilter,
  ListEvidenceFilter,
  Page,
  RegisterEvidenceInput,
} from "./application/ports";
