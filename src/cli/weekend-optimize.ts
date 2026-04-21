import "dotenv/config";
import { createHash } from "node:crypto";
import { DateTime } from "luxon";
import { env } from "../config/env.js";
import {
  clearWeekendOptimizeCheckpoint,
  ensureIndexes,
  getSessionWatchlist,
  getWeekendOptimizeCheckpoint,
  saveWeekendOptimizeCheckpoint,
  weekendOptimizeAppendCompletedTicker,
} from "../db/repositories.js";
import { getDb, collections } from "../db/mongo.js";
import type { Ohlc1m, PatternMeta } from "../types/domain.js";
import { embedCandlePattern } from "../embeddings/patternEmbedding.js";
import {
  fetchExistingPatternIds,
  upsertPatternVector,
} from "../pinecone/patternStore.js";
import { IST, istDateString } from "../time/ist.js";
import { runHybridBacktest } from "../backtest/hybridBacktest.js";
import { runCli } from "./runCli.js";
import { getTickerSector } from "../market/tickerMetadata.js";
import { classifyVolRegimeFromCandles } from "../market/volRegime.js";

const LOOKBACK_MIN = 30;
const MOVE_THRESHOLD = 0.02;

function hashTickers(tickers: string[]): string {
  return createHash("sha256")
    .update([...tickers].sort().join("\0"))
    .digest("hex")
    .slice(0, 24);
}

/** `--no-resume`: ignore Mongo checkpoint; `--re-embed-all`: ignore Pinecone id skip. */
function parseWeekendFlags(): { noResume: boolean; reEmbedAll: boolean } {
  const a = process.argv.slice(2);
  return {
    noResume: a.includes("--no-resume"),
    reEmbedAll: a.includes("--re-embed-all"),
  };
}

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

async function prepareCompletedTickers(
  startedIstDate: string,
  tickersSig: string,
  tickers: string[],
  persistCheckpoint: boolean
): Promise<Set<string>> {
  if (!persistCheckpoint) {
    await clearWeekendOptimizeCheckpoint();
    return new Set();
  }
  const cp = await getWeekendOptimizeCheckpoint();
  if (
    cp &&
    cp.started_ist_date === startedIstDate &&
    cp.tickers_sig === tickersSig &&
    cp.completed_tickers.length > 0 &&
    cp.completed_tickers.length < tickers.length
  ) {
    console.log(
      `[weekend-optimize] resume: ${cp.completed_tickers.length}/${tickers.length} tickers already completed (same IST calendar day, same ticker universe)`
    );
    await saveWeekendOptimizeCheckpoint({
      started_ist_date: startedIstDate,
      tickers_sig: tickersSig,
      completed_tickers: cp.completed_tickers,
    });
    return new Set(cp.completed_tickers);
  }
  if (cp) await clearWeekendOptimizeCheckpoint();
  await saveWeekendOptimizeCheckpoint({
    started_ist_date: startedIstDate,
    tickers_sig: tickersSig,
    completed_tickers: [],
  });
  return new Set();
}

/**
 * Walk 6 months of 1m candles for each ticker.
 * Find bars with a >2% forward move in the next 30 minutes (WIN/LOSS).
 * Embed the preceding 30-bar window and upsert to Pinecone.
 */
async function mineGoldenPatterns(
  tickers: string[],
  opts: {
    completedTickers: Set<string>;
    skipExisting: boolean;
    persistCheckpoint: boolean;
  }
): Promise<{ upserted: number; skippedExisting: number }> {
  const db = await getDb();
  const col = db.collection<Ohlc1m>(collections.ohlc1m);
  const since = DateTime.now().setZone(IST).minus({ months: 6 }).toJSDate();
  let upserted = 0;
  let skippedExisting = 0;
  const batchSize = Math.max(1, env.weekendOptimizeFetchBatch);

  for (const ticker of tickers) {
    if (opts.completedTickers.has(ticker)) {
      console.log(`[weekend-optimize] ${ticker}: skipped (already completed this run)`);
      continue;
    }

    const candles = await col
      .find({ ticker, ts: { $gte: since } })
      .sort({ ts: 1 })
      .toArray();

    if (candles.length < LOOKBACK_MIN * 2 + 10) {
      console.warn(`[weekend-optimize] skip ${ticker}: only ${candles.length} bars`);
      if (opts.persistCheckpoint) await weekendOptimizeAppendCompletedTicker(ticker);
      continue;
    }

    type Pending = { pre: Ohlc1m[]; id: string; meta: PatternMeta };
    const pending: Pending[] = [];

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
      const id = `${ticker}-${candles[i]!.ts.toISOString()}`;
      pending.push({
        pre,
        id,
        meta: {
          outcome,
          pnl_percent: Number(pnlPercent.toFixed(3)),
          date: candles[i]!.ts.toISOString().slice(0, 10),
          ticker,
          strategy: "MINED",
          sector: getTickerSector(ticker),
          vol_regime: classifyVolRegimeFromCandles(pre),
        },
      });
    }

    let tickerUpserts = 0;
    let tickerSkipped = 0;

    for (let j = 0; j < pending.length; j += batchSize) {
      const chunk = pending.slice(j, j + batchSize);
      const existing = opts.skipExisting
        ? await fetchExistingPatternIds(chunk.map((p) => p.id))
        : new Set<string>();

      for (const p of chunk) {
        if (existing.has(p.id)) {
          tickerSkipped++;
          skippedExisting++;
          continue;
        }
        const vec = await embedCandlePattern(p.pre);
        await upsertPatternVector(p.id, vec, p.meta);
        tickerUpserts++;
        upserted++;
      }
    }

    console.log(
      `[weekend-optimize] ${ticker}: ${tickerUpserts} upserted, ${tickerSkipped} already in Pinecone`
    );

    if (opts.persistCheckpoint) await weekendOptimizeAppendCompletedTicker(ticker);
  }

  return { upserted, skippedExisting };
}

async function main(): Promise<void> {
  await ensureIndexes();

  const flags = parseWeekendFlags();
  const persistCheckpoint = env.weekendOptimizeResume && !flags.noResume;
  const skipExisting = env.weekendOptimizeSkipExisting && !flags.reEmbedAll;

  const startedIstDate = istDateString();
  const tickers = await resolveOptimizeTickers();
  if (tickers.length === 0) {
    throw new Error(
      "[weekend-optimize] No tickers with sufficient data. Run discovery-sync and sync-history first."
    );
  }

  const tickersSig = hashTickers(tickers);
  const completed = await prepareCompletedTickers(
    startedIstDate,
    tickersSig,
    tickers,
    persistCheckpoint
  );

  const { upserted, skippedExisting } = await mineGoldenPatterns(tickers, {
    completedTickers: completed,
    skipExisting,
    persistCheckpoint,
  });

  if (persistCheckpoint) await clearWeekendOptimizeCheckpoint();

  console.log(
    `[weekend-optimize] Pinecone: ${upserted} new vectors upserted, ${skippedExisting} skipped (id already in index), across ${tickers.length} tickers`
  );

  // Run hybrid backtest sample on the first ticker with most data
  const primaryTicker = tickers[0] ?? env.watchedTickers[0] ?? "RELIANCE";
  const to = DateTime.now().setZone(IST).toJSDate();
  const from = DateTime.now().setZone(IST).minus({ months: 6 }).toJSDate();

  console.log(`[weekend-optimize] Running hybrid backtest sample on ${primaryTicker}...`);
  const ev = await runHybridBacktest({ ticker: primaryTicker, from, to, stepMinutes: 120 });
  console.log(`[weekend-optimize] hybrid replay events: ${ev.length}`);
}

runCli(main);
