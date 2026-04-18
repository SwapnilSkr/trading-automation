import type { BrokerClient } from "../broker/types.js";
import { env } from "../config/env.js";
import { upsertSessionWatchlist } from "../db/repositories.js";
import { metricsFromDailyBars } from "../discovery/performerScore.js";
import { loadNifty100Symbols } from "../discovery/niftyUniverse.js";
import type {
  ActiveWatchlistDoc,
  PerformerScoreRow,
} from "../types/domain.js";
import { syncOhlcForRange } from "./marketSync.js";
import { DateTime } from "luxon";
import { IST, nowIST } from "../time/ist.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface DiscoverySyncOptions {
  days: number;
  top: number;
  refreshUniverseCsv: boolean;
  skipOhlcSync: boolean;
  dryRun: boolean;
}

export interface DiscoverySyncResult {
  universeSize: number;
  scored: number;
  performers: PerformerScoreRow[];
  ohlc?: { ticker: string; bars: number }[];
}

export async function runDiscoverySync(
  broker: BrokerClient,
  opts: DiscoverySyncOptions
): Promise<DiscoverySyncResult> {
  const symbols = await loadNifty100Symbols({
    refreshFromNse: opts.refreshUniverseCsv,
  });
  if (symbols.length === 0) {
    throw new Error("Nifty 100 symbol list is empty");
  }

  const end = nowIST().endOf("day").toJSDate();
  const start = DateTime.fromJSDate(end, { zone: IST })
    .minus({ days: opts.days + 10 })
    .startOf("day")
    .toJSDate();

  const metricsList: PerformerScoreRow[] = [];
  let scored = 0;

  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i]!;
    const bars = await broker.fetchDailyOhlc(sym, start, end);
    const m = metricsFromDailyBars(sym, bars);
    if (m) {
      metricsList.push({
        ticker: m.ticker,
        score: m.score,
        pct5d: m.pct5d,
        volRatio: m.volRatio,
      });
      scored++;
    }

    if (i < symbols.length - 1 && env.discoverySymbolDelayMs > 0) {
      await sleep(env.discoverySymbolDelayMs);
    }
  }

  metricsList.sort((a, b) => b.score - a.score);
  const performers = metricsList.slice(0, opts.top);

  if (opts.dryRun) {
    return { universeSize: symbols.length, scored, performers };
  }

  const sessionDoc: ActiveWatchlistDoc = {
    _id: "current_session",
    tickers: performers.map((p) => p.ticker),
    updated_at: new Date(),
    source: "discovery_nifty100",
    performers,
  };
  await upsertSessionWatchlist(sessionDoc);

  let ohlc: { ticker: string; bars: number }[] | undefined;
  if (!opts.skipOhlcSync && performers.length > 0) {
    const ohlcFrom = DateTime.fromJSDate(end, { zone: IST })
      .minus({ days: opts.days })
      .startOf("day")
      .toJSDate();
    ohlc = await syncOhlcForRange(
      broker,
      ohlcFrom,
      end,
      performers.map((p) => p.ticker)
    );
  }

  return { universeSize: symbols.length, scored, performers, ohlc };
}
