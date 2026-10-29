import "server-only";
import { createClient } from "@supabase/supabase-js";

/**
 * Service-role client. Narrow purpose, deliberately unexported beyond the
 * admin use cases that need it.
 *
 * PERMITTED USES: Supabase Auth admin operations that have no other API:
 *   - inviting a user by email
 *   - setting `ban_duration` to block sign-in on suspension
 *   - listing and deleting a user's sessions
 *   - re-enrolling or resetting MFA factors
 *
 *   - reading an object out of a private Storage bucket to hash it, which is
 *     storage access rather than data access, and which the scheduled
 *     integrity re-check (PRD 6.3) has to do with no user at all
 *
 * FORBIDDEN USE: reading or writing any case data. The service role bypasses
 * row-level security, which would void both the classification model and the
 * append-only audit guarantee (PRD §13, §14). Case data always goes through
 * `withActor()` on the restricted `iims_app` role.
 *
 * Note that `ban_duration` blocks future sign-ins but does NOT revoke live
 * sessions, so suspension is additionally enforced by the per-request
 * status and session-liveness check in @/modules/iam.
 */
export function createSupabaseAdminClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set.");
  }

  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
