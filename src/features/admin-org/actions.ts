"use server";

import { refreshPath } from "@/lib/revalidate";
import { z } from "zod";
import { requireActorOrThrow, requirePermission } from "@/lib/auth/session";
import { iam, isIamError } from "@/modules/iam";
import {
  EMPTY_FORM_STATE,
  toFieldErrors,
  type FormState,
} from "../admin-users/schema";

/**
 * Countries, offices, departments and feature definitions.
 *
 * Configuration rather than code (PRD 21.1), so PDDC can open an office or
 * add a department without a release. Country records carry the
 * data-residency note that PRD 14 asks for.
 */

async function run(work: () => Promise<FormState>): Promise<FormState> {
  try {
    return await work();
  } catch (error) {
    if (isIamError(error)) return { ...EMPTY_FORM_STATE, error: error.message };
    console.error("admin-org action failed", error);
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

const code = (len: number) =>
  z
    .string()
    .trim()
    .min(2)
    .max(len)
    .regex(/^[A-Za-z0-9_-]+$/, "Letters, digits, hyphen and underscore only.");

/* --------------------------------------------------------------- countries */

export async function saveCountry(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "settings", "configure");

    const parsed = z
      .object({
        code: z
          .string()
          .trim()
          .length(2, "Use the two-letter ISO country code.")
          .transform((v) => v.toUpperCase()),
        name: z.string().trim().min(2, "Name the country."),
        residencyNote: z
          .string()
          .trim()
          .max(500)
          .optional()
          .transform((v) => (v ? v : null)),
      })
      .safeParse({
        code: formData.get("code"),
        name: formData.get("name"),
        residencyNote: formData.get("residencyNote") ?? undefined,
      });

    if (!parsed.success) return invalid(parsed.error);

    await iam(actor).org.createCountry(parsed.data);

    refreshPath("/admin/organisation");
    return { ...EMPTY_FORM_STATE, success: `${parsed.data.name} saved.` };
  });
}

export async function toggleCountry(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "settings", "configure");

    const parsed = z
      .object({ code: z.string().trim().length(2), isActive: z.coerce.boolean() })
      .safeParse({
        code: formData.get("code"),
        isActive: formData.get("isActive") === "true",
      });

    if (!parsed.success) return invalid(parsed.error);

    await iam(actor).org.updateCountry(parsed.data.code, {
      isActive: parsed.data.isActive,
    });

    refreshPath("/admin/organisation");
    return {
      ...EMPTY_FORM_STATE,
      success: parsed.data.isActive ? "Country activated." : "Country deactivated.",
    };
  });
}

/* ----------------------------------------------------------------- offices */

export async function createOffice(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "settings", "configure");

    const parsed = z
      .object({
        code: code(20),
        name: z.string().trim().min(2, "Name the office."),
        countryCode: z.string().trim().length(2).transform((v) => v.toUpperCase()),
        timezone: z
          .string()
          .trim()
          .min(1)
          .default("UTC"),
      })
      .safeParse({
        code: formData.get("code"),
        name: formData.get("name"),
        countryCode: formData.get("countryCode"),
        timezone: formData.get("timezone") || "UTC",
      });

    if (!parsed.success) return invalid(parsed.error);

    await iam(actor).org.createOffice(parsed.data);

    refreshPath("/admin/organisation");
    return { ...EMPTY_FORM_STATE, success: `${parsed.data.name} created.` };
  });
}

export async function updateOffice(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "settings", "configure");

    const parsed = z
      .object({
        officeId: z.string().uuid(),
        name: z.string().trim().min(2),
        timezone: z.string().trim().min(1),
        isActive: z.coerce.boolean(),
      })
      .safeParse({
        officeId: formData.get("officeId"),
        name: formData.get("name"),
        timezone: formData.get("timezone") || "UTC",
        isActive: formData.get("isActive") === "on",
      });

    if (!parsed.success) return invalid(parsed.error);
    const { officeId, ...rest } = parsed.data;

    await iam(actor).org.updateOffice(officeId, rest);

    refreshPath("/admin/organisation");
    return { ...EMPTY_FORM_STATE, success: "Office saved." };
  });
}

