/**
 * Shared session cookie configuration: this is the mechanism that gives every
 * PDDC employee ONE login across two apps.
 *
 * The website serves primaddc.com and the IIMS serves iims.primaddc.com. Both
 * read and write the Supabase session cookie scoped to the parent domain
 * `.primaddc.com`, so a session established on either app is visible to the
 * other, with no second sign-in, no second MFA challenge and no token-handoff
 * endpoint to maintain.
 *
 * COOKIE_DOMAIN is left empty for localhost, where host-only cookies are
 * correct and a `.localhost` domain attribute would simply be ignored.
 *
 * The companion change lives in the website: prima-website-2.0 must pass the
 * same `cookieOptions.domain` so that both apps agree on the cookie's scope.
 * Until it does, each app keeps its own session and employees still share one
 * set of credentials, but they sign in twice.
 */
export function sessionCookieOptions() {
  const domain = process.env.COOKIE_DOMAIN?.trim();

  return {
    ...(domain ? { domain } : {}),
    path: "/",
    sameSite: "lax" as const,
    // Always true in production; relaxed on localhost so dev works over http.
    secure: process.env.NODE_ENV === "production",
  };
}
