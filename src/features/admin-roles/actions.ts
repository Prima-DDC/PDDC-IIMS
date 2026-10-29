"use server";

import { refreshPath } from "@/lib/revalidate";
import { z } from "zod";
import { requireActorOrThrow, requirePermission } from "@/lib/auth/session";
import {
  assertRoleIsRemovable,
  assertRoleNotInUse,
  iam,
  isIamError,
} from "@/modules/iam";
import {
  CLASSIFICATION_LEVELS,
  PERMISSION_ACTIONS,
  PERMISSION_SCOPES,
} from "@/modules/iam/shared";
import { EMPTY_FORM_STATE, toFieldErrors, type FormState } from "../admin-users/schema";

/**
 * Roles, the permission builder, features and organisation units.
 *
 * "Roles and permissions are data, not code: an administrator can add, edit
 *  and remove them without a software release" (PRD 3). These actions are what
 * makes that true.
 */

async function run(work: () => Promise<FormState>): Promise<FormState> {
  try {
    return await work();
  } catch (error) {
    if (isIamError(error)) return { ...EMPTY_FORM_STATE, error: error.message };
    console.error("admin-roles action failed", error);
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

const roleKey = z
  .string()
  .trim()
  .min(2, "At least two characters.")
  .max(40)
  .regex(
    /^[a-z][a-z0-9_]*$/,
    "Lower case letters, digits and underscores, starting with a letter.",
  );

/* ------------------------------------------------------------------- roles */

export async function createRole(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "settings", "configure");

    const parsed = z
      .object({
        key: roleKey,
        name: z.string().trim().min(2, "Give the role a name."),
        description: z
          .string()
          .trim()
          .max(500)
          .optional()
          .transform((v) => (v ? v : null)),
      })
      .safeParse({
        key: formData.get("key"),
        name: formData.get("name"),
        description: formData.get("description") ?? undefined,
      });

    if (!parsed.success) return invalid(parsed.error);

    // Creating an administrator role is not offered here. The Administrator
    // role is seeded, and a second one would be a privilege escalation route
    // that skipped the two-person rule.
    const role = await iam(actor).roles.create(parsed.data);

    refreshPath("/admin/roles");
    return {
      ...EMPTY_FORM_STATE,
      success: `${role.name} created. It has no permissions yet.`,
    };
  });
}

export async function updateRole(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "settings", "configure");

    const parsed = z
      .object({
        roleId: z.string().uuid(),
        expectedVersion: z.coerce.number().int().min(1),
        name: z.string().trim().min(2, "Give the role a name."),
        description: z
          .string()
          .trim()
          .max(500)
          .optional()
          .transform((v) => (v ? v : null)),
        isActive: z.coerce.boolean(),
        reason: z.string().trim().min(3, "Say why this is changing."),
      })
      .safeParse({
        roleId: formData.get("roleId"),
        expectedVersion: formData.get("expectedVersion"),
        name: formData.get("name"),
        description: formData.get("description") ?? undefined,
        isActive: formData.get("isActive") === "on",
        reason: formData.get("reason"),
      });

    if (!parsed.success) return invalid(parsed.error);
    const { roleId, ...rest } = parsed.data;

    await iam(actor).roles.update(roleId, rest);

    refreshPath("/admin/roles");
    refreshPath(`/admin/roles/${roleId}`);
    return { ...EMPTY_FORM_STATE, success: "Saved, and a new version recorded." };
  });
}

export async function cloneRole(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "settings", "configure");

    const parsed = z
      .object({
        roleId: z.string().uuid(),
        key: roleKey,
        name: z.string().trim().min(2, "Give the new role a name."),
      })
      .safeParse({
        roleId: formData.get("roleId"),
        key: formData.get("key"),
        name: formData.get("name"),
      });

    if (!parsed.success) return invalid(parsed.error);

    const role = await iam(actor).roles.clone(
      parsed.data.roleId,
      parsed.data.key,
      parsed.data.name,
    );

    refreshPath("/admin/roles");
    return {
      ...EMPTY_FORM_STATE,
      success: `${role.name} created with the same permissions and features.`,
    };
  });
}

export async function deleteRole(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "settings", "configure");

    const parsed = z
      .object({
        roleId: z.string().uuid(),
        reason: z.string().trim().min(3, "Say why the role is being removed."),
      })
      .safeParse({
        roleId: formData.get("roleId"),
        reason: formData.get("reason") ?? "role no longer required",
      });

    if (!parsed.success) return invalid(parsed.error);

    const api = iam(actor);
    const role = await api.roles.findById(parsed.data.roleId);
    if (!role) return { ...EMPTY_FORM_STATE, error: "That role no longer exists." };

    // The baseline role is held by everyone and cannot be removed, and a role
    // still in use would silently strip permissions from its holders.
    assertRoleIsRemovable(role);
    assertRoleNotInUse(role, await api.roles.memberCount(role.id));

    await api.roles.remove(role.id, parsed.data.reason);

    refreshPath("/admin/roles");
    return { ...EMPTY_FORM_STATE, success: `${role.name} deleted.` };
  });
}

/* ------------------------------------------------------ permission builder */

