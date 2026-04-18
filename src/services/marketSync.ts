import type { BrokerClient } from "../broker/types.js";
import { env } from "../config/env.js";
import { upsertOhlcBatch } from "../db/repositories.js";
import { nowIST } from "../time/ist.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Post-market sync: 1m OHLC for watched tickers → MongoDB (recent session window) */
export async function syncIntradayHistory(broker: BrokerClient): Promise<void> {
  const end = nowIST().endOf("day").toJSDate();
  const start = nowIST().minus({ hours: 6 }).toJSDate();
  await syncOhlcForRange(broker, start, end, env.watchedTickers);
}

/**
 * Bootstrap / backfill: fetch1m candles from Angel for [from, to] (inclusive of days)
 * and upsert into Mongo. Angel `getCandleData` is called in day-chunks inside the broker.
 */
export async function syncOhlcForRange(
  broker: BrokerClient,
  from: Date,
  to: Date,
  tickers: string[] | undefined
): Promise<{ ticker: string; bars: number }[]> {
  const list = tickers ?? [];
  const out: { ticker: string; bars: number }[] = [];
  for (let i = 0; i < list.length; i++) {
    const ticker = list[i]!;
    const rows = await broker.fetchIntradayOhlc1m(ticker, from, to);
    if (rows.length) await upsertOhlcBatch(rows);
    out.push({ ticker, bars: rows.length });
    if (i < list.length - 1 && env.angelSyncTickerGapMs > 0) {
      await sleep(env.angelSyncTickerGapMs);
    }
  }
  return out;
}
