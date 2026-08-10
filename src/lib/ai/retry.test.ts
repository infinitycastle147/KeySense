import { describe, it, expect, vi } from "vitest";
import { withRetry, isRetryable, backoffMs, MAX_ATTEMPTS } from "./retry";

/** Mirrors the SDK's ApiError: a numeric `status` alongside the message. */
function apiError(status: number): Error & { status: number } {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

const noSleep = () => Promise.resolve();

describe("isRetryable", () => {
  it("retries the statuses that mean 'busy, try again'", () => {
    for (const s of [408, 429, 500, 502, 503, 504]) {
      expect(isRetryable(apiError(s))).toBe(true);
    }
  });

  it("does not retry a fault in what we sent", () => {
    // Repeating a bad key or a retired model id only makes the failure slower.
    for (const s of [400, 401, 403, 404, 422]) {
      expect(isRetryable(apiError(s))).toBe(false);
    }
  });

  it("does not retry our own errors, which carry no status", () => {
    expect(isRetryable(new Error("model returned no content"))).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
    expect(isRetryable(null)).toBe(false);
  });
});

describe("backoffMs", () => {
  it("grows with the attempt and stays within the ceiling", () => {
    const full = () => 1; // full jitter -> the ceiling itself
    expect(backoffMs(0, full)).toBe(600);
    expect(backoffMs(1, full)).toBe(1200);
    expect(backoffMs(2, full)).toBe(2400);
  });

  it("caps rather than growing without bound", () => {
    expect(backoffMs(20, () => 1)).toBe(8000);
  });

  it("jitters — the point is that two callers do not retry in lockstep", () => {
    expect(backoffMs(3, () => 0)).toBe(0);
    expect(backoffMs(3, () => 0.5)).toBe(2400);
  });
});

describe("withRetry", () => {
  it("returns the first success without sleeping", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const sleep = vi.fn(noSleep);
    await expect(withRetry(fn, { sleep })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("recovers from a transient 503 — the case this exists for", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(apiError(503))
      .mockRejectedValueOnce(apiError(503))
      .mockResolvedValue("report");
    await expect(withRetry(fn, { sleep: noSleep })).resolves.toBe("report");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("gives up after MAX_ATTEMPTS and rethrows the provider's own error", async () => {
    const fn = vi.fn().mockRejectedValue(apiError(503));
    await expect(withRetry(fn, { sleep: noSleep })).rejects.toMatchObject({ status: 503 });
    expect(fn).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  });

  it("fails immediately on a non-retryable status", async () => {
    const fn = vi.fn().mockRejectedValue(apiError(401));
    await expect(withRetry(fn, { sleep: noSleep })).rejects.toMatchObject({ status: 401 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry a hallucination — asking again is not a second opinion", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("model cited figures absent from the profile"));
    await expect(withRetry(fn, { sleep: noSleep })).rejects.toThrow("cited figures");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
