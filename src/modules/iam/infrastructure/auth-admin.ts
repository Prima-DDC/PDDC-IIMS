import "server-only";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { IamError } from "../domain/errors";
import type { AuthAdminPort } from "../application/ports";

/**
 * Supabase Auth admin operations.
 *
 * The only place the service-role key is used, and deliberately narrow: these
 * are identity operations with no other API. Nothing here reads or writes case
 * data, because the service role bypasses row-level security.
 *
 * Note the honest limitation on setBanned: Supabase's own documentation states
 * that a ban blocks sign-in for its duration and does NOT revoke existing
 * sessions. Immediate suspension therefore also depends on the per-request
 * status check in lib/auth/session.ts.
 */
export function createAuthAdmin(): AuthAdminPort {
  const admin = () => createSupabaseAdminClient();

  return {
    async invite(email: string, redirectTo: string) {
      const { data, error } = await admin().auth.admin.inviteUserByEmail(email, {
        redirectTo,
      });
      if (error) {
        throw new IamError("validation_failed", `Could not send the invitation: ${error.message}`);
      }
      if (!data.user) {
        throw new IamError("validation_failed", "The invitation returned no user.");
      }
      return { userId: data.user.id };
    },

    async setBanned(userId: string, banned: boolean) {
      // "none" clears a ban; a long duration is how Supabase expresses an
      // indefinite one.
      const { error } = await admin().auth.admin.updateUserById(userId, {
        ban_duration: banned ? "876000h" : "none",
      });
      if (error) {
        throw new IamError("conflict", `Could not update sign-in status: ${error.message}`);
      }
    },

    // Session revocation is NOT here. supabase-js v2 exposes no admin session
    // API: auth.admin.signOut() needs the user's own JWT, and there is no
    // listUserSessions or deleteSession (the installed SDK types reject both).
    // It is done in the database instead, by iam.revoke_user_sessions, which
    // deletes the session and its refresh tokens. See migration 0011.

    async sendPasswordReset(email: string, redirectTo: string) {
      const { error } = await admin().auth.resetPasswordForEmail(email, { redirectTo });
      if (error) {
        throw new IamError("validation_failed", `Could not send the reset email: ${error.message}`);
      }
    },

    async listMfaFactors(userId: string) {
      const { data, error } = await admin().auth.admin.mfa.listFactors({ userId });
      if (error) {
        throw new IamError("conflict", `Could not list MFA factors: ${error.message}`);
      }
      return (data?.factors ?? []).map((f) => ({
        id: f.id,
        type: f.factor_type,
        status: f.status,
      }));
    },

    async deleteMfaFactor(userId: string, factorId: string) {
      const { error } = await admin().auth.admin.mfa.deleteFactor({ userId, id: factorId });
      if (error) {
        throw new IamError("conflict", `Could not remove the MFA factor: ${error.message}`);
      }
    },
  };
}
