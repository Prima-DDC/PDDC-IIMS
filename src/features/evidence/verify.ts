"use server";

import { createHash } from "node:crypto";
import { refreshPath } from "@/lib/revalidate";
import { EMPTY_FORM_STATE, invalidForm, type FormState } from "@/lib/forms";
import { requireActorOrThrow, requirePermission } from "@/lib/auth/session";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  SIGNATURE_BYTES,
  checkSignature,
  evidence,
  isEvidenceError,
} from "@/modules/evidence";
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

/**
 * Hashes the object and keeps its first bytes.
 *
 * One pass, two answers. The hash is what PRD 6.3 asks for; the header is
 * what answers PRD 14's other question, which is whether the file is what it
 * said it was. Reading the object twice to ask them separately would double
 * the egress on every verification for no gain, and the header is sixteen
 * bytes of the first chunk either way.
 */
async function digestAndHeader(
  stream: ReadableStream<Uint8Array>,
): Promise<{ sha256: string; head: Uint8Array }> {
  const hash = createHash("sha256");
  const reader = stream.getReader();
  const head = new Uint8Array(SIGNATURE_BYTES);
  let filled = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    hash.update(value);

    // A chunk boundary can fall inside the first sixteen bytes, so this fills
    // across chunks rather than assuming the first one is long enough.
    if (filled < SIGNATURE_BYTES) {
      const take = Math.min(SIGNATURE_BYTES - filled, value.length);
      head.set(value.subarray(0, take), filled);
      filled += take;
    }
  }

  return { sha256: hash.digest("hex"), head: head.subarray(0, filled) };
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

    const { sha256: computed, head } = await digestAndHeader(
      download.data.stream() as ReadableStream<Uint8Array>,
    );
    const matched = computed === item.declaredSha256;

    /*
     * Whether the file is what it claimed to be (PRD 14).
     *
     * This is the check that cannot be done at upload: everything the upload
     * had was what the browser reported, and a browser reports whatever the
     * extension implies. An executable renamed `statement.pdf` passes the
     * allow-list and fails here, on its first two bytes.
     *
     * A disguised file is recorded as a MISMATCH even when the hash agrees,
     * and that is the right verdict rather than a harsh one: the hash proves
     * the object is the one that was uploaded, and this proves the object is
     * not what the register says it is. An item whose register entry is
     * wrong cannot be cited in a report, which is exactly what `mismatch`
     * means here.
     */
    const signature = item.fileType
      ? checkSignature({ declaredType: item.fileType, head })
      : { ok: true, reason: null };

    const result = !matched || !signature.ok ? "mismatch" : "match";

    const verified = await api.items.recordVerification({
      id: evidenceRecordId,
      computedSha256: computed,
      result,
      notes: [
        matched
          ? null
          : "The stored file does not match the hash declared when it was uploaded.",
        signature.reason,
      ]
        .filter(Boolean)
        .join(" ") || null,
    });

    refreshPath(`/evidence/${evidenceRecordId}`);
    refreshPath(`/cases/${caseRecordId}`);
    refreshPath("/evidence");

    if (matched && !signature.ok) {
      // Worth its own message. "Does not match" would send somebody looking
      // for a corrupted upload, and the file is intact: it is a different
      // kind of file from the one the register describes.
      return {
        ...EMPTY_FORM_STATE,
        error: `${verified.evidenceId} is intact but it is not the kind of file it was recorded as. ${signature.reason} That is now permanently recorded, and the item cannot be cited in a report until it is resolved.`,
      };
    }

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
