import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type postgres from "postgres";
import { sql, withActor } from "@/lib/db/client";
import type { ClassificationLevel } from "@/modules/iam/domain/classification";
import { IamError } from "@/modules/iam/domain/errors";
import {
  PERMISSION_SCOPES,
  type PermissionScope,
  type UserStatus,
} from "@/modules/iam/domain/types";

/**
 * Per-request identity, and the gate every protected page and action passes
 * through.
 *
 * Four things are checked on EVERY request, not just at sign-in, because
 * Supabase cannot enforce them for us:
 *
 *   1. The user has an iam.users row. A primaddc.com website account grants
 *      nothing here (PRD 3.2).
 *   2. status = 'active'. `ban_duration` blocks future sign-ins but does not
 *      revoke live sessions, so suspension would otherwise take effect only at
 *      next login (PRD 3.3 requires "immediately").
 *   3. The Supabase session behind this JWT still exists. Access tokens are
 *      stateless, so this is the only way a revoked session stops working
 *      before the token expires.
 *   4. The account is not locked out. Lockout is ours: Supabase rate-limits
 *      per IP, not per account (PRD 14).
 *
 * `cache()` dedupes the work within a single request, so a page that calls
 * this from a layout and three components still issues one query.
 */

/**
 * Could not reach the auth service, as opposed to being told no by it.
 *
 * A rejection carries an HTTP status in the 4xx range and is final: the token
 * is bad and the caller has to sign in again. A transport failure carries no
 * status at all, and a 5xx is the service itself being unwell; neither says
 * anything about whether the caller is signed in, so neither may be read as
 * "not signed in".
 */
function isRetryableAuthFailure(error: { status?: number } | null): boolean {
  if (!error) return false;
  return error.status === undefined || error.status >= 500;
}

export interface Actor {
  userId: string;
  email: string;
  fullName: string | null;
  photoPath: string | null;
  employeeId: string | null;
  jobTitle: string | null;
  status: UserStatus;
  clearance: ClassificationLevel;
  permissionsVersion: number;
  isAdministrator: boolean;
  officeName: string | null;
  departmentName: string | null;
  countryCode: string | null;
  primaryRole: string | null;
  mfaEnrolledAt: string | null;
  sessionTimeoutMinutes: number;
  /** Authenticator assurance level of the current session. */
  aal: "aal1" | "aal2";
  requestId: string;
  /** Captured once per request so repositories need no framework access. */
  ip: string | null;
  userAgent: string | null;
}

export type SessionOutcome =
  | { ok: true; actor: Actor }
  | {
      ok: false;
      reason:
        | "not_authenticated"
        | "no_iims_access"
        | "account_suspended"
        | "account_locked"
        | "session_revoked"
        | "mfa_required";
      /** Shown on the blocking screen. Safe to display. */
      detail: string;
      email?: string;
    };

interface ResolveRow {
  user_id: string;
  email: string;
  full_name: string | null;
  photo_path: string | null;
  employee_id: string | null;
  job_title: string | null;
  status: UserStatus;
  clearance: ClassificationLevel;
  permissions_version: string;
  locked_until: string | null;
  session_timeout_minutes: number;
  mfa_enrolled_at: string | null;
  is_administrator: boolean;
  session_live: boolean;
  office_name: string | null;
  department_name: string | null;
  country_code: string | null;
  primary_role: string | null;
}

/**
 * Resolves the caller, or explains why they are not allowed in.
 *
 * Returns an outcome rather than throwing, so a layout can render a specific
 * screen for each case instead of a generic error.
 */
