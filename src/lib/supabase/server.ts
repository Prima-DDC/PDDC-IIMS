import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { sessionCookieOptions } from "./cookie-options";

/**
 * Cookie-aware Supabase client for server components, server actions and route
 * handlers.
 *
 * Used for IDENTITY ONLY: sign-in, MFA, session and storage. All case data
 * goes through the restricted `iims_app` Postgres role (see @/lib/db/client),
 * because supabase-js would reach Postgres as a role that bypasses RLS.
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: sessionCookieOptions(),
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Server components cannot set cookies. The proxy refreshes the
            // session instead, so this is safe to swallow here.
          }
        },
      },
    },
  );
}
