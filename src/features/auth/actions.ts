"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { refreshPath } from "@/lib/revalidate";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { sql } from "@/lib/db/client";
import {
  mfaChallengeSchema,
  signInSchema,
  type AuthFormState,
} from "./schema";

/**
 * Sign-in, MFA and sign-out.
 *
 * Two things here are ours rather than Supabase's, and both are required by
 * the PRD:
 *
 *   Account lockout (PRD 14). Supabase rate-limits per IP, not per account, so
 *   every attempt is recorded and five failures lock the account.
 *
 *   A correct password on a locked account does NOT clear the lock. Supabase
 *   would happily issue a session, so the session is discarded immediately and
 *   the lock is left in place.
 *
 * Error messages are deliberately identical for "no such user" and "wrong
 * password" so the form cannot be used to enumerate accounts.
 */

const GENERIC_FAILURE = "That email address and password do not match.";

const UNAVAILABLE =
  "Sign-in is temporarily unavailable. Wait a moment and try again. " +
  "Your password has not been rejected.";

/**
 * Whether a failed sign-in was the credentials, as opposed to the platform.
 *
 * This matters twice over, and the second time is the serious one:
 *
 *   A rate limit or an outage reported as "that password does not match" sends
 *   somebody to reset a password that was correct.
 *
 *   Counting it as a failed attempt would spend that account's lockout budget.
 *   PRD 14 wants lockout to punish guessing; five rate-limited requests from a
 *   busy office sharing one IP would otherwise lock a valid account out for no
 *   reason, and the person would have no way to tell why.
 *
 * Supabase answers a rejected credential with 400 and a rate limit with 429,
 * so anything at 429 or above is treated as the platform's problem and is not
 * recorded against the account. A banned account also answers 400, which is
 * deliberate: it is indistinguishable from a wrong password here, and that is
 * the right behaviour, since whether an account exists and is usable is not
 * information an unauthenticated caller should get.
 */
function isCredentialFailure(status: number | undefined): boolean {
  if (status === undefined) return true;
  return status < 429;
}

async function requestMeta() {
  const h = await headers();
  return {
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? null,
    userAgent: h.get("user-agent") ?? null,
  };
}

function lockoutMessage(until: string): string {
  const minutes = Math.max(
    1,
    Math.ceil((new Date(until).getTime() - Date.now()) / 60_000),
  );
  return `Too many failed attempts. This account is locked for about ${minutes} minute${
    minutes === 1 ? "" : "s"
  }.`;
}

export async function signIn(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = signInSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    next: formData.get("next") ?? undefined,
  });

  if (!parsed.success) {
    const flat = parsed.error.flatten().fieldErrors;
    return {
      error: null,
      fieldErrors: {
        email: flat.email?.[0],
        password: flat.password?.[0],
      },
    };
  }

  const { email, password, next } = parsed.data;
  const meta = await requestMeta();

  // Refuse a locked account before spending a Supabase sign-in attempt.
  const state = await sql<
    {
      user_id: string | null;
      has_iims_user: boolean;
      status: string | null;
      locked_until: string | null;
    }[]
  >`select * from iam.login_state(${email})`;

  if (state.length > 0 && state[0].locked_until) {
    const until = new Date(state[0].locked_until);
    if (until > new Date()) {
      await sql`
        select iam.register_login_attempt_by_email(
          ${email}, false, 'locked', ${meta.ip}::inet, ${meta.userAgent}
        )
      `;
      return { error: lockoutMessage(state[0].locked_until) };
    }
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error || !data.user) {
    if (!isCredentialFailure(error?.status)) {
      // Not this person's fault, so nothing is recorded against their account.
      console.error("sign-in unavailable", {
        status: error?.status,
        code: error?.code,
      });
      return { error: UNAVAILABLE };
    }

    const locked = await sql<{ locked: string | null }[]>`
      select iam.register_login_attempt_by_email(
        ${email}, false, 'bad_password', ${meta.ip}::inet, ${meta.userAgent}
      ) as locked
    `;
    if (locked[0]?.locked) {
      return { error: lockoutMessage(locked[0].locked) };
    }
    return { error: GENERIC_FAILURE };
  }

  // Re-check the lock with the account now known. A correct password must not
  // unlock an account that is still serving a lockout.
  const after = await sql<{ locked_until: string | null }[]>`
    select locked_until from iam.users where id = ${data.user.id}::uuid
  `;
  if (after.length > 0 && after[0].locked_until) {
    const until = new Date(after[0].locked_until);
    if (until > new Date()) {
      // Local scope: discard the session this request just created, without
      // touching sessions the account may legitimately hold elsewhere.
      await supabase.auth.signOut({ scope: "local" });
      return { error: lockoutMessage(after[0].locked_until) };
    }
  }

  await sql`
    select iam.register_login_attempt_by_email(
      ${email}, true, null, ${meta.ip}::inet, ${meta.userAgent}
    )
  `;

  // Keep the IIMS record's MFA state in step with the factors Supabase holds,
  // so the admin screens can show who has not enrolled.
  await sql`select iam.sync_mfa_enrolment(${data.user.id}::uuid)`.catch(() => []);

  // MFA is mandatory (PRD 14), so a password alone never reaches the
  // platform. Someone with a factor completes the challenge; someone without
  // one enrols. Either way the next stop is /login/mfa.
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.currentLevel !== "aal2") {
    redirect(`/login/mfa${next ? `?next=${encodeURIComponent(next)}` : ""}`);
  }

  refreshPath("/");
  redirect(safeNext(next));
}

