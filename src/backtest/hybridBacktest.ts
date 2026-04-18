import { getDb, collections } from "../db/mongo.js";
import type { Ohlc1m } from "../types/domain.js";
import { evaluateOrb, evaluateMeanReversion } from "../strategies/triggers.js";
import { embedCandlePattern } from "../embeddings/patternEmbedding.js";
import {
  querySimilarPatterns,
  scoreFromNeighbors,
} from "../pinecone/patternStore.js";
import { callJudgeModel } from "../ai/judge.js";

export interface BacktestEvent {
  at: Date;
  ticker: string;
  strategy: string;
  usedMemory: boolean;
  pWin?: number;
  judgeApprove?: boolean;
}

/**
 * Walk historical1m candles, fire technical triggers, resolve AI via Pinecone memory or cheap judge.
 * Extend replay window / tickers via env.
 */
export async function runHybridBacktest(options: {
  ticker: string;
  from: Date;
  to: Date;
  stepMinutes?: number;
}): Promise<BacktestEvent[]> {
  const db = await getDb();
  const col = db.collection<Ohlc1m>(collections.ohlc1m);
  const candles = await col
    .find({
      ticker: options.ticker,
      ts: { $gte: options.from, $lte: options.to },
    })
    .sort({ ts: 1 })
    .toArray();

  const events: BacktestEvent[] = [];
  const step = options.stepMinutes ?? 30;
  const minLen = 60;

  for (let i = minLen; i < candles.length; i += step) {
    const window = candles.slice(0, i + 1);
    const orb = evaluateOrb(window);
    const mr = evaluateMeanReversion(window);
    const hit = orb ?? mr;
    if (!hit) continue;

    const vector = await embedCandlePattern(window);
    const neighbors = await querySimilarPatterns(vector, 8);
    const mem = scoreFromNeighbors(neighbors, 0.72);

    if (mem.useMemory && mem.pWin >= 0.55) {
      events.push({
        at: window[window.length - 1]!.ts,
        ticker: options.ticker,
        strategy: hit.strategy,
        usedMemory: true,
        pWin: mem.pWin,
      });
      continue;
    }

    const judge = await callJudgeModel({
      strategy: hit.strategy,
      ticker: options.ticker,
      triggerHint: hit.hint,
      similarPatternsSummary: "Backtest cold path — full judge",
    });
    events.push({
      at: window[window.length - 1]!.ts,
      ticker: options.ticker,
      strategy: hit.strategy,
      usedMemory: false,
      judgeApprove: judge.approve,
    });
  }

  return events;
}

export async function runHybridBacktestStub(): Promise<void> {
  console.log(
    "[Backtest] Use runHybridBacktest() with Mongo OHLC range or: bun run src/cli/weekend-optimize.ts"
  );
}
