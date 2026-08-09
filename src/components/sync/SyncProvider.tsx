"use client";

/**
 * Invisible, app-wide sync wiring — PHASE-2.md §4's remaining two triggers
 * (sign-in flush, `window.online`) plus an initial-mount catch-up. Renders
 * nothing, so mounting it in the root layout adds no chrome to the sacred
 * test screen (docs/DESIGN.md §7) — the visible status lives in
 * SyncStatusIndicator instead, which stays off `/`.
 *
 * "On test completion" is wired separately, in src/lib/db/local.ts's
 * `saveTest` — that trigger has no UI dependency and firing it here too
 * would just double the request.
 */

import { useEffect } from "react";
import { createClient } from "@/lib/db/supabase/client";
import { syncPending } from "@/lib/db/sync";

export function SyncProvider() {
  useEffect(() => {
    const supabase = createClient();

    // Catch-up: covers the fresh page load right after the magic-link
    // redirect, and simply being online with a backlog on mount.
    void syncPending();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_IN") void syncPending();
    });

    function onOnline() {
      void syncPending();
    }
    window.addEventListener("online", onOnline);

    return () => {
      subscription.unsubscribe();
      window.removeEventListener("online", onOnline);
    };
  }, []);

  return null;
}
