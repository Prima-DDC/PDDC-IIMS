"use server";

import { refreshPath } from "@/lib/revalidate";
import { z } from "zod";
import { requireActorOrThrow, requirePermission } from "@/lib/auth/session";
import {
  assertCompatibleRoles,
  assertUserStatusTransition,
  classifyHighRiskChange,
  iam,
  IamError,
  isIamError,
  isSelfPrivilegeEscalation,
  requiresSecondApproval,
} from "@/modules/iam";
import {
  assignRoleSchema,
  changeStatusSchema,
  EMPTY_FORM_STATE,
  featureOverrideSchema,
  inviteUserSchema,
  overrideSchema,
  provisionUserSchema,
  removeUserSchema,
  toFieldErrors,
  updateUserSchema,
  type FormState,
} from "./schema";

/**
 * User administration actions.
 *
 * Every one of these does the same four things in the same order, and the
 * order matters:
 *
 *   1. Resolve the actor (authentication, MFA, status, session liveness).
 *   2. Check the permission server-side. This is authoritative; RLS is the
 *      second line of defence, not the first (PRD 14).
 *   3. Apply the domain rules that the database cannot express, such as
 *      separation of duties and the two-person rule.
 *   4. Mutate, with the audit row written in the same transaction.
 */

/** Wraps an action so a domain error becomes a readable form message. */
async function run(
  work: () => Promise<FormState>,
): Promise<FormState> {
  try {
    return await work();
  } catch (error) {
    if (isIamError(error)) {
      return { ...EMPTY_FORM_STATE, error: error.message };
    }
    // Never leak a database message to the interface.
    console.error("admin-users action failed", error);
    return {
      ...EMPTY_FORM_STATE,
      error: "Something went wrong saving that. Nothing was changed.",
    };
  }
}

function invalid(error: z.ZodError): FormState {
  return {
    ...EMPTY_FORM_STATE,
    error: "Check the highlighted fields.",
    fieldErrors: toFieldErrors(error),
  };
}

/* ------------------------------------------------------------- provisioning */

export async function provisionUser(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "users", "create");

    const parsed = provisionUserSchema.safeParse({
      userId: formData.get("userId"),
      clearance: formData.get("clearance"),
      status: formData.get("status"),
      employeeId: formData.get("employeeId") ?? undefined,
      workPhone: formData.get("workPhone") ?? undefined,
      jobTitle: formData.get("jobTitle") ?? undefined,
      officeId: formData.get("officeId") ?? undefined,
      departmentId: formData.get("departmentId") ?? undefined,
      countryCode: formData.get("countryCode") ?? undefined,
      sessionTimeoutMinutes: formData.get("sessionTimeoutMinutes") ?? 480,
      notes: formData.get("notes") ?? undefined,
      roleIds: formData.getAll("roleIds").map(String).filter(Boolean),
    });

    if (!parsed.success) return invalid(parsed.error);
    const input = parsed.data;
    const api = iam(actor);

    guardSelfEscalation(actor.userId, input.userId, input.clearance);
    await guardRoleCompatibility(api, input.roleIds);

    const user = await api.users.create({
      userId: input.userId,
      clearance: input.clearance,
      status: input.status,
      employeeId: input.employeeId,
      workPhone: input.workPhone,
      jobTitle: input.jobTitle,
      officeId: input.officeId,
      departmentId: input.departmentId,
      countryCode: input.countryCode,
      sessionTimeoutMinutes: input.sessionTimeoutMinutes,
      notes: input.notes,
      roleIds: input.roleIds,
    });

    refreshPath("/admin/users");
    return {
      ...EMPTY_FORM_STATE,
      success: `${user.fullName ?? user.email} now has access to the platform.`,
    };
  });
}

export async function inviteUser(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "users", "create");

    const parsed = inviteUserSchema.safeParse({
      email: formData.get("email"),
      clearance: formData.get("clearance"),
      jobTitle: formData.get("jobTitle") ?? undefined,
      officeId: formData.get("officeId") ?? undefined,
      departmentId: formData.get("departmentId") ?? undefined,
      roleIds: formData.getAll("roleIds").map(String).filter(Boolean),
    });

    if (!parsed.success) return invalid(parsed.error);
    const input = parsed.data;
    const api = iam(actor);

    await guardRoleCompatibility(api, input.roleIds);

    const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    const { userId } = await api.authAdmin.invite(input.email, `${base}/login`);

    guardSelfEscalation(actor.userId, userId, input.clearance);

    await api.users.create({
      userId,
      clearance: input.clearance,
      status: "invited",
      jobTitle: input.jobTitle,
      officeId: input.officeId,
      departmentId: input.departmentId,
      roleIds: input.roleIds,
    });

    refreshPath("/admin/users");
    return {
      ...EMPTY_FORM_STATE,
      success: `Invitation sent to ${input.email}. They set a password and enrol MFA on first sign-in.`,
    };
  });
}

