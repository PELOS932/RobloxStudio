import { describe, expect, it } from "vitest";
import { parsePlanUsage } from "../src/server/claude.ts";

describe("parsePlanUsage", () => {
  const event = {
    status: "allowed_warning", resetsAt: 1791220200, rateLimitType: "seven_day", overageStatus: "rejected", overageDisabledReason: "out_of_credits", isUsingOverage: false,
    unifiedWindows: { five_hour: { utilization: 0.05, resetsAt: 1791220200 }, seven_day: { utilization: 0.81, resetsAt: 1791673200 } },
  };

  it("normalizes Claude Code's rate_limit_info", () => {
    const u = parsePlanUsage(event)!;
    expect(u).toMatchObject({ status: "allowed_warning", limitType: "seven_day", resetsAt: 1791220200_000, overage: { status: "rejected", disabledReason: "out_of_credits", inUse: false } });
    expect(u.windows).toEqual({ five_hour: { utilization: 0.05, resetsAt: 1791220200_000 }, seven_day: { utilization: 0.81, resetsAt: 1791673200_000 } });
  });

  it("keeps windows a later event leaves out", () => {
    const first = parsePlanUsage(event)!;
    const next = parsePlanUsage({ status: "allowed", rateLimitType: "five_hour", utilization: 0.4, resetsAt: 1791220200 }, first)!;
    expect(next.status).toBe("allowed");
    expect(next.windows.five_hour.utilization).toBe(0.4);
    expect(next.windows.seven_day.utilization).toBe(0.81);
  });

  it("ignores junk", () => {
    expect(parsePlanUsage(null)).toBeNull();
    const prev = parsePlanUsage(event);
    expect(parsePlanUsage("nope", prev)).toBe(prev);
  });
});
