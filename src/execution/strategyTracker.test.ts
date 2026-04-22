import { describe, expect, test } from "bun:test";
import { DateTime } from "luxon";
import { env } from "../config/env.js";
import type { TradeLogDoc } from "../types/domain.js";
import {
  computeStrategyMetrics,
  evaluateStrategyGateDecision,
} from "./strategyTracker.js";

function makeExit(
  daysAgo: number,
  pnl: number,
  outcome: "WIN" | "LOSS"
): TradeLogDoc {
  return {
    ticker: "TCS",
    entry_time: DateTime.now().minus({ days: daysAgo }).toJSDate(),
    strategy: "VWAP_PULLBACK_TREND",
    env: "PAPER",
    technical_snapshot: {},
    ai_confidence: 0.5,
    ai_reasoning: "test",
    result: { pnl, slippage: 0, outcome, pnl_percent: 0 },
  };
}

describe("strategyTracker", () => {
  test("decay weighting emphasizes recent trades", () => {
    const exitsNewestFirst: TradeLogDoc[] = [
      makeExit(0, -100, "LOSS"),
      makeExit(1, 100, "WIN"),
    ];
    const raw = computeStrategyMetrics(exitsNewestFirst, false, 1);
    const decayed = computeStrategyMetrics(exitsNewestFirst, true, 1);
    expect(raw.profitFactor).toBe(1);
    expect(decayed.profitFactor).toBe(raw.profitFactor);
    expect(decayed.weightedProfitFactor).toBeLessThan(raw.profitFactor);
  });

  test("re-enable requires cooldown and recent improvement", () => {
    const prev = {
      _id: "VWAP_PULLBACK_TREND",
      disabled: true,
      disabled_at: DateTime.now().minus({ days: 3 }).toJSDate(),
      updated_at: new Date(),
    };

    const prevNotCooled = {
      ...prev,
      disabled_at: DateTime.now().minus({ days: 1 }).toJSDate(),
    };

    const recentImproved: TradeLogDoc[] = [
      makeExit(0, 100, "WIN"),
      makeExit(1, 120, "WIN"),
      makeExit(2, 110, "WIN"),
      makeExit(3, -80, "LOSS"),
      makeExit(4, -90, "LOSS"),
      makeExit(5, -110, "LOSS"),
    ];
    const metrics = computeStrategyMetrics(recentImproved, false, 1);

    const oldVals = {
      auto: env.strategyAutoGateEnabled,
      reenable: env.strategyReenableEnabled,
      cool: env.strategyReenableCooldownDays,
      recent: env.strategyReenableRecentTrades,
      pf: env.strategyReenableMinPf,
      wr: env.strategyReenableMinWinRate,
      minTrades: env.strategyGateMinTrades,
      gatePf: env.strategyGateMinPf,
      gateWr: env.strategyGateMinWinRate,
      decay: env.strategyGateDecayEnabled,
    };
    env.strategyAutoGateEnabled = true;
    env.strategyReenableEnabled = true;
    env.strategyReenableCooldownDays = 2;
    env.strategyReenableRecentTrades = 4;
    env.strategyReenableMinPf = 1.05;
    env.strategyReenableMinWinRate = 0.5;
    env.strategyGateMinTrades = 4;
    env.strategyGateMinPf = 1.0;
    env.strategyGateMinWinRate = 0.5;
    env.strategyGateDecayEnabled = true;

    const blocked = evaluateStrategyGateDecision(
      "VWAP_PULLBACK_TREND",
      metrics,
      recentImproved,
      prevNotCooled
    );
    expect(blocked.allowed).toBe(false);

    const reenabled = evaluateStrategyGateDecision(
      "VWAP_PULLBACK_TREND",
      metrics,
      recentImproved,
      prev
    );
    expect(reenabled.allowed).toBe(true);
    expect(reenabled.gateStatus).toBe("REENABLED");

    env.strategyAutoGateEnabled = oldVals.auto;
    env.strategyReenableEnabled = oldVals.reenable;
    env.strategyReenableCooldownDays = oldVals.cool;
    env.strategyReenableRecentTrades = oldVals.recent;
    env.strategyReenableMinPf = oldVals.pf;
    env.strategyReenableMinWinRate = oldVals.wr;
    env.strategyGateMinTrades = oldVals.minTrades;
    env.strategyGateMinPf = oldVals.gatePf;
    env.strategyGateMinWinRate = oldVals.gateWr;
    env.strategyGateDecayEnabled = oldVals.decay;
  });
});