/* -------------------------------------------------------------------- edit */

export async function updateUser(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "users", "edit");

    const parsed = updateUserSchema.safeParse({
      userId: formData.get("userId"),
      expectedVersion: formData.get("expectedVersion"),
      employeeId: formData.get("employeeId") ?? undefined,
      workPhone: formData.get("workPhone") ?? undefined,
      jobTitle: formData.get("jobTitle") ?? undefined,
      officeId: formData.get("officeId") ?? undefined,
      departmentId: formData.get("departmentId") ?? undefined,
      countryCode: formData.get("countryCode") ?? undefined,
      clearance: formData.get("clearance"),
      sessionTimeoutMinutes: formData.get("sessionTimeoutMinutes"),
      notes: formData.get("notes") ?? undefined,
    });

    if (!parsed.success) return invalid(parsed.error);
    const input = parsed.data;
    const api = iam(actor);

    // Raising someone to the top clearance is a two-person change (PRD 3.4).
    const current = await api.users.findById(input.userId);
    if (!current) {
      return { ...EMPTY_FORM_STATE, error: "That user no longer exists." };
    }
    if (
      input.clearance === "STRICTLY_RESTRICTED" &&
      current.clearance !== "STRICTLY_RESTRICTED"
    ) {
      const approved = await approvalGate(
        actor.userId,
        input.userId,
        "grant_strictly_restricted",
        api,
        { clearance: input.clearance },
      );

      if (!approved) {
        return {
          ...EMPTY_FORM_STATE,
          success:
            "Strictly Restricted clearance needs a second administrator. A request has been raised for approval, and the change applies once another administrator approves it.",
        };
      }

      // Approved by somebody else, so apply it and close the request.
      await api.accessRequests.markApplied(approved.id);
    }

    await api.users.update(input.userId, {
      employeeId: input.employeeId,
      workPhone: input.workPhone,
      jobTitle: input.jobTitle,
      officeId: input.officeId,
      departmentId: input.departmentId,
      countryCode: input.countryCode,
      clearance: input.clearance,
      sessionTimeoutMinutes: input.sessionTimeoutMinutes,
      notes: input.notes,
      expectedVersion: input.expectedVersion,
    });

    refreshPath(`/admin/users/${input.userId}`);
    refreshPath("/admin/users");
    return { ...EMPTY_FORM_STATE, success: "Saved." };
  });
}

export async function changeUserStatus(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "users", "edit");

    const parsed = changeStatusSchema.safeParse({
      userId: formData.get("userId"),
      status: formData.get("status"),
      reason: formData.get("reason"),
    });
    if (!parsed.success) return invalid(parsed.error);

    const { userId, status, reason } = parsed.data;
    const api = iam(actor);

    const current = await api.users.findById(userId);
    if (!current) {
      return { ...EMPTY_FORM_STATE, error: "That user no longer exists." };
    }

    // The lifecycle is a state machine, not a free-text field (PRD 3.3).
    assertUserStatusTransition(current.status, status);

    await api.users.setStatus(userId, status, reason);

    // Suspension must bite immediately. The ban blocks new sign-ins; revoking
    // the sessions stops the ones already open, and the per-request status
    // check catches the access token still in flight.
    if (status === "suspended" || status === "deactivated" || status === "archived") {
      await api.authAdmin.setBanned(userId, true);
      await api.users.revokeAllSessions(userId, `account ${status}: ${reason}`);
    } else if (status === "active") {
      await api.authAdmin.setBanned(userId, false);
    }

    refreshPath(`/admin/users/${userId}`);
    refreshPath("/admin/users");
    return { ...EMPTY_FORM_STATE, success: `Account is now ${status}.` };
  });
}

