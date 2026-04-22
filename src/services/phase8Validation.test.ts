import { describe, expect, test } from "bun:test";
import type { TradeLogDoc } from "../types/domain.js";
import { summarizeTradesForOptimizer } from "./funnelOptimizer.js";

// Lightweight sanity test to ensure decision counting assumptions remain stable.
describe("phase8 validation prerequisites", () => {
  test("decision funnel summary tracks executed vs blocked buckets", () => {
    const rows: TradeLogDoc[] = [
      {
        ticker: "TCS",
        entry_time: new Date(),
        strategy: "VWAP_PULLBACK_TREND",
        env: "PAPER",
        technical_snapshot: {},
        ai_confidence: 0.7,
        ai_reasoning: "COOLDOWN_JUDGE: active 60s",
        order_executed: false,
      },
      {
        ticker: "TCS",
        entry_time: new Date(),
        strategy: "VWAP_PULLBACK_TREND",
        env: "PAPER",
        technical_snapshot: {},
        ai_confidence: 0.7,
        ai_reasoning: "RISK_VETO: same-side cap BUY: 3/3",
        order_executed: false,
      },
      {
        ticker: "TCS",
        entry_time: new Date(),
        strategy: "VWAP_PULLBACK_TREND",
        env: "PAPER",
        technical_snapshot: {},
        ai_confidence: 0.7,
        ai_reasoning: "approved",
        order_executed: true,
      },
    ];
    const s = summarizeTradesForOptimizer(rows);
    expect(s.total).toBe(3);
    expect(s.executed).toBe(1);
    expect(s.nonExecuted).toBe(2);
    expect(s.cooldownJudge).toBe(1);
    expect(s.riskVeto).toBe(1);
  });
});
