/**
 * Usage and adherence.
 *
 * docs/ARCHITECTURE.md §10 states that engagement is a *functional* requirement
 * here, not decoration: "The tool must not be boring, or it goes unused and
 * collects no data." That makes usage a measurement the product depends on, and
 * it was the one thing never measured.
 *
 * It also closes a gap in the diagnosis loop. When a prescription reports
 * `no-change`, there are two very different explanations — the diagnosis was
 * wrong, or the drills were never really done — and without adherence data the
 * scorecard in src/lib/prescriptions/scorecard.ts cannot tell them apart, which
 * makes it liable to blame the analysis for a compliance problem.
 *
 * Pure. See usage.test.ts.
 */

import type { Prescription } from "@/lib/types";
import { assignSessions, type TestContext } from "./sessions";

const DAY_MS = 24 * 60 * 60 * 1000;

export type UsageStats = {
  testCount: number;
  sessionCount: number;
  /** Distinct calendar days with at least one test. */
  activeDays: number;
  /** Days from the first test to the last, inclusive. */
  spanDays: number;
  /** activeDays / spanDays — how much of the period was actually used. */
  consistency: number;
  /** Consecutive active days ending at the most recent active day. */
  currentStreak: number;
  longestStreak: number;
  medianTestsPerSession: number;
};

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

export function computeUsage(tests: TestContext[]): UsageStats {
  if (tests.length === 0) {
    return {
      testCount: 0,
      sessionCount: 0,
      activeDays: 0,
      spanDays: 0,
      consistency: 0,
      currentStreak: 0,
      longestStreak: 0,
      medianTestsPerSession: 0,
    };
  }

  const positioned = assignSessions(tests);
  const sessionCount = positioned[positioned.length - 1].sessionIndex + 1;

  const days = [...new Set(positioned.map((t) => dayKey(t.startedAt)))].sort();
  const first = new Date(days[0]).getTime();
  const last = new Date(days[days.length - 1]).getTime();
  const spanDays = Math.round((last - first) / DAY_MS) + 1;

  let longestStreak = 1;
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    const gap = (new Date(days[i]).getTime() - new Date(days[i - 1]).getTime()) / DAY_MS;
    if (Math.round(gap) === 1) run += 1;
    else run = 1;
    longestStreak = Math.max(longestStreak, run);
  }

  // The streak ending at the last active day — not "up to today", because this
  // module is pure and has no clock. A caller that wants "is the streak still
  // alive" must compare `days[days.length - 1]` against today itself.
  let currentStreak = 1;
  for (let i = days.length - 1; i > 0; i--) {
    const gap = (new Date(days[i]).getTime() - new Date(days[i - 1]).getTime()) / DAY_MS;
    if (Math.round(gap) === 1) currentStreak += 1;
    else break;
  }

  const perSession = new Map<number, number>();
  for (const t of positioned) {
    perSession.set(t.sessionIndex, (perSession.get(t.sessionIndex) ?? 0) + 1);
  }
  const counts = [...perSession.values()].sort((a, b) => a - b);
  const medianTestsPerSession = counts[Math.floor(counts.length / 2)] ?? 0;

  return {
    testCount: tests.length,
    sessionCount,
    activeDays: days.length,
    spanDays,
    consistency: spanDays > 0 ? days.length / spanDays : 0,
    currentStreak,
    longestStreak,
    medianTestsPerSession,
  };
}

export type AdherenceStats = {
  total: number;
  completed: number;
  abandoned: number;
  active: number;
  /** Drills done over drills prescribed, across every prescription. The number
   *  that says whether a `no-change` verdict is a failed diagnosis or an
   *  untaken prescription. */
  completionRate: number;
  /** Prescriptions that reached their target without being abandoned. */
  followThroughRate: number;
};

export function computeAdherence(prescriptions: Prescription[]): AdherenceStats {
  let done = 0;
  let target = 0;
  let completed = 0;
  let abandoned = 0;
  let active = 0;

  for (const rx of prescriptions) {
    done += rx.drillsDone;
    target += rx.drillsTarget;
    if (rx.status === "completed") completed += 1;
    else if (rx.status === "abandoned") abandoned += 1;
    else active += 1;
  }

  const finished = completed + abandoned;

  return {
    total: prescriptions.length,
    completed,
    abandoned,
    active,
    // Capped at 1: over-drilling a target is adherence, not 130% adherence.
    completionRate: target > 0 ? Math.min(1, done / target) : 0,
    followThroughRate: finished > 0 ? completed / finished : 0,
  };
}
