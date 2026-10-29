"use server";

import { createHash } from "node:crypto";
import { refreshPath } from "@/lib/revalidate";
import { EMPTY_FORM_STATE, invalidForm, type FormState } from "@/lib/forms";
import { requireActorOrThrow, requirePermission } from "@/lib/auth/session";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { evidence, isEvidenceError } from "@/modules/evidence";
import { isIamError } from "@/modules/iam";
import { verifyEvidenceSchema } from "./schema";

/**
 * Verifying a stored file against the hash declared when it was uploaded
 * (PRD 6.3).
 *
 * The browser's hash is unattestable on its own: whoever uploaded the file
 * also computed the number that is supposed to prove it. So the server reads
 * the object back out of Storage and computes its own, and the item is only
 * "verified" when the two agree. Both are kept, and a mismatch is written as
 * a permanent integrity check that nothing in the application can edit.
 *
 * WHY THIS USES THE SERVICE ROLE
 * Reading the object is storage access, not data access. The platform's rule
 * is that the service-role key never reaches Postgres for case data, because
 * it bypasses row-level security; it is used here to fetch a file from a
 * private bucket after the application has already decided, under the actor's
 * own permissions, that this person may verify this item. The scheduled
 * re-verification in M7 runs the same path with no user at all, which is the
 * other reason it cannot be the caller's token.
 *
 * It streams rather than buffering: a 50MB object held in memory on a
 * serverless function is the kind of thing that works in testing and fails on
 * the day somebody uploads three at once.
 */

async function sha256OfStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const hash = createHash("sha256");
  const reader = stream.getReader();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) hash.update(value);
  }

  return hash.digest("hex");
}

export async function verifyEvidence(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "evidence", "edit");

    const parsed = verifyEvidenceSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { evidenceRecordId, caseRecordId } = parsed.data;
    const api = evidence(actor);

    const item = await api.items.findById(evidenceRecordId);
    if (!item) {
      return { ...EMPTY_FORM_STATE, error: "That evidence item no longer exists." };
    }
    if (!item.storagePath || !item.storageBucket || !item.declaredSha256) {
      return {
        ...EMPTY_FORM_STATE,
        error: "That item has no stored file, so there is nothing to verify.",
      };
    }

    const storage = createSupabaseAdminClient();
    const download = await storage.storage
      .from(item.storageBucket)
      .download(item.storagePath);

    if (download.error || !download.data) {
      // Recorded rather than swallowed: an object that cannot be read is a
      // finding about the evidence, and the next scheduled check will say so
      // again.
      await api.items.recordVerification({
        id: evidenceRecordId,
        computedSha256: null,
        result: "unreadable",
        notes:
          download.error?.message ??
          "The stored object could not be read from the bucket.",
      });

      refreshPath(`/evidence/${evidenceRecordId}`);
      refreshPath(`/cases/${caseRecordId}`);
      return {
        ...EMPTY_FORM_STATE,
        error:
          "The stored file could not be read. That has been recorded against the item, and it stays unverified.",
      };
    }

    const computed = await sha256OfStream(
      download.data.stream() as ReadableStream<Uint8Array>,
    );
    const matched = computed === item.declaredSha256;

    const verified = await api.items.recordVerification({
      id: evidenceRecordId,
      computedSha256: computed,
      result: matched ? "match" : "mismatch",
      notes: matched
        ? null
        : "The stored file does not match the hash declared when it was uploaded.",
    });

    refreshPath(`/evidence/${evidenceRecordId}`);
    refreshPath(`/cases/${caseRecordId}`);
    refreshPath("/evidence");

    return matched
      ? {
          ...EMPTY_FORM_STATE,
          success: `Verified. The stored file matches the hash recorded when ${verified.evidenceId} was collected.`,
        }
      : {
          ...EMPTY_FORM_STATE,
          error: `${verified.evidenceId} does NOT match. The stored file differs from what was collected, which is now permanently recorded. It cannot be cited in a report until this is resolved.`,
        };
  } catch (error) {
    if (isEvidenceError(error) || isIamError(error)) {
      return { ...EMPTY_FORM_STATE, error: error.message };
    }
    console.error("evidence verification failed", error);
    return {
      ...EMPTY_FORM_STATE,
      error: "Something went wrong verifying that. Nothing was changed.",
    };
  }
}