export async function verifyMfa(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = mfaChallengeSchema.safeParse({
    code: formData.get("code"),
    factorId: formData.get("factorId"),
  });

  if (!parsed.success) {
    return {
      error: null,
      fieldErrors: { code: parsed.error.flatten().fieldErrors.code?.[0] },
    };
  }

  const supabase = await createSupabaseServerClient();
  const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
    factorId: parsed.data.factorId,
  });

  if (challengeError || !challenge) {
    if (!isCredentialFailure(challengeError?.status)) {
      console.error("mfa challenge unavailable", { status: challengeError?.status });
      return { error: UNAVAILABLE };
    }
    return { error: "Could not start the verification. Try again." };
  }

  const { error } = await supabase.auth.mfa.verify({
    factorId: parsed.data.factorId,
    challengeId: challenge.id,
    code: parsed.data.code,
  });

  if (error) {
    // Supabase rate-limits the MFA challenge and verify endpoints at 15
    // requests a minute per IP, and that limit is not configurable. A whole
    // office behind one address can reach it, so a rate-limited verification
    // must not be recorded as a wrong code: it would spend the lockout budget
    // of somebody whose code was right.
    if (!isCredentialFailure(error.status)) {
      console.error("mfa verify unavailable", { status: error.status, code: error.code });
      return { error: UNAVAILABLE };
    }

    const meta = await requestMeta();
    const { data: userData } = await supabase.auth.getUser();
    if (userData.user?.email) {
      await sql`
        select iam.register_login_attempt_by_email(
          ${userData.user.email}, false, 'mfa_failed', ${meta.ip}::inet, ${meta.userAgent}
        )
      `;
    }
    return { error: "That code is not valid. Check your authenticator app and try again." };
  }

  const next = formData.get("next");
  refreshPath("/");
  redirect(safeNext(typeof next === "string" ? next : undefined));
}

export async function signOut(): Promise<never> {
  const supabase = await createSupabaseServerClient();
  // `scope: "local"` explicitly. supabase-js v2 defaults signOut to GLOBAL,
  // which revokes every session the user has on every device. That made this
  // menu item identical to "Sign out of all devices" below, and meant signing
  // out on a desk machine also signed an investigator out of the phone they
  // were using in the field.
  await supabase.auth.signOut({ scope: "local" });
  refreshPath("/");
  redirect("/login");
}

/** Signs the current user out of every device. */
export async function signOutEverywhere(): Promise<never> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    // A user may always revoke their own sessions, enforced in the function.
    await sql.begin(async (tx) => {
      await tx`select set_config('iims.user_id', ${user.id}, true)`;
      await tx`select iam.revoke_user_sessions(${user.id}::uuid, 'signed out of all devices by the user')`;
    });
  }

  await supabase.auth.signOut({ scope: "global" });
  redirect("/login");
}

/**
 * Only ever redirect within this app. An open redirect on a sign-in form is a
 * phishing primitive.
 */
function safeNext(next: string | undefined): string {
  if (!next) return "/dashboard";
  if (!next.startsWith("/") || next.startsWith("//")) return "/dashboard";
  return next;
}
