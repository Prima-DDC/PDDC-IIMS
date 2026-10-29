"use server";

import { refreshPath } from "@/lib/revalidate";
import { z } from "zod";
import { requireActorOrThrow, requirePermission } from "@/lib/auth/session";
import { iam, isIamError } from "@/modules/iam";
import { CLASSIFICATION_LEVELS } from "@/modules/iam/shared";
import { EMPTY_FORM_STATE, type FormState } from "./schema";
import { parseCsv, toRecord } from "./csv";

/**
 * CSV bulk import (PRD 3.3: "CSV bulk import is supported").
 *
 * Deliberately conservative, because the failure mode of a careless bulk
 * import on an evidence platform is handing a stranger access to case
 * material:
 *
 *   - The whole file is validated BEFORE anything is created, and a single bad
 *     row rejects the lot. A half-applied import is worse than none, because
 *     nobody can tell which half applied.
 *   - Only people already in the shared PDDC staff directory can be imported.
 *     Creating brand new identities in bulk is not offered; those go through
 *     the invitation flow one at a time, on purpose.
 *   - Accounts are created `invited`, not `active`, so a mistake in the file
 *     does not immediately grant anybody anything.
 *   - An unknown role name is an error, not a silently ignored column, and the
 *     Administrator role cannot be granted this way at all because it needs a
 *     second administrator's approval.
 */

const MAX_ROWS = 500;

const rowSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "is required")
    .email("is not a valid email address")
    .toLowerCase(),
  clearance: z.enum(CLASSIFICATION_LEVELS).default("INTERNAL").catch("INTERNAL"),
  employee_id: z.string().trim().max(40).optional(),
  job_title: z.string().trim().max(120).optional(),
  /** Semicolon-separated role keys, for example investigator;qa_reviewer */
  roles: z.string().trim().optional(),
});

interface ParsedRow {
  line: number;
  email: string;
  clearance: (typeof CLASSIFICATION_LEVELS)[number];
  employeeId: string | null;
  jobTitle: string | null;
  roleKeys: string[];
}

export async function importUsersCsv(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "users", "create");

    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return { ...EMPTY_FORM_STATE, error: "Choose a CSV file to import." };
    }

    const table = parseCsv(await file.text());

    if (table.length < 2) {
      return {
        ...EMPTY_FORM_STATE,
        error: "The file needs a header row and at least one data row.",
      };
    }

    const header = table[0].map((h) => h.trim().toLowerCase());
    if (!header.includes("email")) {
      return {
        ...EMPTY_FORM_STATE,
        error:
          "The header must include an email column. Recognised columns: email, clearance, employee_id, job_title, roles.",
      };
    }

    const dataRows = table.slice(1);
    if (dataRows.length > MAX_ROWS) {
      return {
        ...EMPTY_FORM_STATE,
        error: `That file has ${dataRows.length} rows. Import at most ${MAX_ROWS} at a time.`,
      };
    }

    const api = iam(actor);
    const roles = await api.roles.list(false);
    const roleByKey = new Map(roles.map((r) => [r.key, r]));

    // ---------------------------------------------------- validate the lot
    const parsed: ParsedRow[] = [];
    const problems: string[] = [];
    const seen = new Set<string>();

    dataRows.forEach((cells, index) => {
      const line = index + 2; // 1-based, and the header is line 1
      const record = toRecord(header, cells);

      const result = rowSchema.safeParse(record);
      if (!result.success) {
        const detail = result.error.issues
          .map((issue) => `${issue.path.join(".") || "row"} ${issue.message}`)
          .join("; ");
        problems.push(`line ${line}: ${detail}`);
        return;
      }

      if (seen.has(result.data.email)) {
        problems.push(`line ${line}: ${result.data.email} appears more than once`);
        return;
      }
      seen.add(result.data.email);

      const roleKeys = (result.data.roles ?? "")
        .split(";")
        .map((key) => key.trim())
        .filter(Boolean);

      for (const key of roleKeys) {
        const role = roleByKey.get(key);
        if (!role) {
          problems.push(`line ${line}: unknown role "${key}"`);
        } else if (role.isAdministrator) {
          problems.push(
            `line ${line}: the Administrator role cannot be granted by import, because it needs a second administrator's approval`,
          );
        }
      }

      parsed.push({
        line,
        email: result.data.email,
        clearance: result.data.clearance,
        employeeId: result.data.employee_id || null,
        jobTitle: result.data.job_title || null,
        roleKeys,
      });
    });

    // Everybody must already exist in the shared staff directory.
    const directory = await api.users.directory({ limit: 200 });
    const byEmail = new Map(directory.rows.map((row) => [row.email.toLowerCase(), row]));

    for (const row of parsed) {
      const candidate = byEmail.get(row.email);
      if (!candidate) {
        problems.push(
          `line ${row.line}: ${row.email} is not in the PDDC staff directory, so invite them individually instead`,
        );
      } else if (candidate.hasIimsAccess) {
        problems.push(`line ${row.line}: ${row.email} already has access`);
      }
    }

    if (problems.length > 0) {
      const shown = problems.slice(0, 15).join("\n");
      const more =
        problems.length > 15 ? `\n... and ${problems.length - 15} more` : "";
      return {
        ...EMPTY_FORM_STATE,
        error: `Nothing was imported. ${problems.length} problem(s) found:\n${shown}${more}`,
      };
    }

    // ------------------------------------------------------- apply the lot
    let created = 0;
    for (const row of parsed) {
      const candidate = byEmail.get(row.email);
      if (!candidate) continue; // unreachable: validated above

      await api.users.create({
        userId: candidate.userId,
        clearance: row.clearance,
        // Invited, not active: a mistake in the file grants nothing yet.
        status: "invited",
        employeeId: row.employeeId,
        jobTitle: row.jobTitle,
        roleIds: row.roleKeys.map((key) => roleByKey.get(key)!.id),
      });
      created += 1;
    }

    refreshPath("/admin/users");
    return {
      ...EMPTY_FORM_STATE,
      success: `Imported ${created} account(s), each created as invited. Activate them once the details are checked.`,
    };
  } catch (error) {
    if (isIamError(error)) {
      return { ...EMPTY_FORM_STATE, error: error.message };
    }
    console.error("CSV import failed", error);
    return { ...EMPTY_FORM_STATE, error: "The import failed. Nothing was changed." };
  }
}
