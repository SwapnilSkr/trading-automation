import { describe, expect, test } from "bun:test";
import { evaluateMarketRegime, isLongBreakoutStrategy } from "./marketRegime.js";

describe("market regime gate", () => {
  test("identifies long breakout strategies", () => {
    expect(isLongBreakoutStrategy("ORB_15M")).toBe(true);
    expect(isLongBreakoutStrategy("MEAN_REV_Z")).toBe(false);
  });

  test("blocks long breakouts in a weak market but allows mean reversion", () => {
    const snapshot = {
      at: new Date("2026-04-21T05:00:00.000Z"),
      niftyChangePct: -1.2,
      breadthGreenRatio: 0.25,
      watchlistCount: 20,
    };
    expect(evaluateMarketRegime("ORB_15M", "BUY", snapshot).allowed).toBe(false);
    expect(evaluateMarketRegime("MEAN_REV_Z", "BUY", snapshot).allowed).toBe(true);
  });
});
