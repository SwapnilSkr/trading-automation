import "dotenv/config";
import { DateTime } from "luxon";
import { env } from "../config/env.js";
import { ensureIndexes } from "../db/repositories.js";
import { getDb, collections } from "../db/mongo.js";
import type { Ohlc1m } from "../types/domain.js";
import { embedCandlePattern } from "../embeddings/patternEmbedding.js";
import { upsertPatternVector } from "../pinecone/patternStore.js";
import { IST } from "../time/ist.js";
import { runHybridBacktest } from "../backtest/hybridBacktest.js";

const LOOKBACK_MIN = 30;
const MOVE_THRESHOLD = 0.02;

/**
 * Find bars with forward move > MOVE_THRESHOLD within next30 minutes; upsert preceding window to Pinecone.
 */
async function mineGoldenPatterns(): Promise<void> {
  await ensureIndexes();
  const db = await getDb();
  const col = db.collection<Ohlc1m>(collections.ohlc1m);
  const since = DateTime.now().setZone(IST).minus({ months: 6 }).toJSDate();

  for (const ticker of env.watchedTickers) {
    const candles = await col
      .find({ ticker, ts: { $gte: since } })
      .sort({ ts: 1 })
      .toArray();

    for (let i = LOOKBACK_MIN; i < candles.length - LOOKBACK_MIN; i++) {
      const base = candles[i]!.c;
      const future = candles.slice(i + 1, i + 1 + LOOKBACK_MIN);
      const maxH = Math.max(...future.map((c) => c.h));
      const minL = Math.min(...future.map((c) => c.l));
      const up = (maxH - base) / base;
      const down = (base - minL) / base;
      if (up < MOVE_THRESHOLD && down < MOVE_THRESHOLD) continue;

      const outcome = up >= down ? "WIN" : "LOSS";
      const pnlPercent = Math.max(up, down) * 100;
      const pre = candles.slice(i - LOOKBACK_MIN, i + 1);
      const vec = await embedCandlePattern(pre);
      const id = `${ticker}-${candles[i]!.ts.toISOString()}`;
      await upsertPatternVector(id, vec, {
        outcome,
        pnl_percent: Number(pnlPercent.toFixed(3)),
        date: candles[i]!.ts.toISOString().slice(0, 10),
        ticker,
        strategy: "MINED",
      });
    }
  }
  console.log("[weekend-optimize] Pinecone golden pattern upserts complete");
}

async function main(): Promise<void> {
  const ticker = env.watchedTickers[0] ?? "RELIANCE";
  const to = DateTime.now().setZone(IST).toJSDate();
  const from = DateTime.now().setZone(IST).minus({ years: 2 }).toJSDate();

  await mineGoldenPatterns();

  const ev = await runHybridBacktest({ ticker, from, to, stepMinutes: 120 });
  console.log(`[weekend-optimize] hybrid replay events: ${ev.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
