import { IamError } from "./errors";
import {
  canTransitionUserStatus,
  type AccessRequestKind,
  type EffectivePermission,
  type PermissionScope,
  type Role,
  type UserStatus,
} from "./types";
import {
  clearsClassification,
  type ClassificationLevel,
} from "./classification";

/**
 * Authorization and governance rules, as pure functions.
 *
 * These are the rules the database cannot express on its own, either because
 * they depend on the record being acted upon (you may not approve work you
 * authored) or because they are decisions rather than constraints (which
 * changes need a second administrator).
 *
 * Keeping them here, free of SQL and framework, is what makes them testable in
 * isolation and reusable from any entry point.
 */

/**
 * Changes that require a second administrator's approval (PRD 3.4).
 *
 * "Two-person rule for high-risk changes: granting the Administrator role,
 *  granting STRICTLY RESTRICTED clearance, granting delete or export-all
 *  permissions, changing audit or retention settings."
 */
const HIGH_RISK_KINDS = new Set<AccessRequestKind>([
  "grant_administrator",
  "grant_strictly_restricted",
  "grant_delete",
  "grant_export_all",
  "change_audit_settings",
  "change_retention",
  "purge_record",
  "remove_administrator",
]);

export function requiresSecondApproval(kind: AccessRequestKind): boolean {
  return HIGH_RISK_KINDS.has(kind);
}

/**
 * Which high-risk request a proposed change amounts to, or null when it is an
 * ordinary change.
 *
 * Centralised so a new high-risk field cannot be added to an edit form and
 * quietly escape the two-person rule.
 */
export function classifyHighRiskChange(change: {
  grantsAdministratorRole?: boolean;
  revokesAdministratorRole?: boolean;
  grantsClearance?: ClassificationLevel;
  grantsActions?: readonly string[];
  changesAuditSettings?: boolean;
  changesRetention?: boolean;
  purgesRecord?: boolean;
}): AccessRequestKind | null {
  if (change.purgesRecord) return "purge_record";
  if (change.changesAuditSettings) return "change_audit_settings";
  if (change.changesRetention) return "change_retention";
  if (change.grantsAdministratorRole) return "grant_administrator";
  if (change.revokesAdministratorRole) return "remove_administrator";
  if (change.grantsClearance === "STRICTLY_RESTRICTED") {
    return "grant_strictly_restricted";
  }
  if (change.grantsActions?.includes("delete")) return "grant_delete";
  if (change.grantsActions?.includes("export")) return "grant_export_all";
  return null;
}

/**
 * "An administrator cannot raise their own privileges without second
 *  approval" (PRD 3.4). Self-targeting is always a second-approval case, even
 * for a change that would otherwise be routine.
 */
export function isSelfPrivilegeEscalation(
  actorId: string,
  targetUserId: string | null,
  kind: AccessRequestKind | null,
): boolean {
  return kind !== null && targetUserId === actorId;
}

export function assertNotSelfApproval(requestedBy: string, decidedBy: string): void {
  if (requestedBy === decidedBy) {
    throw new IamError(
      "self_approval_forbidden",
      "A high-risk change must be approved by a different administrator.",
    );
  }
}

/**
 * "The Administrator cannot approve a report or plan they authored
 *  themselves" and "Cannot approve own authored work" (PRD 3.1, 3.5).
 *
 * Applies to every approval in the platform, including the Administrator, so
 * it lives here rather than in any one module.
 */
export function assertNotSelfApprovalOfWork(
  actorId: string,
  authorId: string | null,
  what: string,
): void {
  if (authorId !== null && actorId === authorId) {
    throw new IamError(
      "self_approval_forbidden",
      `You authored this ${what} and cannot approve your own work.`,
    );
  }
}

/**
 * Separation of duties for role pairs (PRD 3.2). `incompatibilities` comes
 * from iam.role_incompatibilities, so administrators configure it.
 */
export function findIncompatibleRolePair(
  roleIds: readonly string[],
  incompatibilities: ReadonlyArray<{ roleAId: string; roleBId: string; reason: string }>,
): { roleAId: string; roleBId: string; reason: string } | null {
  const held = new Set(roleIds);
  for (const pair of incompatibilities) {
    if (held.has(pair.roleAId) && held.has(pair.roleBId)) return pair;
  }
  return null;
}

export function assertCompatibleRoles(
  roleIds: readonly string[],
  incompatibilities: ReadonlyArray<{ roleAId: string; roleBId: string; reason: string }>,
): void {
  const clash = findIncompatibleRolePair(roleIds, incompatibilities);
  if (clash) {
    throw new IamError("incompatible_roles", clash.reason, {
      roleAId: clash.roleAId,
      roleBId: clash.roleBId,
    });
  }
}

