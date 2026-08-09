import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Server-side Supabase client, scoped to the signed-in user.
 *
 * Uses the publishable key and the request's cookies, so RLS applies exactly as
 * it does in the browser. This is the default for server components and route
 * handlers — reach for `admin.ts` only when a job genuinely runs without a user
 * session.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Called from a Server Component, which cannot set cookies.
            // Safe to ignore — src/proxy.ts refreshes the session.
          }
        },
      },
    },
  );
}
