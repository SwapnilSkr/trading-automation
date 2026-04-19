import "dotenv/config";
import { DateTime } from "luxon";
import { env } from "../config/env.js";
import { ensureIndexes, getSessionWatchlist } from "../db/repositories.js";
import { getDb, collections } from "../db/mongo.js";
import type { Ohlc1m } from "../types/domain.js";
import { embedCandlePattern } from "../embeddings/patternEmbedding.js";
import { upsertPatternVector } from "../pinecone/patternStore.js";
import { IST } from "../time/ist.js";
import { runHybridBacktest } from "../backtest/hybridBacktest.js";
import { runCli } from "./runCli.js";

const LOOKBACK_MIN = 30;
const MOVE_THRESHOLD = 0.02;

/**
 * Resolve the full ticker universe for pattern mining.
 * Priority: active_watchlist (discovery top-N) > WATCHED_TICKERS env
 * Also includes any ticker that has enough ohlc_1m data in Mongo.
 */
async function resolveOptimizeTickers(): Promise<string[]> {
  const db = await getDb();
  const col = db.collection<Ohlc1m>(collections.ohlc1m);
  const since = DateTime.now().setZone(IST).minus({ months: 6 }).toJSDate();

  // All tickers with ≥1000 bars in the last 6 months
  const mongoTickers = await col.distinct("ticker", { ts: { $gte: since } });

  // Merge with discovery watchlist and env list
  const session = await getSessionWatchlist();
  const discoveryTickers = session?.tickers ?? [];
  const all = new Set([
    ...env.watchedTickers,
    ...discoveryTickers,
    ...mongoTickers,
  ]);

  // Filter to tickers that have enough bars (>= 500 in 6m window)
  const qualified: string[] = [];
  for (const t of all) {
    const count = await col.countDocuments({ ticker: t, ts: { $gte: since } });
    if (count >= 500) qualified.push(t);
  }

  console.log(
    `[weekend-optimize] ticker universe: ${qualified.length} symbols`,
    `(env: ${env.watchedTickers.length}, discovery: ${discoveryTickers.length}, mongo: ${mongoTickers.length})`
  );
  return qualified;
}

/**
 * Walk 6 months of 1m candles for each ticker.
 * Find bars with a >2% forward move in the next 30 minutes (WIN/LOSS).
 * Embed the preceding 30-bar window and upsert to Pinecone.
 */
async function mineGoldenPatterns(tickers: string[]): Promise<number> {
  const db = await getDb();
  const col = db.collection<Ohlc1m>(collections.ohlc1m);
  const since = DateTime.now().setZone(IST).minus({ months: 6 }).toJSDate();
  let upserted = 0;

  for (const ticker of tickers) {
    const candles = await col
      .find({ ticker, ts: { $gte: since } })
      .sort({ ts: 1 })
      .toArray();

    if (candles.length < LOOKBACK_MIN * 2 + 10) {
      console.warn(`[weekend-optimize] skip ${ticker}: only ${candles.length} bars`);
      continue;
    }

    let tickerUpserts = 0;
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
      tickerUpserts++;
      upserted++;
    }
    console.log(`[weekend-optimize] ${ticker}: ${tickerUpserts} patterns upserted`);
  }
  return upserted;
}

async function main(): Promise<void> {
  await ensureIndexes();

  const tickers = await resolveOptimizeTickers();
  if (tickers.length === 0) {
    throw new Error(
      "[weekend-optimize] No tickers with sufficient data. Run discovery-sync and sync-history first."
    );
  }

  const total = await mineGoldenPatterns(tickers);
  console.log(`[weekend-optimize] Pinecone: ${total} golden pattern vectors upserted across ${tickers.length} tickers`);

  // Run hybrid backtest sample on the first ticker with most data
  const primaryTicker = tickers[0] ?? env.watchedTickers[0] ?? "RELIANCE";
  const to = DateTime.now().setZone(IST).toJSDate();
  const from = DateTime.now().setZone(IST).minus({ months: 6 }).toJSDate();

  console.log(`[weekend-optimize] Running hybrid backtest sample on ${primaryTicker}...`);
  const ev = await runHybridBacktest({ ticker: primaryTicker, from, to, stepMinutes: 120 });
  console.log(`[weekend-optimize] hybrid replay events: ${ev.length}`);
}

runCli(main);
