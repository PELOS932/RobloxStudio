import { describe, expect, it } from "vitest";
import { compactEnv, compactPlan, expectedThreshold, parseAutoCompact } from "../src/shared/context.ts";

// Claude Code: threshold = (window - 20k reserve) × percent. Measured with the real CLI:
// window 100000 + 62.5% → 50000, window 200000 (default 80%) → 144000, window 250000 → 184000.
const cli = (window: number, percent = 80) => Math.round(((window - 20_000) * percent) / 100);

describe("auto-compact", () => {
  it("matches what the Claude Code CLI reported for these knobs", () => {
    expect(cli(100_000, 62.5)).toBe(50_000);
    expect(cli(200_000)).toBe(144_000);
    expect(cli(250_000)).toBe(184_000);
  });

  it("lands on the chosen size across the range", () => {
    for (const t of [40_000, 60_000, 100_000, 150_000, 200_000, 333_000, 500_000, 784_000, 950_000]) {
      const p = compactPlan(t);
      expect(p.window).toBeGreaterThanOrEqual(100_000);
      expect(p.window).toBeLessThanOrEqual(1_000_000);
      expect(p.percent).toBeLessThanOrEqual(100);
      expect(Math.abs(cli(p.window, p.percent) - t)).toBeLessThan(10);
    }
    // Claude Code's own 80% rule where it fits: the smallest window that gives it.
    expect(compactPlan(144_000)).toMatchObject({ window: 200_000, percent: 80 });
  });

  it("builds the environment for each setting", () => {
    expect(compactEnv("auto")).toEqual({});
    expect(compactEnv("off")).toMatchObject({ DISABLE_AUTO_COMPACT: "1", CLAUDE_CODE_AUTO_COMPACT_WINDOW: null });
    expect(compactEnv(150_000)).toEqual({ DISABLE_AUTO_COMPACT: null, CLAUDE_CODE_AUTO_COMPACT_WINDOW: "208000", CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "79.787" });
  });

  it("parses and clamps settings", () => {
    expect(parseAutoCompact("off")).toBe("off");
    expect(parseAutoCompact(12)).toBe(40_000);
    expect(parseAutoCompact("2000000")).toBe(950_000);
    expect(parseAutoCompact(123_456)).toBe(123_000);
    expect(parseAutoCompact("lots")).toBeUndefined();
    expect(parseAutoCompact(-1)).toBeUndefined();
    expect(expectedThreshold("off")).toBeNull();
    expect(expectedThreshold("auto")).toBe(784_000);
  });
});
