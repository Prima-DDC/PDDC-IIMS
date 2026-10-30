import "server-only";
import { createHash } from "node:crypto";
import { asActor, type Actor } from "@/lib/auth/session";
import {
  EMPTY_FORM_STATE,
  IDEMPOTENCY_FIELD,
  type FormState,
} from "@/lib/forms";

/**
 * Idempotency for server actions (PRD 14, 21.7).
 *
 * PRD 21.7 asks that replaying a mutating request with the same key yield one
 * record, the same response and no duplicate email. The mechanism is in
 * migration 0061; this is the half that knows what a form submission is.
 *
 * WHAT THIS PROTECTS AGAINST, concretely. `ActionForm` already disables its
 * button while a submission is in flight, which stops the ordinary double
 * click. It does not stop the three that matter: a browser that resends a
 * form on a flaky connection, somebody using the back button and submitting
 * again, and the retry that `withActor` performs when the Supavisor pooler
 * drops a connection mid-transaction. The third is the interesting one,
 * because it is ours: the retry is correct for a transaction that did not
 * commit, and a key is what makes it correct for one that did.
 *
 * WHAT A KEY IS. `ActionForm` renders a `__key` on every form, generated
 * once per form instance, so every submission of that form carries the same
 * key and a re-rendered form carries a new one. A submission with no key is
 * not refused: a form outside `ActionForm`, or a client with JavaScript
 * disabled, still works. That is a deliberate choice about which failure to
 * prefer, and the preference is for the platform to keep working.
 *
 * A REFUSAL RELEASES THE KEY. Somebody told to check a highlighted field,
 * who corrects it and submits again, is sending the same key with a different
 * body. If the failure had been stored, that correction would be met with
 * "conflict" for ever. So only a success is remembered.
 */

export { IDEMPOTENCY_FIELD };

type Outcome = "proceed" | "replay" | "running" | "conflict";

/**
 * Hashes what was submitted.
 *
 * Sorted, so two submissions of the same values in a different order hash the
 * same, and the key field itself is excluded: it is the identity of the
 * submission, not part of its content. File entries contribute their name and
 * size rather than their bytes, because reading a file into memory to hash it
 * would defeat the reason uploads bypass the server at all.
 */
function hashSubmission(formData: FormData): string {
  const parts: string[] = [];

  for (const [name, value] of formData.entries()) {
    if (name === IDEMPOTENCY_FIELD) continue;
    parts.push(
      typeof value === "string"
        ? `${name}=${value}`
        : `${name}=file:${value.name}:${value.size}`,
    );
  }

  parts.sort();

  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\u0000");
  }
  return hash.digest("hex");
}

/**
 * Runs an action once per key.
 *
 * `endpoint` names the action, so the same key against a different action is a
 * different operation. Without it, a form that posted to two actions in
 * sequence under one key would get the first one's answer for the second.
 */
export async function idempotent(
  actor: Actor,
  endpoint: string,
  formData: FormData,
  work: () => Promise<FormState>,
): Promise<FormState> {
  const key = formData.get(IDEMPOTENCY_FIELD);

  // No key: run it. See the note above about which failure to prefer.
  if (typeof key !== "string" || key.length < 8) return work();

  const requestHash = hashSubmission(formData);

  const [claim] = await asActor(actor, (sql) =>
    sql<{ outcome: Outcome; response: FormState | null }[]>`
      select outcome, response
      from config.claim_idempotency_key(${key}, ${endpoint}, ${requestHash})
    `,
  );

  if (claim.outcome === "replay" && claim.response) {
    // The same answer the first attempt gave, which is the whole point: the
    // record was written once and the person sees the same confirmation.
    return claim.response;
  }

  if (claim.outcome === "running") {
    return {
      ...EMPTY_FORM_STATE,
      error:
        "That is already being saved. Give it a moment rather than submitting again: submitting twice is what this message exists to prevent.",
    };
  }

  if (claim.outcome === "conflict") {
    // PRD 21.7's 422 case: the same key with a different body. It should be
    // unreachable from the product, because a corrected submission releases
    // the key below, so this message says what it actually means.
    return {
      ...EMPTY_FORM_STATE,
      error:
        "This form was submitted once already with different values. Reload the page and enter it again, so there is no doubt which version was saved.",
    };
  }

  const state = await work().catch(async (error) => {
    await release(actor, endpoint, key);
    throw error;
  });

  if (state.error) {
    // A refusal is not an answer worth remembering, and remembering it would
    // make the correction unsubmittable.
    await release(actor, endpoint, key);
    return state;
  }

  await asActor(actor, (sql) =>
    sql`
      select config.complete_idempotency_key(
        ${key}, ${endpoint}, ${sql.json(state as unknown as Record<string, string>)}::jsonb
      )
    `,
  );

  return state;
}

async function release(
  actor: Actor,
  endpoint: string,
  key: string,
): Promise<void> {
  try {
    await asActor(actor, (sql) =>
      sql`select config.release_idempotency_key(${key}, ${endpoint})`,
    );
  } catch (error) {
    // A failed release leaves a claim that expires in a day. Worth a line and
    // not worth failing the action over: the action itself has already
    // decided, and this is bookkeeping.
    console.warn(`[idempotency] could not release ${endpoint}`, error);
  }
}