export const getSession = cache(async (): Promise<SessionOutcome> => {
  const supabase = await createSupabaseServerClient();
  const h = await headers();
  const ip =
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? null;
  const userAgent = h.get("user-agent") ?? null;

  // The error matters as much as the user here. `getUser` returns a null user
  // both when the caller genuinely has no session and when the auth service
  // could not be reached, and those are opposite situations: the first means
  // "sign in", the second means "try again in a moment". Treating an outage
  // as a sign-out logs everybody out of a working session, and because the
  // proxy still sees their cookie it does so in a redirect loop.
  //
  // The auth service has been measured from here at 0.3s, 3.7s and 37s on
  // three consecutive calls, so a transient failure is a normal event and
  // gets one retry before we give up on it.
  let { data: userData, error: userError } = await supabase.auth.getUser();

  if (isRetryableAuthFailure(userError)) {
    ({ data: userData, error: userError } = await supabase.auth.getUser());
  }

  if (isRetryableAuthFailure(userError)) {
    // Thrown, not returned: there is no outcome that honestly describes this,
    // and the error boundary saying the sign-in service is unreachable is far
    // better than signing a working session out.
    throw new Error(
      `The sign-in service could not be reached, so your identity could not be confirmed. Nothing was changed. Try again in a moment. (${userError?.message ?? "unknown error"})`,
    );
  }

  const user = userData?.user ?? null;

  if (!user) {
    return {
      ok: false,
      reason: "not_authenticated",
      detail: "Sign in to continue.",
    };
  }

  // MFA is mandatory (PRD 14). nextLevel rises to aal2 once a factor is
  // enrolled; until the challenge is completed the session stays at aal1.
  const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  const currentLevel = aalData?.currentLevel === "aal2" ? "aal2" : "aal1";

  const rows = await sql<ResolveRow[]>`
    select * from iam.resolve_actor(
      ${user.id}::uuid,
      ${(user as { session_id?: string }).session_id ?? null}::uuid
    )
  `;

  if (rows.length === 0) {
    return {
      ok: false,
      reason: "no_iims_access",
      detail:
        "Your PDDC account is recognised, but it has not been granted access to the investigation platform. An administrator must provision your access.",
      email: user.email ?? undefined,
    };
  }

  const row = rows[0];

  if (!row.session_live) {
    return {
      ok: false,
      reason: "session_revoked",
      detail: "This session was signed out by an administrator.",
      email: row.email,
    };
  }

  if (row.locked_until && new Date(row.locked_until) > new Date()) {
    return {
      ok: false,
      reason: "account_locked",
      detail:
        "Your account is temporarily locked after repeated failed sign-in attempts. Try again later or contact an administrator.",
      email: row.email,
    };
  }

  if (row.status !== "active") {
    return {
      ok: false,
      reason: "account_suspended",
      detail:
        row.status === "invited"
          ? "Your access has been created but not yet activated. Complete your invitation to continue."
          : `Your account is ${row.status}. Contact an administrator.`,
      email: row.email,
    };
  }

  // MFA is mandatory (PRD 14), so the requirement is simply that the session
  // is aal2. Gating on `nextLevel === "aal2"` would only catch users who had
  // already enrolled a factor, letting anyone who never enrolled in on a
  // password alone. A user with no factor is sent to /login/mfa to enrol.
  if (currentLevel !== "aal2") {
    return {
      ok: false,
      reason: "mfa_required",
      detail:
        aalData?.nextLevel === "aal2"
          ? "Complete two-factor authentication to continue."
          : "Two-factor authentication is required. Set up an authenticator to continue.",
      email: row.email,
    };
  }

  return {
    ok: true,
    actor: {
      userId: row.user_id,
      email: row.email,
      fullName: row.full_name,
      photoPath: row.photo_path,
      employeeId: row.employee_id,
      jobTitle: row.job_title,
      status: row.status,
      clearance: row.clearance,
      permissionsVersion: Number(row.permissions_version),
      isAdministrator: row.is_administrator,
      officeName: row.office_name,
      departmentName: row.department_name,
      countryCode: row.country_code,
      primaryRole: row.primary_role,
      mfaEnrolledAt: row.mfa_enrolled_at,
      sessionTimeoutMinutes: row.session_timeout_minutes,
      aal: currentLevel,
      requestId: crypto.randomUUID(),
      ip,
      userAgent,
    },
  };
});

/**
 * For pages: resolves the actor or redirects to the right place.
 *
 * Each failure has its own destination, so the user is told what is wrong
 * instead of being bounced to a login form that will not help.
 */
export async function requireActor(): Promise<Actor> {
  const outcome = await getSession();
  if (outcome.ok) return outcome.actor;

  switch (outcome.reason) {
    case "not_authenticated":
      // `stale=1` tells the proxy this cookie has been rejected by the auth
      // service, so it clears it instead of bouncing back here. Without it a
      // cookie that parses but no longer validates is an infinite redirect.
      redirect("/login?stale=1");
    case "mfa_required":
      redirect("/login/mfa");
    case "no_iims_access":
      redirect("/no-access");
    case "account_locked":
    case "account_suspended":
    case "session_revoked":
      redirect(`/no-access?reason=${outcome.reason}`);
  }
}

/**
 * For server actions and route handlers: resolves the actor or throws a typed
 * error the caller maps to a status code.
 */
export async function requireActorOrThrow(): Promise<Actor> {
  const outcome = await getSession();
  if (outcome.ok) return outcome.actor;
  throw new IamError(outcome.reason, outcome.detail);
}