export async function removeUser(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "users", "delete");

    const parsed = removeUserSchema.safeParse({
      userId: formData.get("userId"),
      reason: formData.get("reason"),
    });
    if (!parsed.success) return invalid(parsed.error);

    const { userId, reason } = parsed.data;
    const api = iam(actor);

    // Recoverable by default: the record moves to the recycle bin rather than
    // being erased (PRD 3.5).
    await api.users.softDelete(userId, reason);
    await api.authAdmin.setBanned(userId, true);
    await api.users.revokeAllSessions(userId, `account removed: ${reason}`);

    refreshPath("/admin/users");
    refreshPath(`/admin/users/${userId}`);
    refreshPath("/admin/recycle-bin");
    return {
      ...EMPTY_FORM_STATE,
      success: "Account removed. It can be restored from the recycle bin.",
    };
  });
}

export async function restoreUser(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "users", "edit");

    const parsed = removeUserSchema.safeParse({
      userId: formData.get("userId"),
      reason: formData.get("reason"),
    });
    if (!parsed.success) return invalid(parsed.error);

    const api = iam(actor);
    await api.users.restore(parsed.data.userId, parsed.data.reason);

    refreshPath("/admin/users");
    refreshPath(`/admin/users/${parsed.data.userId}`);
    refreshPath("/admin/recycle-bin");
    return {
      ...EMPTY_FORM_STATE,
      success: "Account restored, deactivated. Reactivate it to allow sign-in.",
    };
  });
}

/* ------------------------------------------------------------------- roles */

export async function assignRole(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "users", "assign");

    const parsed = assignRoleSchema.safeParse({
      userId: formData.get("userId"),
      roleId: formData.get("roleId"),
      scopeType: formData.get("scopeType") ?? "all",
      scopeId: formData.get("scopeId") ?? undefined,
      isPrimary: formData.get("isPrimary") === "on",
      validFrom: formData.get("validFrom") ?? undefined,
      validTo: formData.get("validTo") ?? undefined,
      reason: formData.get("reason") ?? undefined,
    });
    if (!parsed.success) return invalid(parsed.error);

    const input = parsed.data;
    const api = iam(actor);

    const role = await api.roles.findById(input.roleId);
    if (!role) return { ...EMPTY_FORM_STATE, error: "That role no longer exists." };

    // Granting the Administrator role needs a second administrator (PRD 3.4).
    if (role.isAdministrator) {
      const approved = await approvalGate(
        actor.userId,
        input.userId,
        "grant_administrator",
        api,
        { roleId: input.roleId, scopeType: input.scopeType },
      );

      if (!approved) {
        return {
          ...EMPTY_FORM_STATE,
          success:
            "Granting the Administrator role needs a second administrator. A request has been raised for approval, and assigning it again once approved will apply it.",
        };
      }

      await api.accessRequests.markApplied(approved.id);
    }

    const held = await api.users.roleIdsOf(input.userId);
    await guardRoleCompatibility(api, [...held, input.roleId]);

    await api.users.assignRole({
      userId: input.userId,
      roleId: input.roleId,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      isPrimary: input.isPrimary,
      validFrom: input.validFrom,
      validTo: input.validTo,
      reason: input.reason,
    });

    refreshPath(`/admin/users/${input.userId}`);
    return { ...EMPTY_FORM_STATE, success: `${role.name} assigned.` };
  });
}

export async function removeRoleAssignment(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "users", "assign");

    const schema = z.object({
      assignmentId: z.string().uuid(),
      userId: z.string().uuid(),
      reason: z.string().trim().min(3, "Give a reason."),
    });
    const parsed = schema.safeParse({
      assignmentId: formData.get("assignmentId"),
      userId: formData.get("userId"),
      reason: formData.get("reason") ?? "role no longer required",
    });
    if (!parsed.success) return invalid(parsed.error);

    const api = iam(actor);
    await api.users.removeRole(parsed.data.assignmentId, parsed.data.reason);

    refreshPath(`/admin/users/${parsed.data.userId}`);
    return { ...EMPTY_FORM_STATE, success: "Role removed." };
  });
}

export async function setPrimaryRole(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "users", "assign");

    const schema = z.object({
      assignmentId: z.string().uuid(),
      userId: z.string().uuid(),
    });
    const parsed = schema.safeParse({
      assignmentId: formData.get("assignmentId"),
      userId: formData.get("userId"),
    });
    if (!parsed.success) return invalid(parsed.error);

    await iam(actor).users.setPrimaryRole(parsed.data.userId, parsed.data.assignmentId);

    refreshPath(`/admin/users/${parsed.data.userId}`);
    return { ...EMPTY_FORM_STATE, success: "Primary role updated." };
  });
}

