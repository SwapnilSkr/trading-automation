import type { BrokerClient } from "../broker/types.js";
import { env } from "../config/env.js";
import {
  upsertSessionWatchlist,
  upsertWatchlistSnapshot,
} from "../db/repositories.js";
import { metricsFromDailyBars } from "../discovery/performerScore.js";
import { loadNifty100Symbols } from "../discovery/niftyUniverse.js";
import type {
  ActiveWatchlistDoc,
  PerformerScoreRow,
  WatchlistSnapshotDoc,
} from "../types/domain.js";
import { syncOhlcForRange } from "./marketSync.js";
import { DateTime } from "luxon";
import { IST, nextIndianWeekdayAfter, nowIST } from "../time/ist.js";
import { getNifty50HeavyweightSupplementalTickers } from "../market/niftyHeavyweights.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface DiscoverySyncOptions {
  days: number;
  top: number;
  refreshUniverseCsv: boolean;
  skipOhlcSync: boolean;
  dryRun: boolean;
  /** IST yyyy-MM-dd — scoring window ends this calendar day (default: today) */
  asOfDate?: string;
  /** IST yyyy-MM-dd — watchlist applies to this session (default: next weekday after asOf) */
  effectiveForDate?: string;
  /** Write `current_session` (default true) */
  updateCurrentSession?: boolean;
  /** Write `watchlist_snapshots` (default true when not dry-run) */
  writeSnapshot?: boolean;
  snapshotSource?: string;
}

export interface DiscoverySyncResult {
  universeSize: number;
  scored: number;
  performers: PerformerScoreRow[];
  effectiveFor?: string;
  asOf?: string;
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

  const asOf = opts.asOfDate
    ? DateTime.fromISO(opts.asOfDate, { zone: IST })
    : nowIST();
  if (!asOf.isValid) {
    throw new Error(`Invalid asOfDate (use YYYY-MM-DD IST): ${opts.asOfDate}`);
  }

  const end = asOf.endOf("day").toJSDate();
  const start = asOf
    .minus({ days: opts.days + 10 })
    .startOf("day")
    .toJSDate();

  const effectiveDt = opts.effectiveForDate
    ? DateTime.fromISO(opts.effectiveForDate, { zone: IST })
    : nextIndianWeekdayAfter(asOf);
  if (!effectiveDt.isValid) {
    throw new Error(
      `Invalid effectiveForDate: ${opts.effectiveForDate}`
    );
  }
  const effectiveIso = effectiveDt.toFormat("yyyy-MM-dd");

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

    if (
      i < symbols.length - 1 &&
      env.angelHttpMinGapMs <= 0 &&
      env.discoverySymbolDelayMs > 0
    ) {
      await sleep(env.discoverySymbolDelayMs);
    }
  }

  metricsList.sort((a, b) => b.score - a.score);
  const performers = metricsList.slice(0, opts.top);

  const updateSession = opts.updateCurrentSession !== false;
  const writeSnap =
    opts.writeSnapshot !== false && opts.dryRun !== true;

  if (opts.dryRun) {
    return {
      universeSize: symbols.length,
      scored,
      performers,
      effectiveFor: effectiveIso,
      asOf: asOf.toFormat("yyyy-MM-dd"),
    };
  }

  if (writeSnap) {
    const snap: WatchlistSnapshotDoc = {
      effective_date: effectiveIso,
      tickers: performers.map((p) => p.ticker),
      source: opts.snapshotSource ?? "discovery_nifty100",
      performers,
      created_at: new Date(),
    };
    await upsertWatchlistSnapshot(snap);
  }

  if (updateSession) {
    const sessionDoc: ActiveWatchlistDoc = {
      _id: "current_session",
      tickers: performers.map((p) => p.ticker),
      updated_at: new Date(),
      source: opts.snapshotSource ?? "discovery_nifty100",
      performers,
    };
    await upsertSessionWatchlist(sessionDoc);
  }

  let ohlc: { ticker: string; bars: number }[] | undefined;
  if (!opts.skipOhlcSync && performers.length > 0) {
    const ohlcFrom = asOf
      .minus({ days: opts.days })
      .startOf("day")
      .toJSDate();
    const hw = env.discoverySyncIndexLaggardUniverse
      ? await getNifty50HeavyweightSupplementalTickers(broker)
      : [];
    const tickersForOhlc = env.discoverySyncIndexLaggardUniverse
      ? [
          ...new Set([
            ...performers.map((p) => p.ticker),
            env.niftySymbol,
            ...hw,
          ]),
        ]
      : performers.map((p) => p.ticker);
    ohlc = await syncOhlcForRange(broker, ohlcFrom, end, tickersForOhlc);
  }

  return {
    universeSize: symbols.length,
    scored,
    performers,
    effectiveFor: effectiveIso,
    asOf: asOf.toFormat("yyyy-MM-dd"),
    ohlc,
  };
}