/**
 * Asks the database whether this actor may perform an action, and throws if
 * not.
 *
 * This is the AUTHORITATIVE check (PRD 14: "Server-side RBAC plus
 * case-assignment and classification checks on every request; deny by
 * default"). The RLS policies are a second line of defence for anything that
 * forgets to call it, not a replacement for it.
 */
export async function requirePermission(
  actor: Actor,
  resource: string,
  action: string,
  classification?: ClassificationLevel,
): Promise<void> {
  const allowed = await can(actor, resource, action, classification);
  if (!allowed) {
    throw new IamError(
      "forbidden",
      `You do not have permission to ${action} ${resource}.`,
      { resource, action, classification },
    );
  }
}

/** Non-throwing permission check, for deciding what to render. */
export async function can(
  actor: Actor,
  resource: string,
  action: string,
  classification?: ClassificationLevel,
  tx?: postgres.TransactionSql,
): Promise<boolean> {
  const rows = await (tx ?? sql)<{ ok: boolean }[]>`
    select iam.has_permission(
      ${resource}, ${action}, ${classification ?? null}, ${actor.userId}::uuid
    ) as ok
  `;
  return rows[0]?.ok === true;
}

/**
 * How wide this actor's grant on a resource is: own, assigned, team,
 * department, office, country or all.
 *
 * Needed where the permission alone does not settle the question. Every
 * employee holds `time:edit` at `own` scope (PRD 3.1), so "may they edit a
 * time entry" is answered by the permission while "may they edit somebody
 * else's" is answered by the scope. The row-level policies key on the same
 * function, so this and the database cannot disagree.
 *
 * Returns null when the actor has no grant on that pair at all.
 */
export async function permissionScope(
  actor: Actor,
  resource: string,
  action: string,
  tx?: postgres.TransactionSql,
): Promise<PermissionScope | null> {
  const rows = await (tx ?? sql)<{ scope: PermissionScope | null }[]>`
    select iam.permission_scope(
      ${resource}, ${action}, ${actor.userId}::uuid
    ) as scope
  `;
  return rows[0]?.scope ?? null;
}

/** True when the actor's grant reaches at least `atLeast` in width. */
export async function hasScope(
  actor: Actor,
  resource: string,
  action: string,
  atLeast: PermissionScope,
  tx?: postgres.TransactionSql,
): Promise<boolean> {
  const scope = await permissionScope(actor, resource, action, tx);
  if (scope === null) return false;
  return (
    PERMISSION_SCOPES.indexOf(scope) >= PERMISSION_SCOPES.indexOf(atLeast)
  );
}

/**
 * Resolves many permission questions in one round trip.
 *
 * Navigation and toolbars need a dozen answers at once; asking separately
 * would be a dozen queries on every page render.
 *
 * Takes an optional transaction so a screen that is already reading inside
 * one can ask its permission questions there too, rather than opening a
 * second connection for them.
 */
export async function canAll(
  actor: Actor,
  checks: ReadonlyArray<{ resource: string; action: string }>,
  tx?: postgres.TransactionSql,
): Promise<Record<string, boolean>> {
  if (checks.length === 0) return {};

  const rows = await (tx ?? sql)<{ key: string; ok: boolean }[]>`
    select
      q.resource || ':' || q.action as key,
      iam.has_permission(q.resource, q.action, null, ${actor.userId}::uuid) as ok
    from unnest(
      ${checks.map((c) => c.resource)}::text[],
      ${checks.map((c) => c.action)}::text[]
    ) as q(resource, action)
  `;

  return Object.fromEntries(rows.map((r) => [r.key, r.ok]));
}

/** Opens a transaction carrying this actor's identity, for reads and writes. */
export function asActor<T>(
  actor: Actor,
  // Typed over the callback rather than over `withActor`'s parameter, so the
  // return type is inferred. It was the latter, which made every caller's
  // result `unknown` and pushed the cast out to them.
  work: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return withActor(
    {
      userId: actor.userId,
      clearance: actor.clearance,
      requestId: actor.requestId,
      aal: actor.aal,
      ip: actor.ip,
      userAgent: actor.userAgent,
    },
    work,
  ) as Promise<T>;
}

/** The actor context a repository needs, without the presentation fields. */
export function actorContext(actor: Actor) {
  return {
    userId: actor.userId,
    clearance: actor.clearance,
    requestId: actor.requestId,
    aal: actor.aal,
    ip: actor.ip,
    userAgent: actor.userAgent,
  };
}