export async function setRolePermissions(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "settings", "configure");

    const parsed = z
      .object({
        roleId: z.string().uuid(),
        permissionIds: z.array(z.string().uuid()),
        reason: z.string().trim().min(3, "Say why the permissions are changing."),
      })
      .safeParse({
        roleId: formData.get("roleId"),
        permissionIds: formData.getAll("permissionIds").map(String).filter(Boolean),
        reason: formData.get("reason") ?? "permissions updated by administrator",
      });

    if (!parsed.success) return invalid(parsed.error);

    await iam(actor).roles.setPermissions(
      parsed.data.roleId,
      parsed.data.permissionIds,
      parsed.data.reason,
    );

    refreshPath(`/admin/roles/${parsed.data.roleId}`);
    return {
      ...EMPTY_FORM_STATE,
      success: `${parsed.data.permissionIds.length} permission(s) now granted. Holders see the change without signing in again.`,
    };
  });
}

/** Adds a new permission atom to the catalogue (PRD 3.3 permission builder). */
export async function createPermission(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "settings", "configure");

    const parsed = z
      .object({
        resource: z
          .string()
          .trim()
          .min(2, "Name the resource.")
          .regex(/^[a-z][a-z0-9_]*$|^\*$/, "Lower case letters, digits and underscores."),
        action: z.enum(PERMISSION_ACTIONS),
        scope: z.enum(PERMISSION_SCOPES),
        classificationCeiling: z.enum(CLASSIFICATION_LEVELS),
        description: z
          .string()
          .trim()
          .max(300)
          .optional()
          .transform((v) => (v ? v : null)),
      })
      .safeParse({
        resource: formData.get("resource"),
        action: formData.get("action"),
        scope: formData.get("scope"),
        classificationCeiling: formData.get("classificationCeiling"),
        description: formData.get("description") ?? undefined,
      });

    if (!parsed.success) return invalid(parsed.error);

    const permission = await iam(actor).permissions.ensure(parsed.data);

    refreshPath("/admin/roles");
    return {
      ...EMPTY_FORM_STATE,
      success: `Permission ${permission.resource}:${permission.action} is available to grant.`,
    };
  });
}

export async function deletePermission(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "settings", "configure");

    const id = z.string().uuid().safeParse(formData.get("permissionId"));
    if (!id.success) return invalid(id.error);

    await iam(actor).permissions.remove(id.data);

    refreshPath("/admin/roles");
    return { ...EMPTY_FORM_STATE, success: "Permission removed from the catalogue." };
  });
}

/* ------------------------------------------------------------- role features */

export async function setRoleFeatures(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "settings", "configure");

    const parsed = z
      .object({
        roleId: z.string().uuid(),
        featureKeys: z.array(z.string().trim().min(1)),
      })
      .safeParse({
        roleId: formData.get("roleId"),
        featureKeys: formData.getAll("featureKeys").map(String).filter(Boolean),
      });

    if (!parsed.success) return invalid(parsed.error);

    await iam(actor).roles.setFeatures(parsed.data.roleId, parsed.data.featureKeys);

    refreshPath(`/admin/roles/${parsed.data.roleId}`);
    return { ...EMPTY_FORM_STATE, success: "Feature access updated." };
  });
}

/* ----------------------------------------------------------- role versions */

export async function rollbackRole(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "settings", "configure");

    const parsed = z
      .object({
        roleId: z.string().uuid(),
        versionId: z.string().uuid(),
        reason: z.string().trim().min(3, "Say why you are rolling back."),
      })
      .safeParse({
        roleId: formData.get("roleId"),
        versionId: formData.get("versionId"),
        reason: formData.get("reason") ?? "rolled back by administrator",
      });

    if (!parsed.success) return invalid(parsed.error);

    await iam(actor).roles.rollback(
      parsed.data.roleId,
      parsed.data.versionId,
      parsed.data.reason,
    );

    refreshPath(`/admin/roles/${parsed.data.roleId}`);
    return { ...EMPTY_FORM_STATE, success: "Rolled back, and recorded as a new version." };
  });
}

/* --------------------------------------------------- separation of duties */

export async function addIncompatibility(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "settings", "configure");

    const parsed = z
      .object({
        roleAId: z.string().uuid(),
        roleBId: z.string().uuid(),
        reason: z.string().trim().min(3, "Say why these roles must not be combined."),
      })
      .safeParse({
        roleAId: formData.get("roleAId"),
        roleBId: formData.get("roleBId"),
        reason: formData.get("reason"),
      });

    if (!parsed.success) return invalid(parsed.error);

    await iam(actor).roles.addIncompatibility(
      parsed.data.roleAId,
      parsed.data.roleBId,
      parsed.data.reason,
    );

    refreshPath("/admin/roles");
    return {
      ...EMPTY_FORM_STATE,
      success: "Recorded. Nobody can now hold both of those roles at once.",
    };
  });
}

export async function removeIncompatibility(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "settings", "configure");

    const parsed = z
      .object({ roleAId: z.string().uuid(), roleBId: z.string().uuid() })
      .safeParse({
        roleAId: formData.get("roleAId"),
        roleBId: formData.get("roleBId"),
      });

    if (!parsed.success) return invalid(parsed.error);

    await iam(actor).roles.removeIncompatibility(parsed.data.roleAId, parsed.data.roleBId);

    refreshPath("/admin/roles");
    return { ...EMPTY_FORM_STATE, success: "Rule removed." };
  });
}