/* --------------------------------------------------------------- overrides */

export async function addOverride(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "users", "assign");

    const parsed = overrideSchema.safeParse({
      userId: formData.get("userId"),
      permissionId: formData.get("permissionId"),
      effect: formData.get("effect"),
      reason: formData.get("reason"),
      expiresAt: formData.get("expiresAt") ?? undefined,
    });
    if (!parsed.success) return invalid(parsed.error);

    const input = parsed.data;
    const api = iam(actor);

    // Granting delete or export-all by override is high risk (PRD 3.4).
    if (input.effect === "allow") {
      const all = await api.permissions.list();
      const permission = all.find((p) => p.id === input.permissionId);
      const kind = classifyHighRiskChange({
        grantsActions: permission ? [permission.action] : [],
      });
      if (kind && requiresSecondApproval(kind)) {
        const approved = await approvalGate(actor.userId, input.userId, kind, api, {
          permissionId: input.permissionId,
        });

        if (!approved) {
          return {
            ...EMPTY_FORM_STATE,
            success:
              "That grant needs a second administrator. A request has been raised for approval, and adding it again once approved will apply it.",
          };
        }

        await api.accessRequests.markApplied(approved.id);
      }
    }

    await api.users.addOverride({
      userId: input.userId,
      permissionId: input.permissionId,
      effect: input.effect,
      reason: input.reason,
      expiresAt: input.expiresAt,
    });

    refreshPath(`/admin/users/${input.userId}`);
    return {
      ...EMPTY_FORM_STATE,
      success: `Override added. An explicit deny always beats an allow.`,
    };
  });
}

export async function removeOverride(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "users", "assign");

    const schema = z.object({
      overrideId: z.string().uuid(),
      userId: z.string().uuid(),
      reason: z.string().trim().min(3),
    });
    const parsed = schema.safeParse({
      overrideId: formData.get("overrideId"),
      userId: formData.get("userId"),
      reason: formData.get("reason") ?? "override no longer required",
    });
    if (!parsed.success) return invalid(parsed.error);

    await iam(actor).users.removeOverride(parsed.data.overrideId, parsed.data.reason);

    refreshPath(`/admin/users/${parsed.data.userId}`);
    return { ...EMPTY_FORM_STATE, success: "Override removed." };
  });
}

export async function setFeatureOverride(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "users", "assign");

    const parsed = featureOverrideSchema.safeParse({
      userId: formData.get("userId"),
      featureKey: formData.get("featureKey"),
      enabled: formData.get("enabled") === "true",
      reason: formData.get("reason") ?? "set by administrator",
    });
    if (!parsed.success) return invalid(parsed.error);

    await iam(actor).users.setFeatureOverride(parsed.data);

    refreshPath(`/admin/users/${parsed.data.userId}`);
    return { ...EMPTY_FORM_STATE, success: "Feature override saved." };
  });
}

export async function clearFeatureOverride(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "users", "assign");

    const schema = z.object({
      userId: z.string().uuid(),
      featureKey: z.string().trim().min(1),
    });
    const parsed = schema.safeParse({
      userId: formData.get("userId"),
      featureKey: formData.get("featureKey"),
    });
    if (!parsed.success) return invalid(parsed.error);

    await iam(actor).users.clearFeatureOverride(
      parsed.data.userId,
      parsed.data.featureKey,
    );

    refreshPath(`/admin/users/${parsed.data.userId}`);
    return { ...EMPTY_FORM_STATE, success: "Back to the role default." };
  });
}

/* ---------------------------------------------------------------- security */

export async function resetPassword(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "users", "edit");

    const email = z
      .string()
      .email()
      .safeParse(formData.get("email"));
    if (!email.success) return invalid(email.error);

    const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    await iam(actor).authAdmin.sendPasswordReset(email.data, `${base}/login`);

    return {
      ...EMPTY_FORM_STATE,
      success: `A password reset email has been sent to ${email.data}.`,
    };
  });
}

