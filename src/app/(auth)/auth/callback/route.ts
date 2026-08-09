/**
 * Magic-link landing route — exchanges the emailed `code` for a session
 * cookie, then redirects on. PHASE-2.md §1.
 *
 * Route handlers don't participate in Proxy's cookie-refresh path, so this
 * uses the server client directly (src/lib/db/supabase/server.ts) — same
 * pattern as any other request-scoped RLS-respecting read/write.
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/db/supabase/server";

export async function GET(request: Request): Promise<Response> {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth`);
}
