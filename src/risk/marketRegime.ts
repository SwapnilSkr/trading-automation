import { env } from "../config/env.js";
import { fetchOhlcRange } from "../db/repositories.js";
import type { Ohlc1m, StrategyId } from "../types/domain.js";
import { DateTime } from "luxon";
import { IST, nowIST } from "../time/ist.js";

export interface MarketRegimeSnapshot {
  at: Date;
  niftyChangePct?: number;
  breadthGreenRatio?: number;
  watchlistCount: number;
}

export interface MarketRegimeEval {
  allowed: boolean;
  reasons: string[];
  soft_penalties: string[];
  nifty_change_pct?: number;
  breadth_green_ratio?: number;
  size_multiplier: number;
  confidence_floor: number;
}

function dayChangePct(bars: Ohlc1m[]): number | undefined {
  if (bars.length === 0) return undefined;
  const first = bars[0]!;
  const last = bars[bars.length - 1]!;
  const base = first.o || first.c;
  if (base <= 0) return undefined;
  return ((last.c - base) / base) * 100;
}

export function isLongBreakoutStrategy(strategy: StrategyId): boolean {
  return (
    strategy === "ORB_15M" ||
    strategy === "ORB_RETEST_15M" ||
    strategy === "VWAP_RECLAIM_REJECT" ||
    strategy === "VWAP_PULLBACK_TREND" ||
    strategy === "PREV_DAY_HIGH_LOW_BREAK_RETEST" ||
    strategy === "EMA20_BREAK_RETEST" ||
    strategy === "VWAP_RECLAIM_CONTINUATION" ||
    strategy === "INITIAL_BALANCE_BREAK_RETEST" ||
    strategy === "VOLATILITY_CONTRACTION_BREAKOUT" ||
    strategy === "INSIDE_BAR_BREAKOUT_WITH_RETEST" ||
    strategy === "OPEN_DRIVE_PULLBACK"
  );
}

export async function buildMarketRegimeSnapshot(
  tickers: string[],
  at = nowIST().toJSDate()
): Promise<MarketRegimeSnapshot> {
  const start = DateTime.fromJSDate(at, { zone: IST }).startOf("day").toJSDate();
  const niftyBars = await fetchOhlcRange(env.niftySymbol, start, at);
  const niftyChangePct = dayChangePct(niftyBars);

  const unique = [...new Set(tickers.filter((t) => t !== env.niftySymbol))];
  const rows = await Promise.all(
    unique.map(async (ticker) => fetchOhlcRange(ticker, start, at))
  );
  let green = 0;
  let usable = 0;
  for (const bars of rows) {
    const change = dayChangePct(bars);
    if (change === undefined) continue;
    usable++;
    if (change > 0) green++;
  }

  return {
    at,
    niftyChangePct,
    breadthGreenRatio: usable > 0 ? green / usable : undefined,
    watchlistCount: usable,
  };
}

export function evaluateMarketRegime(
  strategy: StrategyId,
  side: "BUY" | "SELL",
  snapshot?: MarketRegimeSnapshot
): MarketRegimeEval {
  if (!env.marketGateEnabled || !snapshot) {
    return {
      allowed: true,
      reasons: [],
      soft_penalties: [],
      size_multiplier: 1,
      confidence_floor: 0,
    };
  }

  const reasons: string[] = [];
  const softPenalties: string[] = [];
  const weakReasons: string[] = [];
  let confidenceFloor = 0;
  const isLongBreakout = side === "BUY" && isLongBreakoutStrategy(strategy);
  const nifty = snapshot.niftyChangePct;
  const breadth = snapshot.breadthGreenRatio;

  const niftyHardWeak =
    nifty !== undefined && nifty <= env.marketBlockLongBreakoutsNiftyPct;
  const breadthHardWeak =
    breadth !== undefined && breadth < env.marketBlockLongBreakoutsBreadth;

  // For long breakout families, require both hard conditions to kill.
  // A single weak dimension is throttled instead of vetoed.
  if (isLongBreakout && niftyHardWeak && breadthHardWeak) {
    reasons.push(
      `NIFTY ${nifty!.toFixed(2)}% <= ${env.marketBlockLongBreakoutsNiftyPct}% and breadth ${(breadth! * 100).toFixed(0)}% < ${(env.marketBlockLongBreakoutsBreadth * 100).toFixed(0)}%`
    );
  } else if (isLongBreakout && (niftyHardWeak || breadthHardWeak)) {
    softPenalties.push(
      `breakout soft-throttle: ${niftyHardWeak ? `NIFTY ${nifty!.toFixed(2)}%` : `breadth ${(breadth! * 100).toFixed(0)}%`}`
    );
    confidenceFloor = Math.max(confidenceFloor, env.marketWeakConfidenceFloor);
  }

  if (nifty !== undefined && nifty <= env.marketWeakNiftyPct) {
    weakReasons.push(`weak NIFTY ${nifty.toFixed(2)}%`);
  }
  if (breadth !== undefined && breadth < env.marketWeakBreadth) {
    weakReasons.push(`weak breadth ${(breadth * 100).toFixed(0)}%`);
  }
  if (weakReasons.length > 0) {
    confidenceFloor = Math.max(confidenceFloor, env.marketWeakConfidenceFloor);
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    soft_penalties: [...softPenalties, ...weakReasons],
    nifty_change_pct: nifty,
    breadth_green_ratio: breadth,
    size_multiplier: weakReasons.length > 0 ? env.marketWeakSizeMultiplier : 1,
    confidence_floor: confidenceFloor,
  };
}
