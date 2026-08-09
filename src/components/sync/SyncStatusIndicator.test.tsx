import { describe, it, expect, vi, afterEach } from "vitest";
import { renderToString } from "react-dom/server";
import { SyncStatusIndicator } from "./SyncStatusIndicator";

vi.mock("@/lib/db/sync", () => ({
  getPendingCount: vi.fn().mockResolvedValue(0),
  getSyncState: () => "idle",
  onSyncStateChange: () => () => {},
  onSyncComplete: () => () => {},
  syncPending: vi.fn(),
}));

/**
 * The prerender must not consult the browser for browser-only state.
 *
 * Node has shipped a global `navigator` since v21 and it has no `onLine`, so
 * the old `typeof navigator === "undefined"` guard fell through to
 * `navigator.onLine` on the server, read `undefined`, and prerendered
 * "offline" against a client that hydrated "synced" — a hydration error on
 * every load of /history.
 */
describe("SyncStatusIndicator", () => {
  const original = Object.getOwnPropertyDescriptor(
    window.Navigator.prototype,
    "onLine"
  );

  afterEach(() => {
    if (original) {
      Object.defineProperty(window.Navigator.prototype, "onLine", original);
    }
  });

  it("prerenders a connectivity label without reading navigator", () => {
    // Exactly the server's shape: `navigator` exists, `onLine` does not.
    Object.defineProperty(window.Navigator.prototype, "onLine", {
      configurable: true,
      get: () => undefined,
    });

    const html = renderToString(<SyncStatusIndicator />);

    // Assumed online, matching what a connected client hydrates to. Reading
    // `undefined` here is what produced "offline" and broke hydration.
    expect(html).toContain("synced");
    expect(html).not.toContain("offline");
  });
});
