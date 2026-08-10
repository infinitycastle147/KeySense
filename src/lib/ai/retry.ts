/**
 * Retry policy for model calls.
 *
 * Pure and free of the SDK and the `server-only` guard, so it can be unit
 * tested — the same split as src/lib/drills/pool.ts, and for the same reason:
 * the modules that actually call the provider cannot be tested at all.
 *
 * This exists because Gemini returns `503 UNAVAILABLE — high demand` often
 * enough to matter. Measured on 2026-08-10, roughly half of the calls to
 * gemini-3.6-flash failed that way within a few minutes, and each one reached
 * the user as a failed report with nothing written to `reports` — the route
 * only persists after a successful generation.
 */

/**
 * Statuses worth trying again.
 *
 * Deliberately narrow. 429 and 5xx describe a provider that is busy or briefly
 * broken, and the same request may well succeed moments later. Everything else
 * — 400 malformed request, 401/403 bad key, 404 retired model — is a fault in
 * what we sent, and repeating it only turns an instant, legible failure into a
 * slow one.
 */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 600;
const MAX_DELAY_MS = 8000;

export function isRetryableStatus(status: unknown): boolean {
  return typeof status === "number" && RETRYABLE_STATUSES.has(status);
}

/** True for provider errors worth a second attempt. Anything without a numeric
 *  `status` is treated as non-retryable: our own errors (a truncated response,
 *  a hallucinated figure) travel this path too, and none of them are fixed by
 *  asking again. */
export function isRetryable(err: unknown): boolean {
  return isRetryableStatus((err as { status?: unknown } | null)?.status);
}

/**
 * Exponential backoff with full jitter.
 *
 * Jittered rather than fixed because the failure being retried is contention:
 * a deterministic backoff schedules every caller's retry at the same instant,
 * which is the moment least likely to succeed.
 */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  return Math.round(random() * ceiling);
}

export type RetryOptions = {
  maxAttempts?: number;
  /** Injected so tests do not sleep, and so a caller can trace the waits. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

/**
 * Runs `fn`, retrying transient provider failures.
 *
 * The last error is rethrown unchanged rather than wrapped, so a caller that
 * inspects `status` — or a log reader looking for the provider's own message —
 * sees exactly what the provider said.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === maxAttempts - 1) throw err;
      await sleep(backoffMs(attempt, options.random));
    }
  }
  throw lastError;
}
