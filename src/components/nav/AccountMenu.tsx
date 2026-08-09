"use client";

/**
 * Who you are signed in as, and the way back out.
 *
 * `/login` got you a session and nothing in the app could end it — the only
 * exit was clearing cookies by hand. That matters even for a single-user tool:
 * a second browser or a borrowed machine had no way to hand the session back.
 *
 * Auth state is read client-side on purpose. The server client reads cookies,
 * and calling it from the root layout would make every route dynamic —
 * including `/`, the one route that must stay cheap (docs/DESIGN.md §7). The
 * cost of that choice is one frame where we don't yet know the answer, so the
 * slot reserves its width and nothing in the bar moves when the answer lands.
 *
 * This is display only. `src/proxy.ts` is what actually gates routes; a stale
 * label here can't grant access to anything.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LogOutIcon, UserIcon } from "lucide-react";
import { createClient } from "@/lib/db/supabase/client";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// `undefined` is "not resolved yet" and `null` is "resolved, signed out" —
// they render differently, so they cannot collapse into one falsy state.
type Account = string | null | undefined;

export function AccountMenu() {
  const router = useRouter();
  const [email, setEmail] = useState<Account>(undefined);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    const supabase = createClient();

    // onAuthStateChange emits INITIAL_SESSION on subscribe, so this covers the
    // first paint as well as later sign-in/sign-out — no separate fetch, and
    // no request on the typing path.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setEmail(session?.user.email ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  async function handleSignOut() {
    setSigningOut(true);
    const supabase = createClient();
    await supabase.auth.signOut();

    // Every route but `/` is gated, so land on the one page that stays
    // usable signed out rather than bouncing off Proxy into /login. The
    // refresh drops server-rendered data belonging to the old session.
    router.replace("/");
    router.refresh();
  }

  // One fixed, right-aligned box for all three states, so the bar's geometry
  // does not depend on auth resolving — or on how long the address is.
  return (
    <div className="flex h-7 w-24 items-center justify-end">
      {email === undefined ? null : email === null ? (
        <Link
          href="/login"
          className="label-type text-muted-foreground transition-colors hover:text-foreground"
        >
          sign in
        </Link>
      ) : (
        <AccountDropdown
          email={email}
          signingOut={signingOut}
          onSignOut={handleSignOut}
        />
      )}
    </div>
  );
}

function AccountDropdown({
  email,
  signingOut,
  onSignOut,
}: {
  email: string;
  signingOut: boolean;
  onSignOut: () => void;
}) {
  return (
    <DropdownMenu>
      {/* Icon only. The address is the one thing this control exists to show,
          and it is too long to sit in the bar without being truncated into
          nonsense — so it lives one click away, in full. */}
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`account — ${email}`}
            className="text-muted-foreground hover:text-foreground"
          />
        }
      >
        <UserIcon />
      </DropdownMenuTrigger>

      {/* The base style sizes the popup to the trigger; the trigger is one
          icon wide, the address is not. */}
      <DropdownMenuContent align="end" className="w-auto min-w-56">
        {/* The group is not decoration: DropdownMenuLabel is Base UI's
            Menu.GroupLabel and throws at runtime without a Menu.Group
            ancestor. The address labels the action it sits above. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel className="truncate font-normal">
            {email}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            disabled={signingOut}
            onClick={onSignOut}
          >
            <LogOutIcon />
            {signingOut ? "signing out…" : "sign out"}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
