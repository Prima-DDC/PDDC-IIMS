"use client";

import { createBrowserClient } from "@supabase/ssr";
import { sessionCookieOptions } from "./cookie-options";

/**
 * Browser client. Shares the same cookie session as the server, and
 * via the parent-domain cookie with primaddc.com.
 *
 * Only used for auth state, realtime subscriptions and direct-to-Storage
 * uploads. It is never used to read case data: the anon key reaches Postgres
 * through PostgREST, and the IIMS schemas are deliberately not exposed to the
 * Data API.
 */
export function createSupabaseBrowserClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookieOptions: sessionCookieOptions() },
  );
}
