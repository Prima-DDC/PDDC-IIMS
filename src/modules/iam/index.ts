import "server-only";
import type postgres from "postgres";
import type { Actor } from "@/lib/auth/session";
import { actorContext } from "@/lib/auth/session";
import { createAuthAdmin } from "./infrastructure/auth-admin";
import {
  createAccessRequestRepository,
  createAuditRepository,
} from "./infrastructure/audit-repository";
import {
  createFeatureRepository,
  createOrgRepository,
  createPermissionRepository,
  createRoleRepository,
} from "./infrastructure/role-repository";
import { createUserRepository } from "./infrastructure/user-repository";

/**
 * The IAM module's public surface, and its composition root.
 *
 * Everything outside this module imports from here and nothing deeper, which
 * eslint enforces (PRD 21.1). This is the one file that is allowed to know
 * both the application's ports and the concrete adapters that satisfy them.
 *
 * Repositories are created per request from the caller's Actor, so the
 * identity used for row-level security and for the audit trail is never
 * ambient or shared between requests.
 */

export function iam(actor: Actor, tx?: postgres.TransactionSql) {
  const ctx = actorContext(actor);

  return {
    users: createUserRepository(ctx, tx),
    roles: createRoleRepository(ctx, tx),
    permissions: createPermissionRepository(ctx, tx),
    features: createFeatureRepository(ctx, tx),
    org: createOrgRepository(ctx, tx),
    audit: createAuditRepository(ctx, tx),
    accessRequests: createAccessRequestRepository(ctx, tx),
    authAdmin: createAuthAdmin(),
  };
}

export type Iam = ReturnType<typeof iam>;

/* ------------------------------------------- domain, types and pure rules */

// Re-exported from the client-safe barrel so server code needs one import.
// A client component must import "@/modules/iam/shared" directly, because
// this file pulls in the database client.
export * from "./shared";

/* ------------------------------------------------------------------ ports */

export type {
  AccessRequestRepository,
  AuditRepository,
  AuthAdminPort,
  CreateUserInput,
  FeatureRepository,
  ListUsersFilter,
  OrgRepository,
  Page,
  PermissionRepository,
  RoleRepository,
  UpdateUserInput,
  UserRepository,
} from "./application/ports";