export function assertUserStatusTransition(from: UserStatus, to: UserStatus): void {
  if (from === to) return;
  if (!canTransitionUserStatus(from, to)) {
    throw new IamError(
      "illegal_transition",
      `A user cannot move from ${from} to ${to}.`,
      { from, to },
    );
  }
}

/**
 * The baseline role every user holds and which cannot be removed (PRD 3.1).
 */
export function assertRoleIsRemovable(role: Pick<Role, "isBaseline" | "name">): void {
  if (role.isBaseline) {
    throw new IamError(
      "baseline_role_immutable",
      `${role.name} is the baseline role every member of staff holds and cannot be removed.`,
    );
  }
}

/**
 * "A role in use cannot be deleted until its users are moved to another role"
 * (PRD 3.3).
 */
export function assertRoleNotInUse(
  role: Pick<Role, "name">,
  memberCount: number,
): void {
  if (memberCount > 0) {
    throw new IamError(
      "role_in_use",
      `${role.name} is held by ${memberCount} user(s). Reassign them before deleting the role.`,
      { memberCount },
    );
  }
}

/**
 * Explains an authorization outcome, for the Effective Permissions viewer:
 * "why can or can't this user do X?", naming the role or override responsible
 * (PRD 3.2).
 */
export interface PermissionExplanation {
  allowed: boolean;
  reason: string;
  /** The role or override that decided it, when there is one. */
  source: string | null;
}

export function explainPermission(
  permissions: readonly EffectivePermission[],
  query: {
    resource: string;
    action: string;
    classification?: ClassificationLevel;
    clearance: ClassificationLevel;
    isAdministrator: boolean;
    status: UserStatus;
    lockedUntil?: string | null;
  },
): PermissionExplanation {
  if (query.status !== "active") {
    return {
      allowed: false,
      reason: `The account is ${query.status}, so it holds no permissions at all.`,
      source: null,
    };
  }

  if (query.lockedUntil && new Date(query.lockedUntil) > new Date()) {
    return {
      allowed: false,
      reason: "The account is locked after repeated failed sign-ins.",
      source: null,
    };
  }

  if (query.isAdministrator) {
    return {
      allowed: true,
      reason:
        "The Administrator role carries a wildcard grant on every resource and every clearance level.",
      source: "role:administrator",
    };
  }

  const matches = permissions.filter(
    (p) =>
      (p.resource === query.resource || p.resource === "*") &&
      (p.action === query.action || p.action === "*"),
  );

  if (matches.length === 0) {
    return {
      allowed: false,
      reason: `No active role or override grants ${query.action} on ${query.resource}.`,
      source: null,
    };
  }

  if (query.classification) {
    const cleared = matches.filter((p) =>
      clearsClassification(p.classificationCeiling, query.classification!),
    );

    if (cleared.length === 0) {
      const best = matches.reduce((a, b) =>
        clearsClassification(a.classificationCeiling, b.classificationCeiling) ? a : b,
      );
      return {
        allowed: false,
        reason: `${best.source} grants ${query.action} on ${query.resource} only up to ${best.classificationCeiling}, below the required ${query.classification}.`,
        source: best.source,
      };
    }

    if (!clearsClassification(query.clearance, query.classification)) {
      return {
        allowed: false,
        reason: `The role would allow it, but this user's personal clearance is ${query.clearance}, below the required ${query.classification}. Clearance is assigned per user and is never granted by a role.`,
        source: null,
      };
    }

    return {
      allowed: true,
      reason: `${cleared[0].source} grants ${query.action} on ${query.resource} up to ${cleared[0].classificationCeiling}, at scope ${cleared[0].scope}.`,
      source: cleared[0].source,
    };
  }

  const widest = matches.reduce((a, b) => (scopeOrder(a.scope) >= scopeOrder(b.scope) ? a : b));
  return {
    allowed: true,
    reason: `${widest.source} grants ${query.action} on ${query.resource} at scope ${widest.scope}.`,
    source: widest.source,
  };
}

function scopeOrder(scope: PermissionScope): number {
  return ["own", "assigned", "team", "department", "office", "country", "all"].indexOf(scope);
}

/**
 * Deny-overrides-allow, applied to a resolved permission list.
 *
 * The database already does this in iam.effective_permissions. This exists so
 * the same rule can be unit-tested and reused when a list is assembled from
 * anywhere else, and so the two implementations can be compared.
 */
export function applyDenyOverrides(
  granted: readonly EffectivePermission[],
  denied: ReadonlyArray<{ resource: string; action: string }>,
): EffectivePermission[] {
  if (denied.length === 0) return [...granted];
  const blocked = new Set(denied.map((d) => `${d.resource}:${d.action}`));
  return granted.filter((g) => !blocked.has(`${g.resource}:${g.action}`));
}
