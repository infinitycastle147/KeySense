import { describe, expect, it } from "vitest";
import { isPoolWeak, WEAK_POOL_THRESHOLD } from "./pool";

describe("isPoolWeak", () => {
  it("flags pools below the threshold", () => {
    expect(isPoolWeak(0)).toBe(true);
    expect(isPoolWeak(WEAK_POOL_THRESHOLD - 1)).toBe(true);
  });

  it("does not flag pools at or above the threshold", () => {
    expect(isPoolWeak(WEAK_POOL_THRESHOLD)).toBe(false);
    expect(isPoolWeak(50)).toBe(false);
  });
});
