import type { Ohlc1m } from "../types/domain.js";

/**
 * Indicators here are **bar-based** (last N rows in `candles`), not calendar-clock.
 * Mongo `ohlc_1m` has no rows on non-session days, so there is no synthetic “flat”
 * weekend string of prices—only a jump from the prior session’s last bar to the next.
 */
export function closes(candles: Ohlc1m[]): number[] {
  return candles.map((c) => c.c);
}

export function typicalPrices(candles: Ohlc1m[]): number[] {
  return candles.map((c) => (c.h + c.l + c.c) / 3);
}

/** Session VWAP using typical price * volume */
export function vwap(candles: Ohlc1m[]): number {
  if (candles.length === 0) return 0;
  let pv = 0;
  let vol = 0;
  for (const c of candles) {
    const tp = (c.h + c.l + c.c) / 3;
    pv += tp * c.v;
    vol += c.v;
  }
  return vol > 0 ? pv / vol : candles[candles.length - 1]!.c;
}

export function rsi(period: number, candles: Ohlc1m[]): number | undefined {
  const c = closes(candles);
  if (c.length <= period) return undefined;
  let gains = 0;
  let losses = 0;
  for (let i = c.length - period; i < c.length; i++) {
    const d = c[i]! - c[i - 1]!;
    if (d >= 0) gains += d;
    else losses -= d;
  }
  const avgG = gains / period;
  const avgL = losses / period;
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return 100 - 100 / (1 + rs);
}

export function rsiSeries(period: number, candles: Ohlc1m[]): (number | undefined)[] {
  const out: (number | undefined)[] = [];
  for (let i = 0; i < candles.length; i++) {
    out.push(rsi(period, candles.slice(0, i + 1)));
  }
  return out;
}

/** Population stdev of closes over window */
export function stdevCloses(candles: Ohlc1m[], window: number): number | undefined {
  if (candles.length < window) return undefined;
  const slice = candles.slice(-window);
  const xs = closes(slice);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((s, x) => s + (x - mean) **2, 0) / xs.length;
  return Math.sqrt(v);
}

export function zScoreVsVwap(candles: Ohlc1m[], vwapWindow: number): number | undefined {
  if (candles.length < 2) return undefined;
  const last = candles[candles.length - 1]!;
  const w = candles.slice(-Math.min(vwapWindow, candles.length));
  const vw = vwap(w);
  const sd = stdevCloses(w, Math.min(20, w.length));
  if (!sd || sd === 0) return undefined;
  return (last.c - vw) / sd;
}

export function volumeZScore(candles: Ohlc1m[], window = 20): number | undefined {
  if (candles.length < window) return undefined;
  const vols = candles.slice(-window).map((c) => c.v);
  const mean = vols.reduce((a, b) => a + b, 0) / vols.length;
  const var_ =
    vols.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(vols.length, 1);
  const sd = Math.sqrt(var_) || 1;
  const lastV = candles[candles.length - 1]!.v;
  return (lastV - mean) / sd;
}

export function avgVolume(candles: Ohlc1m[], window: number): number | undefined {
  if (candles.length < window) return undefined;
  const vols = candles.slice(-window).map((c) => c.v);
  return vols.reduce((a, b) => a + b, 0) / vols.length;
}

/** Detect simple RSI divergence: price lower low but RSI higher low (bullish) — minimal heuristic */
export function rsiBullishDivergence(
  candles: Ohlc1m[],
  lookback = 10
): boolean {
  if (candles.length < lookback + 15) return false;
  const window = candles.slice(-lookback - 15);
  const rs = rsiSeries(14, window).filter((x): x is number => x !== undefined);
  if (rs.length < lookback) return false;
  const prices = closes(window).slice(-lookback);
  const rsiSlice = rs.slice(-lookback);
  const pl = Math.min(...prices.slice(0, 5));
  const pr = Math.min(...prices.slice(-5));
  const rl = Math.min(...rsiSlice.slice(0, 5));
  const rr = Math.min(...rsiSlice.slice(-5));
  return pr < pl && rr > rl;
}

export function rsiBearishDivergence(candles: Ohlc1m[], lookback = 10): boolean {
  if (candles.length < lookback + 15) return false;
  const window = candles.slice(-lookback - 15);
  const rs = rsiSeries(14, window).filter((x): x is number => x !== undefined);
  if (rs.length < lookback) return false;
  const prices = closes(window).slice(-lookback);
  const rsiSlice = rs.slice(-lookback);
  const pl = Math.max(...prices.slice(0, 5));
  const pr = Math.max(...prices.slice(-5));
  const rl = Math.max(...rsiSlice.slice(0, 5));
  const rr = Math.max(...rsiSlice.slice(-5));
  return pr > pl && rr < rl;
}