export async function deleteOffice(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "settings", "configure");

    const id = z.string().uuid().safeParse(formData.get("officeId"));
    if (!id.success) return invalid(id.error);

    await iam(actor).org.removeOffice(id.data);

    refreshPath("/admin/organisation");
    return { ...EMPTY_FORM_STATE, success: "Office deleted." };
  });
}

/* ------------------------------------------------------------- departments */

export async function createDepartment(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "settings", "configure");

    const parsed = z
      .object({
        code: code(20),
        name: z.string().trim().min(2, "Name the department."),
      })
      .safeParse({ code: formData.get("code"), name: formData.get("name") });

    if (!parsed.success) return invalid(parsed.error);

    await iam(actor).org.createDepartment(parsed.data);

    refreshPath("/admin/organisation");
    return { ...EMPTY_FORM_STATE, success: `${parsed.data.name} created.` };
  });
}

export async function updateDepartment(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "settings", "configure");

    const parsed = z
      .object({
        departmentId: z.string().uuid(),
        name: z.string().trim().min(2),
        isActive: z.coerce.boolean(),
      })
      .safeParse({
        departmentId: formData.get("departmentId"),
        name: formData.get("name"),
        isActive: formData.get("isActive") === "on",
      });

    if (!parsed.success) return invalid(parsed.error);
    const { departmentId, ...rest } = parsed.data;

    await iam(actor).org.updateDepartment(departmentId, rest);

    refreshPath("/admin/organisation");
    return { ...EMPTY_FORM_STATE, success: "Department saved." };
  });
}

export async function deleteDepartment(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "settings", "configure");

    const id = z.string().uuid().safeParse(formData.get("departmentId"));
    if (!id.success) return invalid(id.error);

    await iam(actor).org.removeDepartment(id.data);

    refreshPath("/admin/organisation");
    return { ...EMPTY_FORM_STATE, success: "Department deleted." };
  });
}

/* ---------------------------------------------------------------- features */

export async function saveFeature(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "settings", "configure");

    const parsed = z
      .object({
        key: z
          .string()
          .trim()
          .min(3)
          .regex(
            /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/,
            "Use dotted lower case, for example module.safety.",
          ),
        name: z.string().trim().min(2, "Name the feature."),
        description: z
          .string()
          .trim()
          .max(300)
          .optional()
          .transform((v) => (v ? v : null)),
        isActive: z.coerce.boolean(),
      })
      .safeParse({
        key: formData.get("key"),
        name: formData.get("name"),
        description: formData.get("description") ?? undefined,
        isActive: formData.get("isActive") !== "false",
      });

    if (!parsed.success) return invalid(parsed.error);

    await iam(actor).features.upsert(parsed.data);

    refreshPath("/admin/features");
    return { ...EMPTY_FORM_STATE, success: `${parsed.data.name} saved.` };
  });
}

export async function deleteFeature(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "settings", "configure");

    const key = z.string().trim().min(1).safeParse(formData.get("featureKey"));
    if (!key.success) return invalid(key.error);

    await iam(actor).features.remove(key.data);

    refreshPath("/admin/features");
    return { ...EMPTY_FORM_STATE, success: "Feature removed." };
  });
}

/* --------------------------------------------------- two-person approvals */

export async function decideAccessRequest(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    // Only an administrator can decide, which the repository also enforces.
    await requirePermission(actor, "users", "assign");

    const parsed = z
      .object({
        id: z.string().uuid(),
        approve: z.coerce.boolean(),
        note: z
          .string()
          .trim()
          .max(500)
          .optional()
          .transform((v) => (v ? v : null)),
      })
      .safeParse({
        id: formData.get("id"),
        approve: formData.get("approve") === "true",
        note: formData.get("note") ?? undefined,
      });

    if (!parsed.success) return invalid(parsed.error);

    const request = await iam(actor).accessRequests.decide(parsed.data);

    refreshPath("/admin/overrides");
    return {
      ...EMPTY_FORM_STATE,
      success:
        request.status === "approved"
          ? "Approved. The administrator who requested it repeats the change to apply it."
          : "Rejected, and the decision recorded.",
    };
  });
}
