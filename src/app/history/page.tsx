/**
 * Test history — PHASE-2.md §5. Server component, RLS-scoped read via
 * server.ts, newest first. Proxy already redirects signed-out visitors to
 * /login before this ever renders; the check below is a defensive backstop,
 * not the primary gate.
 */

import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/db/supabase/server";
import { Card, CardContent } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { SyncStatusIndicator } from "@/components/sync/SyncStatusIndicator";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

type TestRow = {
  id: string;
  started_at: string;
  duration_ms: number;
  mode: string;
  mode_setting: string | null;
  wpm: number;
  accuracy: number;
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
}

/** Prev/next control. A disabled state renders as inert text, not an anchor
 *  with a dead href — there's nowhere for it to navigate. */
function PageLink({
  href,
  disabled,
  children,
}: {
  href: string;
  disabled: boolean;
  children: string;
}) {
  const className = cn(buttonVariants({ variant: "outline", size: "sm" }));
  if (disabled) {
    return <span className={cn(className, "opacity-50")}>{children}</span>;
  }
  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}

export default async function HistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const params = await searchParams;
  const pageParam = Array.isArray(params.page) ? params.page[0] : params.page;
  const page = Math.max(1, Number(pageParam) || 1);
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  // Uses tests_user_started_idx (user_id, started_at desc) — see
  // supabase/migrations/0001_init.sql.
  const {
    data: tests,
    count,
    error,
  } = await supabase
    .from("tests")
    .select("id, started_at, duration_ms, mode, mode_setting, wpm, accuracy", {
      count: "exact",
    })
    .order("started_at", { ascending: false })
    .range(from, to);

  const rows = (tests ?? []) as TestRow[];
  const total = count ?? 0;
  const hasNext = to + 1 < total;
  const hasPrev = page > 1;

  return (
    <main className="flex flex-1 flex-col items-center px-4 py-10">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="font-[family-name:var(--font-display)] text-2xl">history</h1>
            <p className="label-type text-muted-foreground">
              {total} test{total === 1 ? "" : "s"}
            </p>
          </div>
          <SyncStatusIndicator />
        </div>

        {error && (
          <p role="alert" className="label-type text-flag">
            failed to load history — {error.message}
          </p>
        )}

        {!error && rows.length === 0 && (
          <Card>
            <CardContent className="py-8 text-center text-muted-foreground">
              No synced tests yet. Finish a test while signed in — or sign in
              after typing offline — and it will show up here.
            </CardContent>
          </Card>
        )}

        <ul className="flex flex-col gap-2">
          {rows.map((test) => (
            <li key={test.id}>
              <Card size="sm">
                <CardContent className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1">
                  <span className="label-type text-muted-foreground">
                    {formatDate(test.started_at)}
                  </span>
                  <span className="label-type">
                    {test.mode}
                    {test.mode_setting ? ` ${test.mode_setting}` : ""}
                  </span>
                  <span className="label-type text-muted-foreground">
                    {formatDuration(test.duration_ms)}
                  </span>
                  <span className="font-[family-name:var(--font-display)] tabular-nums text-trace">
                    {Math.round(test.wpm)} wpm
                  </span>
                  <span className="label-type tabular-nums">
                    {(test.accuracy * 100).toFixed(1)}% acc
                  </span>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>

        {(hasPrev || hasNext) && (
          <div className="flex items-center justify-between pt-2">
            <PageLink href={`/history?page=${page - 1}`} disabled={!hasPrev}>
              previous
            </PageLink>
            <span className="label-type text-muted-foreground">page {page}</span>
            <PageLink href={`/history?page=${page + 1}`} disabled={!hasNext}>
              next
            </PageLink>
          </div>
        )}
      </div>
    </main>
  );
}
