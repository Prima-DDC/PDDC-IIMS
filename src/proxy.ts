import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { sessionCookieOptions } from "@/lib/supabase/cookie-options";

/**
 * Next 16 renamed `middleware` to `proxy`.
 *
 * Its only job is to refresh the Supabase session cookie and bounce
 * unauthenticated visitors to the sign-in page. It deliberately does NOT make
 * authorization decisions: roles, clearance, suspension and session liveness
 * are all resolved server-side per request in `@/lib/auth/session`, backed by
 * row-level security. A proxy runs before rendering and can be deployed to a
 * CDN edge, so it is the wrong place to hold security logic.
 */

const PUBLIC_PATHS = /^\/(login|auth|no-access|_next|favicon|icons|manifest)/;

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: sessionCookieOptions(),
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, cacheHeaders) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
          // A response that sets auth cookies must never be cached by a CDN,
          // or one user's token can be served to another.
          Object.entries(cacheHeaders ?? {}).forEach(([key, value]) =>
            response.headers.set(key, value),
          );
        },
      },
    },
  );

  // Refreshes the session if it has expired, and tells us whether there is
  // one at all. Must happen before any auth decision and before the response
  // is committed.
  //
  // `getSession` rather than `getUser`, and the difference is worth stating
  // because Supabase's own guidance says to prefer `getUser` in server code.
  // That guidance is about trusting the token for an authorization decision,
  // and this proxy makes none: a request that gets past it is then resolved
  // by `@/lib/auth/session`, which does call `getUser` and additionally
  // checks the account's status and that the session is still live, all
  // behind row-level security. The proxy only redirects somebody with no
  // session at all to the sign-in page, which is a convenience rather than a
  // boundary; a forged cookie gets a login page one step later instead.
  //
  // What it buys is the whole point: `getUser` is a network round trip to the
  // auth service on every single request, and the page then makes the same
  // call again. The service was measured from here at 0.3s, 3.7s and 37s on
  // three consecutive calls, so halving the number of them is the single
  // largest latency saving available in this application. `getSession` reads
  // the cookie and goes to the network only when the token actually needs
  // refreshing.
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const user = session?.user ?? null;

  const { pathname } = request.nextUrl;

  if (!user && !PUBLIC_PATHS.test(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(url);
  }

  // This proxy and the page can disagree about who is signed in, and the
  // disagreement is not hypothetical: the proxy reads the cookie, the page
  // validates it against the auth service. A cookie that still parses but
  // that the auth service rejects (a revoked session, a refresh token already
  // consumed by another client) makes the page redirect to /login while the
  // block below redirects straight back to /dashboard. That is not a login
  // page, it is ERR_TOO_MANY_REDIRECTS.
  //
  // `stale=1` is the page telling us it has already rejected this cookie. The
  // cookie is cleared here, which is the one place in the request that can do
  // it (a server component cannot write cookies), so the loop cannot restart
  // on the next request either.
  if (user && pathname === "/login") {
    if (request.nextUrl.searchParams.get("stale") === "1") {
      for (const cookie of request.cookies.getAll()) {
        if (!/^sb-.*-auth-token(\.\d+)?$/.test(cookie.name)) continue;
        response.cookies.set(cookie.name, "", {
          ...sessionCookieOptions(),
          maxAge: 0,
        });
      }
      return response;
    }

    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    url.search = "";
    return NextResponse.redirect(url);
  }

  // Investigative content must never sit in a shared cache (PRD 21.3).
  if (!PUBLIC_PATHS.test(pathname)) {
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
  }

  return response;
}

export const config = {
  // Everything except static assets and files with an extension.
  matcher: ["/((?!_next/static|_next/image|.*\\.[^/]+$).*)"],
};
