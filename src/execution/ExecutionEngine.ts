import { env } from "../config/env.js";
import type { BrokerClient } from "../broker/types.js";
import type { Ohlc1m, StrategyId, TechnicalSnapshot, TradeLogDoc } from "../types/domain.js";
import { callJudgeModel, type JudgeInput } from "../ai/judge.js";
import { embedCandlePattern } from "../embeddings/patternEmbedding.js";
import {
  querySimilarPatterns,
  scoreFromNeighbors,
} from "../pinecone/patternStore.js";
import { fetchOhlcRange, insertTrade } from "../db/repositories.js";
import {
  evaluateBigBoy,
  evaluateMeanReversion,
  evaluateOrb,
  type TriggerHit,
} from "../strategies/triggers.js";
import { priorDayHighLow } from "../indicators/bigBoy.js";
import { checkSafety, createSafetyState, type SafetyState } from "./safety.js";
import { nowIST } from "../time/ist.js";

export class ExecutionEngine {
  private safety: SafetyState = createSafetyState();
  private openCount = 0;

  constructor(private broker: BrokerClient) {}

  recordPnl(delta: number): void {
    this.safety.dailyPnl += delta;
  }

  getOpenCount(): number {
    return this.openCount;
  }

  setOpenCount(n: number): void {
    this.openCount = n;
  }

  async runScanningPass(args: {
    ticker: string;
    sessionCandles: Ohlc1m[];
    last5m?: Ohlc1m;
    niftyTrendHint?: string;
    newsHeadlines?: string[];
  }): Promise<void> {
    if (!checkSafety(this.safety, this.openCount)) return;

    const { ticker, sessionCandles, last5m, niftyTrendHint, newsHeadlines } =
      args;
    if (sessionCandles.length < 30) return;

    const triggers: TriggerHit[] = [];
    const orb = evaluateOrb(sessionCandles);
    if (orb) triggers.push(orb);
    const mr = evaluateMeanReversion(sessionCandles);
    if (mr) triggers.push(mr);

    const today = nowIST().startOf("day");
    const y = today.minus({ days: 1 });
    const priorDay = await fetchOhlcRange(
      ticker,
      y.toJSDate(),
      y.endOf("day").toJSDate()
    );
    const pd = priorDayHighLow(priorDay);
    if (pd && last5m) {
      const bb = evaluateBigBoy(last5m, pd);
      if (bb) triggers.push(bb);
    }

    for (const hit of triggers) {
      await this.maybeExecute(ticker, hit, {
        niftyTrendHint,
        newsHeadlines,
        sessionCandles,
      });
    }
  }

  private async maybeExecute(
    ticker: string,
    hit: TriggerHit,
    ctx: {
      niftyTrendHint?: string;
      newsHeadlines?: string[];
      sessionCandles: Ohlc1m[];
    }
  ): Promise<void> {
    if (!checkSafety(this.safety, this.openCount)) return;

    const vector = await embedCandlePattern(ctx.sessionCandles);
    const neighbors = await querySimilarPatterns(vector, 8);
    const mem = scoreFromNeighbors(neighbors, 0.72);

    let judgeInput: JudgeInput = {
      strategy: hit.strategy,
      ticker,
      triggerHint: hit.hint,
      niftyContext: ctx.niftyTrendHint,
      newsHeadlines: ctx.newsHeadlines,
    };

    if (hit.strategy === "ORB_15M") {
      judgeInput = {
        ...judgeInput,
        similarPatternsSummary: mem.useMemory
          ? `Memory: ~${(mem.pWin * 100).toFixed(0)}% win in similar setups`
          : undefined,
      };
    } else if (hit.strategy === "BIG_BOY_SWEEP") {
      judgeInput = {
        ...judgeInput,
        similarPatternsSummary: neighbors.length
          ? neighbors
              .slice(0, 3)
              .map(
                (n) =>
                  `${n.meta.outcome} ${n.meta.pnl_percent}% @ ${n.meta.date}`
              )
              .join("; ")
          : "No close historical fakeouts indexed",
      };
    } else {
      judgeInput = {
        ...judgeInput,
        similarPatternsSummary: mem.useMemory
          ? `Z-score regime memory pWin~${mem.pWin.toFixed(2)}`
          : undefined,
      };
    }

    const judge = await callJudgeModel(judgeInput);
    const snap = normalizeSnapshot(hit.snapshot);

    const doc: TradeLogDoc = {
      ticker,
      entry_time: new Date(),
      strategy: hit.strategy as StrategyId,
      env: env.executionEnv,
      technical_snapshot: snap,
      ai_confidence: judge.confidence,
      ai_reasoning: judge.reasoning,
    };

    if (judge.approve && checkSafety(this.safety, this.openCount)) {
      const side =
        hit.strategy === "MEAN_REV_Z"
          ? (snap.z_score_vwap ?? 0) > 0
            ? "SELL"
            : "BUY"
          : "BUY";
      await this.broker.placePaperOrder({
        ticker,
        side,
        qty: 1,
        strategy: hit.strategy,
      });
      this.openCount += 1;
    }

    await insertTrade(doc);
  }
}

function normalizeSnapshot(
  raw: Record<string, number | undefined>
): TechnicalSnapshot {
  const t: TechnicalSnapshot = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined) t[k] = v;
  }
  return t;
}
