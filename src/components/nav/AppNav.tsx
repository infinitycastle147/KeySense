"use client";

/**
 * The application shell's navigation.
 *
 * Five routes existed with no way to reach four of them — each was built inside
 * its own boundary and nothing owned the shell.
 *
 * The test screen is sacred (docs/DESIGN.md §7), so this hides while a test is
 * running. It hides by *fading*, not unmounting: the bar stays in flow and
 * keeps its height, so the text below does not jump the moment you start
 * typing. Visibility is driven by a `data-typing` attribute on <body> (set in
 * TypingTest) and applied in CSS, so the running test never re-renders this
 * component — nothing on the typing path pays for the nav existing.
 *
 * No amber here. `--trace` is reserved for the waveform and primary actions
 * (docs/DESIGN.md §2); the active route reads through weight and colour instead.
 *
 * The trailing slot is the account control (AccountMenu) — the shell is the
 * only surface that appears on every route, so it is where "who am I signed in
 * as, and how do I get out" belongs.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AccountMenu } from "@/components/nav/AccountMenu";

const ROUTES = [
  { href: "/", label: "test" },
  { href: "/dashboard", label: "dashboard" },
  { href: "/progress", label: "progress" },
  { href: "/reports", label: "reports" },
  { href: "/history", label: "history" },
] as const;

export function AppNav() {
  const pathname = usePathname();

  return (
    <nav
      data-app-nav
      aria-label="Main"
      className="flex items-center justify-between gap-6 border-b border-border px-6 py-4 transition-opacity duration-300"
    >
      <Link
        href="/"
        className="font-display text-sm tracking-tight text-foreground"
      >
        KeySense
      </Link>

      <ul className="flex items-center gap-6">
        {ROUTES.map((route) => {
          const active =
            route.href === "/"
              ? pathname === "/"
              : pathname.startsWith(route.href);
          return (
            <li key={route.href}>
              <Link
                href={route.href}
                aria-current={active ? "page" : undefined}
                className={`label-type transition-colors hover:text-foreground ${
                  active ? "text-foreground" : "text-muted-foreground"
                }`}
              >
                {route.label}
              </Link>
            </li>
          );
        })}
      </ul>

      <AccountMenu />
    </nav>
  );
}
