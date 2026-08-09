/**
 * Word and quote loading for the typing engine.
 *
 * Word lists live in `public/data/languages/*.json` and are large (english_25k
 * is 380 KB) — see docs/phases/PHASE-1.md §1. They must be fetched lazily at
 * runtime, never imported, or every page load would ship the full dictionary.
 */

import type { TestConfig } from "@/lib/types";

type WordListFile = {
  name: string;
  noLazyMode: boolean;
  orderedByFrequency: boolean;
  words: string[];
};

type QuoteEntry = {
  text: string;
  source: string;
  length: number;
  id: number;
};

type QuoteFile = {
  language: string;
  groups: number[][];
  quotes: QuoteEntry[];
};

const wordListCache = new Map<string, Promise<WordListFile>>();
const quoteCache = new Map<string, Promise<QuoteFile>>();

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to load ${url}: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

/** Fetches once per language, cached in memory for the life of the tab. */
export function loadWordList(language: string): Promise<WordListFile> {
  let pending = wordListCache.get(language);
  if (!pending) {
    pending = fetchJson<WordListFile>(`/data/languages/${language}.json`);
    wordListCache.set(language, pending);
  }
  return pending;
}

export function loadQuotes(language: string): Promise<QuoteFile> {
  let pending = quoteCache.get(language);
  if (!pending) {
    pending = fetchJson<QuoteFile>(`/data/quotes/${language}.json`);
    quoteCache.set(language, pending);
  }
  return pending;
}

const NUMBER_CHANCE = 0.12;
const COMMA_CHANCE = 0.12;
const SENTENCE_END_CHANCE = 0.18;
const SENTENCE_ENDERS = [".", ".", ".", "!", "?"];

function randomInt(max: number): number {
  return Math.floor(Math.random() * max);
}

function randomNumber(): string {
  // Mix of small and multi-digit numbers — a lone "7" reads very differently
  // from "1842" under the fingers, and the drills later target both.
  const digits = 1 + randomInt(4);
  let n = "";
  for (let i = 0; i < digits; i++) n += String(randomInt(10));
  return n.replace(/^0+(?=\d)/, "");
}

function capitalize(word: string): string {
  if (word.length === 0) return word;
  return word[0].toUpperCase() + word.slice(1);
}

/**
 * Random sample of `count` words honouring the `punctuation` and `numbers` flags
 * from TestConfig. Punctuation is applied as a light heuristic (sentence-casing,
 * trailing commas, terminal punctuation) rather than a full grammar — real
 * monkeytype-style datasets don't carry punctuation pre-baked into the word list.
 */
export async function generateWords(
  count: number,
  opts: Pick<TestConfig, "language" | "punctuation" | "numbers">
): Promise<string[]> {
  const list = await loadWordList(opts.language);
  if (list.words.length === 0) {
    throw new Error(`Word list "${opts.language}" is empty`);
  }

  const out: string[] = [];
  let sentenceStart = true;

  for (let i = 0; i < count; i++) {
    if (opts.numbers && Math.random() < NUMBER_CHANCE) {
      out.push(randomNumber());
      sentenceStart = false;
      continue;
    }

    let word = list.words[randomInt(list.words.length)];

    if (opts.punctuation) {
      if (sentenceStart) {
        word = capitalize(word);
      }
      const isLast = i === count - 1;
      if (!isLast && Math.random() < SENTENCE_END_CHANCE) {
        word += SENTENCE_ENDERS[randomInt(SENTENCE_ENDERS.length)];
        sentenceStart = true;
      } else {
        sentenceStart = false;
        if (!isLast && Math.random() < COMMA_CHANCE) {
          word += ",";
        }
      }
    }

    out.push(word);
  }

  return out;
}

/** Loads one quote (by id, or random) split into words for the engine's word
 *  array. Punctuation stays attached to the word it follows, matching how the
 *  quote is actually typed. */
export async function getQuote(
  language: string,
  id?: number
): Promise<{ id: number; text: string; source: string; words: string[] }> {
  const file = await loadQuotes(language);
  if (file.quotes.length === 0) {
    throw new Error(`Quote set "${language}" is empty`);
  }
  const quote =
    (id !== undefined ? file.quotes.find((q) => q.id === id) : undefined) ??
    file.quotes[randomInt(file.quotes.length)];

  return {
    id: quote.id,
    text: quote.text,
    source: quote.source,
    words: quote.text.split(/\s+/).filter((w) => w.length > 0),
  };
}
