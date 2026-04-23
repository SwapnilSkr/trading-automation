import { describe, expect, test } from "bun:test";
import { evaluateMarketRegime, isLongBreakoutStrategy } from "./marketRegime.js";

describe("market regime gate", () => {
  test("identifies long breakout strategies", () => {
    expect(isLongBreakoutStrategy("ORB_15M")).toBe(true);
    expect(isLongBreakoutStrategy("INDEX_LAGGARD_CATCHUP")).toBe(true);
    expect(isLongBreakoutStrategy("MEAN_REV_Z")).toBe(false);
  });

  test("hard-blocks long breakouts only when both NIFTY and breadth are weak", () => {
    const snapshot = {
      at: new Date("2026-04-21T05:00:00.000Z"),
      niftyChangePct: -1.2,
      breadthGreenRatio: 0.25,
      watchlistCount: 20,
    };
    expect(evaluateMarketRegime("ORB_15M", "BUY", snapshot).allowed).toBe(false);
    expect(evaluateMarketRegime("MEAN_REV_Z", "BUY", snapshot).allowed).toBe(true);
  });

  test("soft-throttles breakout when only one hard dimension is weak", () => {
    const snapshot = {
      at: new Date("2026-04-21T05:00:00.000Z"),
      niftyChangePct: -1.15,
      breadthGreenRatio: 0.45,
      watchlistCount: 20,
    };
    const ev = evaluateMarketRegime("VWAP_PULLBACK_TREND", "BUY", snapshot);
    expect(ev.allowed).toBe(true);
    expect(ev.size_multiplier).toBeLessThan(1);
    expect(ev.confidence_floor).toBeGreaterThan(0);
  });
});
