import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AccountMenu } from "./AccountMenu";

/**
 * The point of this control is that a session can be ended. The states that
 * matter are "signed out", "signed in", and "sign out actually clears it" —
 * anything less and the regression is silent: a nav that always looks fine
 * while the session it claims to describe is stale.
 */

const replace = vi.fn();
const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh }),
}));

const signOut = vi.fn().mockResolvedValue({ error: null });
// Captured so a test can drive the auth callback the way Supabase would.
let emit: ((event: string, session: unknown) => void) | null = null;
const unsubscribe = vi.fn();

vi.mock("@/lib/db/supabase/client", () => ({
  createClient: () => ({
    auth: {
      signOut,
      onAuthStateChange: (cb: (event: string, session: unknown) => void) => {
        emit = cb;
        return { data: { subscription: { unsubscribe } } };
      },
    },
  }),
}));

function session(email: string) {
  return { user: { email } };
}

beforeEach(() => {
  vi.clearAllMocks();
  emit = null;
});

describe("AccountMenu", () => {
  it("offers sign-in when there is no session", async () => {
    render(<AccountMenu />);
    emit?.("INITIAL_SESSION", null);

    const link = await screen.findByRole("link", { name: /sign in/i });
    expect(link).toHaveAttribute("href", "/login");
  });

  it("shows nothing until the session resolves, rather than guessing", () => {
    render(<AccountMenu />);

    // No INITIAL_SESSION yet: claiming either state here would flash the wrong
    // one on every page load.
    expect(screen.queryByRole("link", { name: /sign in/i })).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("names the signed-in account, in full, once opened", async () => {
    const user = userEvent.setup();
    render(<AccountMenu />);
    emit?.("INITIAL_SESSION", session("someone@example.com"));

    // The bar shows an icon; the address is what the control is for, so it
    // must be reachable — by assistive tech immediately, by eye on open.
    const trigger = await screen.findByRole("button", {
      name: /someone@example\.com/,
    });
    await user.click(trigger);

    expect(await screen.findByText("someone@example.com")).toBeInTheDocument();
  });

  it("ends the session and leaves the gated routes behind", async () => {
    const user = userEvent.setup();
    render(<AccountMenu />);
    emit?.("INITIAL_SESSION", session("someone@example.com"));

    await user.click(await screen.findByRole("button", { name: /account/i }));
    await user.click(await screen.findByRole("menuitem", { name: /sign out/i }));

    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    // `/` is the only route that survives signing out (src/proxy.ts), and the
    // refresh is what drops the old session's server-rendered data.
    expect(replace).toHaveBeenCalledWith("/");
    expect(refresh).toHaveBeenCalled();
  });

  it("follows a sign-out that happened in another tab", async () => {
    render(<AccountMenu />);
    emit?.("INITIAL_SESSION", session("someone@example.com"));
    await screen.findByRole("button", { name: /someone@example\.com/ });

    emit?.("SIGNED_OUT", null);

    expect(await screen.findByRole("link", { name: /sign in/i })).toBeInTheDocument();
  });
});
