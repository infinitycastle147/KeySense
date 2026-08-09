import "server-only";

import { createClient } from "@supabase/supabase-js";

/**
 * Admin Supabase client — **bypasses RLS entirely**.
 *
 * The `server-only` import above makes importing this from a client component a
 * build error rather than a data breach.
 *
 * Only for jobs that run without a user session:
 *   - scheduled rollup / snapshot generation
 *   - backfills after an `analysis_version` bump
 *
 * Anything serving a request should use `server.ts` instead, so RLS stays in
 * force. When using this client you are responsible for filtering by `user_id`
 * yourself — nothing else will.
 */
export function createAdminClient() {
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!secret) {
    throw new Error("SUPABASE_SECRET_KEY is not set");
  }

  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
