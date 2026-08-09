"use client";

/**
 * Small "synced / n pending / offline" indicator with a manual sync button —
 * PHASE-2.md §6. Deliberately not mounted on `/` (the test screen is sacred,
 * docs/DESIGN.md §7); it lives on pages like /history that are already
 * gated behind sign-in by src/proxy.ts.
 */

import { useCallback, useEffect, useState } from "react";
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

export function SyncStatusIndicator() {
  const [pending, setPending] = useState<number | null>(null);
  // Lazy initializer, not a setState call inside the effect below — `navigator`
  // is only available client-side, but this component is already "use client".
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine
  );
  const [state, setState] = useState<SyncUiState>(getSyncState());

  const refreshCount = useCallback(() => {
    void getPendingCount().then(setPending);
  }, []);

  useEffect(() => {
    refreshCount();

    function handleOnline() {
      setOnline(true);
      refreshCount();
    }
    function handleOffline() {
      setOnline(false);
    }
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

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
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
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
