"use client";

/**
 * Small "synced / n pending / offline" indicator with a manual sync button —
 * PHASE-2.md §6. Deliberately not mounted on `/` (the test screen is sacred,
 * docs/DESIGN.md §7); it lives on pages like /history that are already
 * gated behind sign-in by src/proxy.ts.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  getPendingCount,
  getSyncState,
  onSyncComplete,
  onSyncStateChange,
  syncPending,
  type SyncUiState,
} from "@/lib/db/sync";

function subscribeToConnectivity(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

/**
 * Online-ness is browser state, so prerendering needs an explicit answer for
 * it. `typeof navigator === "undefined"` is not that check any more — Node has
 * shipped a global `navigator` since v21 and it has no `onLine`, so reading it
 * during render produced `undefined`, the server prerendered "offline", the
 * client hydrated "synced", and React threw a hydration mismatch.
 *
 * useSyncExternalStore makes the prerendered value a decision rather than an
 * accident: assume online, then correct on the client the moment it hydrates.
 */
function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeToConnectivity,
    () => navigator.onLine,
    () => true
  );
}

export function SyncStatusIndicator() {
  const [pending, setPending] = useState<number | null>(null);
  const online = useOnline();
  const [state, setState] = useState<SyncUiState>(getSyncState());

  const refreshCount = useCallback(() => {
    void getPendingCount().then(setPending);
  }, []);

  // On mount, and again each time the network returns — SyncProvider fires a
  // sync on `online`, so the backlog is about to change.
  useEffect(() => {
    if (online) refreshCount();
  }, [online, refreshCount]);

  useEffect(() => {
    const unsubState = onSyncStateChange(setState);
    const unsubResult = onSyncComplete(({ pushed, failed }) => {
      refreshCount();
      if (failed > 0) {
        toast.error(
          `Sync failed — ${failed} test${failed === 1 ? "" : "s"} stored locally, will retry.`
        );
      } else if (pushed > 0) {
        toast.success(`Synced ${pushed} test${pushed === 1 ? "" : "s"}.`);
      }
    });

    return () => {
      unsubState();
      unsubResult();
    };
  }, [refreshCount]);

  async function handleSyncNow() {
    await syncPending();
    refreshCount();
  }

  const label = !online
    ? "offline"
    : state === "syncing"
      ? "syncing…"
      : pending && pending > 0
        ? `${pending} pending`
        : "synced";

  const variant = !online || (pending ?? 0) > 0 ? "outline" : "secondary";

  return (
    <div className="flex items-center gap-2">
      <Badge variant={variant} className="label-type">
        {label}
      </Badge>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={handleSyncNow}
        disabled={!online || state === "syncing"}
        aria-label="sync now"
        title="sync now"
      >
        <RefreshCwIcon className={cn(state === "syncing" && "animate-spin")} />
      </Button>
    </div>
  );
}
