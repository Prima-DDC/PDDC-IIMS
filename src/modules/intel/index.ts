import "server-only";
import type postgres from "postgres";
import type { Actor } from "@/lib/auth/session";
import { actorContext } from "@/lib/auth/session";
import {
  createCaseSubjectRepository,
  createEntityRepository,
  createRelationshipRepository,
  createResolutionRepository,
} from "./infrastructure/entity-repository";
import {
  createInformationRepository,
  createSourceRepository,
} from "./infrastructure/source-repository";
import { createFindingRepository } from "./infrastructure/finding-repository";

/**
 * The intelligence module's public surface, and its composition root.
 *
 * The two ends of the chain the platform exists to keep intact:
 *
 *   Case -> Subject -> Source -> Information -> Evidence -> Analysis ->
 *   Finding -> Report
 *
 * Everything outside this module imports from here and nothing deeper, which
 * eslint enforces.
 */

export function intel(actor: Actor, tx?: postgres.TransactionSql) {
  const ctx = actorContext(actor);

  return {
    entities: createEntityRepository(ctx, tx),
    subjects: createCaseSubjectRepository(ctx, tx),
    relationships: createRelationshipRepository(ctx, tx),
    resolution: createResolutionRepository(ctx, tx),
    sources: createSourceRepository(ctx, tx),
    information: createInformationRepository(ctx, tx),
    findings: createFindingRepository(ctx, tx),
  };
}

export type Intel = ReturnType<typeof intel>;

/* ------------------------------------------- domain, types and pure rules */

// Re-exported from the client-safe barrel so server code needs one import.
// A client component must import "@/modules/intel/shared" directly, because
// this file pulls in the database client.
export * from "./shared";

/* ------------------------------------------------------------------ ports */

export type {
  CaseSubjectRepository,
  EntityInput,
  EntityRepository,
  FindingRepository,
  InformationRepository,
  ListEntitiesFilter,
  ListFindingsFilter,
  ListInformationFilter,
  ListSourcesFilter,
  Page,
  RelationshipRepository,
  ResolutionRepository,
  SourceRepository,
} from "./application/ports";
