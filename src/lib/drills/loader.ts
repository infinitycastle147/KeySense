/**
 * Turns a Prescription into an actual word list, in the browser.
 *
 * Wires together the pure pieces (targets.ts, generate.ts) with the I/O
 * they need: fetching the dictionary/corpus JSON from public/data/languages
 * and, for finger targets, the layout JSON from public/data/layouts. Kept
 * separate from generate.ts / targets.ts so those stay pure and unit
 * testable with hand-built fixtures — this module is the one place that
 * actually touches the network.
 */

import type { Prescription } from "@/lib/types";
import { parseLayout, type LayoutIndex, type LayoutJson } from "@/lib/analysis/layout";
import { generateDrill } from "./generate";
import { resolveTargetPatterns, DEFAULT_CORPUS } from "./targets";

type WordListFile = { words: string[] };

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

async function loadWords(corpus: string): Promise<string[]> {
  const file = await fetchJson<WordListFile>(`/data/languages/${corpus}.json`);
  return file.words;
}

async function loadLayout(name: string): Promise<LayoutIndex> {
  const json = await fetchJson<LayoutJson>(`/data/layouts/${name}.json`);
  return parseLayout(json);
}

/**
 * Builds the word list for one prescribed drill session. `layoutName`
 * defaults to "qwerty" — the only layout finger-target resolution needs to
 * agree with is whichever the user is actually typing on; callers running a
 * drill under a different layout should pass it explicitly.
 */
export async function buildDrillWords(
  prescription: Pick<Prescription, "targetType" | "targets" | "drillConfig">,
  layoutName = "qwerty",
): Promise<string[]> {
  const { targetType, targets, drillConfig } = prescription;

  const layout = targetType === "finger" ? await loadLayout(layoutName) : undefined;
  const patterns = resolveTargetPatterns(targetType, targets, layout);

  const primaryWords = await loadWords(drillConfig.corpus);

  // Corpus-backed ("class") drills draw their general share from ordinary
  // vocabulary rather than the specialised corpus itself — otherwise the
  // "general" 30% would just be more doubled letters / contractions /
  // misspellings, defeating the point of mixing in unrelated practice.
  const generalWordlist =
    drillConfig.corpus !== DEFAULT_CORPUS ? await loadWords(DEFAULT_CORPUS) : undefined;

  return generateDrill(patterns, drillConfig, primaryWords, { generalWordlist });
}
