import { env } from "../config/env.js";
import { istDateString, nowIST } from "../time/ist.js";
import type { BrokerClient } from "../broker/types.js";
import {
  fetchNifty50SymbolsFromNseArchives,
  loadNifty50ListFromDisk,
} from "./nifty50Constituents.js";

/**
 * Baked-in fallbacks (Apr 2026 reference). Used when `NIFTY_HEAVYWEIGHTS_MODE=static`,
 * or before the first live refresh, or when dynamic resolution fails.
 */
export const NIFTY50_HEAVYWEIGHT_TICKERS: readonly string[] = [
  "RELIANCE",
  "HDFCBANK",
  "BHARTIARTL",
  "SBIN",
  "ICICIBANK",
  "TCS",
  "BAJFINANCE",
  "LT",
  "HINDUNILVR",
  "INFY",
];

/** Same as {@link NIFTY50_HEAVYWEIGHT_TICKERS} for explicit naming */
export const DEFAULT_NIFTY50_HEAVYWEIGHTS = NIFTY50_HEAVYWEIGHT_TICKERS;

let heavyweightsCache: {
  istDay: string;
  tickers: string[];
  source: "dynamic" | "static_fallback";
} | null = null;

function staticSet(): Set<string> {
  return new Set(NIFTY50_HEAVYWEIGHT_TICKERS.map((s) => s.toUpperCase()));
}

/**
 * Ranks Nifty-50 members by notional **turnover proxy** (LTP × day volume) from SmartAPI
 * `market/v1/quote` FULL. Requests go through `scheduleSmartApiCall` in `SmartApiHttp`
 * (same limiter as all Angel REST calls), **not** NSE fetches.
 *
 * This is a **practical** stand-in for index weight: Angel does not publish index weights.
 * True float weights come from NSE / Nifty Indices factsheets, not the trading API.
 */
export async function rankNifty50ByTurnoverProxy(
  broker: BrokerClient,
  universe: string[]
): Promise<Array<{ ticker: string; score: number }>> {
  const u = [...new Set(universe.map((s) => s.replace(/-EQ$/i, "").trim().toUpperCase()))].filter(
    Boolean
  );
  if (u.length === 0) return [];

  const rows = await broker.fetchMarketQuotesFull(u);
  const byTicker = new Map<string, (typeof rows)[0]>();
  for (const r of rows) {
    byTicker.set(r.ticker.toUpperCase().replace(/-EQ$/i, ""), r);
  }

  const scored: Array<{ ticker: string; score: number }> = [];
  for (const t of u) {
    const row = byTicker.get(t);
    const ltp = row?.ltp ?? 0;
    const vol = row?.tradeVolume ?? 0;
    const score = Math.abs(ltp) * Math.max(0, vol);
    scored.push({ ticker: t, score: Number.isFinite(score) ? score : 0 });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Fetches the official Nifty-50 membership from NSE archives (HTTP, not SmartAPI),
 * then takes the top N names by LTP×volume from Angel `marketQuote` (rate-limited via
 * `SmartApiHttp` → `scheduleSmartApiCall`). Call once per IST session (e.g. orchestrator
 * init) or on demand from CLI.
 */
export async function resolveNifty50HeavyweightsLive(
  broker: BrokerClient
): Promise<string[]> {
  const topN = Math.max(1, Math.min(25, env.niftyHeavyweightsDynamicTopN));
  const istDay = istDateString(nowIST());
  if (
    heavyweightsCache?.istDay === istDay &&
    heavyweightsCache.source === "dynamic" &&
    heavyweightsCache.tickers.length >= Math.min(5, topN)
  ) {
    return [...heavyweightsCache.tickers];
  }

  let universe: string[] = [];
  try {
    universe = await fetchNifty50SymbolsFromNseArchives({ writeCache: true });
  } catch (e) {
    console.warn(
      `[Nifty50 HW] NSE list fetch failed (${String(e).slice(0, 120)}), using disk/defaults`
    );
    try {
      universe = loadNifty50ListFromDisk();
    } catch {
      universe = [];
    }
  }
  if (universe.length < 20) {
    const fb = NIFTY50_HEAVYWEIGHT_TICKERS;
    heavyweightsCache = {
      istDay,
      tickers: [...fb],
      source: "static_fallback",
    };
    return [...fb];
  }

  const ranked = await rankNifty50ByTurnoverProxy(broker, universe);
  const pick = ranked
    .slice(0, topN)
    .map((r) => r.ticker)
    .filter(Boolean);

  if (pick.length < Math.min(5, topN)) {
    const fb = NIFTY50_HEAVYWEIGHT_TICKERS;
    heavyweightsCache = {
      istDay,
      tickers: [...fb],
      source: "static_fallback",
    };
    return [...fb];
  }

  heavyweightsCache = { istDay, tickers: pick, source: "dynamic" };
  return pick;
}

export function getCachedNifty50Heavyweights(): typeof heavyweightsCache {
  return heavyweightsCache;
}

/**
 * Ticker set used for `INDEX_LAGGARD_CATCHUP` and OHLC supplement lists.
 * Returns static list when `NIFTY_HEAVYWEIGHTS_MODE=static`, backtest, or when cache is cold.
 */
export function getNifty50HeavyweightTickersSync(options?: {
  isBacktest?: boolean;
}): string[] {
  if (env.niftyHeavyweightsMode === "static" || options?.isBacktest) {
    return [...NIFTY50_HEAVYWEIGHT_TICKERS];
  }
  if (
    heavyweightsCache?.tickers?.length &&
    heavyweightsCache.istDay === istDateString(nowIST())
  ) {
    return [...heavyweightsCache.tickers];
  }
  return [...NIFTY50_HEAVYWEIGHT_TICKERS];
}

export function isNifty50Heavyweight(
  ticker: string,
  options?: { isBacktest?: boolean }
): boolean {
  const s = ticker.trim().toUpperCase();
  const set = new Set(
    getNifty50HeavyweightTickersSync({ isBacktest: options?.isBacktest }).map((x) =>
      x.toUpperCase()
    )
  );
  return set.has(s);
}

/**
 * For async pipelines (discovery-sync, market sync): use live cache or static.
 */
export async function getNifty50HeavyweightSupplementalTickers(
  broker: BrokerClient | undefined,
  options?: { isBacktest?: boolean }
): Promise<string[]> {
  if (env.niftyHeavyweightsMode === "static" || options?.isBacktest) {
    return [...NIFTY50_HEAVYWEIGHT_TICKERS];
  }
  if (broker) {
    try {
      await resolveNifty50HeavyweightsLive(broker);
    } catch (e) {
      console.warn(`[Nifty50 HW] resolve failed: ${String(e).slice(0, 200)}`);
    }
  }
  return getNifty50HeavyweightTickersSync(options);
}
