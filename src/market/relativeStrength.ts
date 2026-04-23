import { DateTime } from "luxon";
import type { Ohlc1m } from "../types/domain.js";
import { IST } from "../time/ist.js";
import { vwap } from "../indicators/core.js";

/**
 * One session close per IST trading day: last 1m bar's close in that day.
 * Includes the current (partial) session with its latest close.
 */
function sessionClosesChronologicalByISTDay(ohlc: Ohlc1m[]): number[] {
  if (ohlc.length === 0) return [];
  const byDay = new Map<string, Ohlc1m[]>();
  for (const c of ohlc) {
    const key = DateTime.fromJSDate(c.ts, { zone: IST }).toFormat("yyyy-MM-dd");
    const arr = byDay.get(key) ?? [];
    arr.push(c);
    byDay.set(key, arr);
  }
  const keys = [...byDay.keys()].sort();
  return keys.map((k) => {
    const dayBars = byDay.get(k)!;
    return dayBars[dayBars.length - 1]!.c;
  });
}

/**
 * 5-trading-session % change from intraday 1m history, consistent with
 * `metricsFromDailyBars` / discovery `pct5d`: (close[-1] - close[-6]) / close[-6] * 100
 * over the last 6 **session** closes.
 */
export function pct5dFromIntradayHistory(ohlc: Ohlc1m[]): number | undefined {
  const closes = sessionClosesChronologicalByISTDay(ohlc);
  if (closes.length < 6) return undefined;
  const last6 = closes.slice(-6);
  const c0 = last6[0]!;
  const c5 = last6[5]!;
  if (!Number.isFinite(c0) || c0 === 0) return undefined;
  return ((c5 - c0) / c0) * 100;
}

/**
 * Nifty **spot session** (today): from-open gain not faded vs VWAP — supports
 * the "sustains its gains" rule for a catch-up long.
 */
export function niftySessionSustainsBullish(
  niftySession: Ohlc1m[],
  minFromOpenPct: number
): boolean {
  if (niftySession.length < 3) return false;
  const first = niftySession[0]!;
  const last = niftySession[niftySession.length - 1]!;
  if (first.o <= 0) return false;
  const fromOpen = ((last.c - first.o) / first.o) * 100;
  if (fromOpen < minFromOpenPct) return false;
  const vw = vwap(niftySession);
  if (last.c < vw) return false;
  return true;
}
