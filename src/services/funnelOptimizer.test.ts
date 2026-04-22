import { describe, expect, test } from "bun:test";
import { env } from "../config/env.js";
import type { TradeLogDoc } from "../types/domain.js";
import {
  buildFunnelRecommendation,
  summarizeTradesForOptimizer,
} from "./funnelOptimizer.js";

function row(reason: string, executed = false): TradeLogDoc {
  return {
    ticker: "TCS",
    entry_time: new Date(),
    strategy: "VWAP_PULLBACK_TREND",
    env: "PAPER",
    technical_snapshot: {},
    ai_confidence: 0,
    ai_reasoning: reason,
    order_executed: executed,
  };
}

describe("funnel optimizer", () => {
  test("detects cooldown-dominant blocker and recommends cooldown tuning", () => {
    const trades: TradeLogDoc[] = [
      row("COOLDOWN_JUDGE: active 120s"),
      row("COOLDOWN_JUDGE: active 90s"),
      row("COOLDOWN_JUDGE: active 60s"),
      row("RISK_VETO: same-side cap BUY: 3/3"),
      row("Denied by judge"),
      row("EXEC", true),
    ];
    const oldMin = env.funnelOptimizerMinDecisions;
    const oldDom = env.funnelOptimizerDominancePct;
    const oldAdaptive = env.adaptiveJudgeCooldownEnabled;
    const oldMax = env.adaptiveJudgeCooldownMaxMs;
    const oldMinMs = env.adaptiveJudgeCooldownMinMs;
    env.funnelOptimizerMinDecisions = 1;
    env.funnelOptimizerDominancePct = 0.3;
    env.adaptiveJudgeCooldownEnabled = true;
    env.adaptiveJudgeCooldownMaxMs = 300000;
    env.adaptiveJudgeCooldownMinMs = 60000;

    const s = summarizeTradesForOptimizer(trades);
    expect(s.dominantBlocker).toBe("cooldown_judge");
    const rec = buildFunnelRecommendation(s);
    expect(rec?.id).toBe("cooldown-judge-max-reduce");
    expect(rec?.changes[0]?.key).toBe("ADAPTIVE_JUDGE_COOLDOWN_MAX_MS");

    env.funnelOptimizerMinDecisions = oldMin;
    env.funnelOptimizerDominancePct = oldDom;
    env.adaptiveJudgeCooldownEnabled = oldAdaptive;
    env.adaptiveJudgeCooldownMaxMs = oldMax;
    env.adaptiveJudgeCooldownMinMs = oldMinMs;
  });
});
