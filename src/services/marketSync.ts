import type { BrokerClient } from "../broker/types.js";
import { env } from "../config/env.js";
import { upsertOhlcBatch } from "../db/repositories.js";
import { nowIST } from "../time/ist.js";

/** Post-market sync: 1m OHLC for watched tickers → MongoDB */
export async function syncIntradayHistory(broker: BrokerClient): Promise<void> {
  const end = nowIST().endOf("day").toJSDate();
  const start = nowIST().minus({ hours: 6 }).toJSDate();

  for (const ticker of env.watchedTickers) {
    const rows = await broker.fetchIntradayOhlc1m(ticker, start, end);
    if (rows.length) await upsertOhlcBatch(rows);
  }
}