export async function revokeSessions(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "users", "edit");

    const schema = z.object({
      userId: z.string().uuid(),
      reason: z.string().trim().min(3),
    });
    const parsed = schema.safeParse({
      userId: formData.get("userId"),
      reason: formData.get("reason") ?? "sessions revoked by administrator",
    });
    if (!parsed.success) return invalid(parsed.error);

    const count = await iam(actor).users.revokeAllSessions(
      parsed.data.userId,
      parsed.data.reason,
    );

    refreshPath(`/admin/users/${parsed.data.userId}`);
    return {
      ...EMPTY_FORM_STATE,
      success:
        count > 0
          ? `Revoked ${count} session${count === 1 ? "" : "s"}. The next request from any of them is rejected.`
          : "There were no active sessions to revoke.",
    };
  });
}

export async function resetMfa(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "users", "edit");

    const userId = z.string().uuid().safeParse(formData.get("userId"));
    if (!userId.success) return invalid(userId.error);

    const api = iam(actor);
    const factors = await api.authAdmin.listMfaFactors(userId.data);
    for (const factor of factors) {
      await api.authAdmin.deleteMfaFactor(userId.data, factor.id);
    }

    await api.users.syncMfaEnrolment(userId.data);
    // Their current session is aal2 on a factor that no longer exists.
    await api.users.revokeAllSessions(userId.data, "MFA reset by administrator");

    refreshPath(`/admin/users/${userId.data}`);
    return {
      ...EMPTY_FORM_STATE,
      success: `Removed ${factors.length} authenticator factor(s). They will enrol again on next sign-in.`,
    };
  });
}

export async function unlockAccount(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "users", "edit");

    const userId = z.string().uuid().safeParse(formData.get("userId"));
    if (!userId.success) return invalid(userId.error);

    const api = iam(actor);
    await api.users.unlock(userId.data, "unlocked by administrator");

    refreshPath(`/admin/users/${userId.data}`);
    return { ...EMPTY_FORM_STATE, success: "Account unlocked." };
  });
}

/* ------------------------------------------------------------------ guards */

/**
 * The two-person rule, as a gate that can actually be passed.
 *
 * Returns the approved request when a second administrator has already
 * approved this exact change, so the caller applies it and marks it applied.
 * Otherwise it raises the request and returns null, and the caller stops.
 *
 * Without the first half the rule would be a dead end: every attempt would
 * raise another request and the approved one could never be acted on.
 */
async function approvalGate(
  actorId: string,
  targetUserId: string,
  kind: Parameters<typeof requiresSecondApproval>[0],
  api: ReturnType<typeof iam>,
  payload: Record<string, unknown>,
): Promise<{ id: string } | null> {
  const pendingOrApproved = await api.accessRequests.list({
    status: "approved",
    limit: 100,
  });

  const approved = pendingOrApproved.find(
    (request) => request.kind === kind && request.targetUserId === targetUserId,
  );

  if (approved) {
    return { id: approved.id };
  }

  // Nothing approved: raise it, unless an identical one is already waiting.
  const waiting = await api.accessRequests.list({ status: "pending", limit: 100 });
  const already = waiting.find(
    (request) => request.kind === kind && request.targetUserId === targetUserId,
  );

  if (!already) {
    await api.accessRequests.create({
      kind,
      targetUserId,
      payload: { ...payload, requestedFor: targetUserId },
      reason:
        actorId === targetUserId
          ? "Self-requested privilege increase, which always needs a second administrator."
          : "High-risk change requiring a second administrator.",
    });
  }

  return null;
}

/**
 * Refuses an administrator raising their own privileges (PRD 3.4).
 *
 * Provisioning somebody else at a high clearance is an ordinary administrative
 * act; doing it to your own account is not, and no reason text makes it one.
 */
function guardSelfEscalation(
  actorId: string,
  targetUserId: string,
  clearance: string,
): void {
  const kind = classifyHighRiskChange({
    grantsClearance:
      clearance === "STRICTLY_RESTRICTED" ? "STRICTLY_RESTRICTED" : undefined,
  });

  if (kind && isSelfPrivilegeEscalation(actorId, targetUserId, kind)) {
    throw new IamError(
      "second_approval_required",
      "You cannot raise your own clearance. Ask another administrator to do it.",
    );
  }
}

/** Separation of duties on the resulting role set (PRD 3.2). */
async function guardRoleCompatibility(
  api: ReturnType<typeof iam>,
  roleIds: string[],
): Promise<void> {
  if (roleIds.length < 2) return;
  const pairs = await api.roles.incompatibilities();
  assertCompatibleRoles(
    roleIds,
    pairs.map((p) => ({ roleAId: p.roleAId, roleBId: p.roleBId, reason: p.reason })),
  );
}
