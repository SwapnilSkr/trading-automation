import type { Ohlc1m } from "../types/domain.js";

export interface PerformerMetrics {
  ticker: string;
  pct5d: number;
  volRatio: number;
  score: number;
}

/**
 * Last bar = most recent session. `pct5d` = % change from close 5 sessions
 * earlier to latest close. `volRatio` = last volume / mean volume of last 5 sessions.
 * `score` = |pct5d| * volRatio (liquidity-weighted momentum).
 */
export function metricsFromDailyBars(
  ticker: string,
  bars: Ohlc1m[]
): PerformerMetrics | null {
  if (bars.length < 6) return null;
  const sorted = [...bars].sort(
    (a, b) => a.ts.getTime() - b.ts.getTime()
  );
  const last6 = sorted.slice(-6);
  const c0 = last6[0]!.c;
  const c5 = last6[5]!.c;
  if (!Number.isFinite(c0) || c0 === 0) return null;
  const pct5d = ((c5 - c0) / c0) * 100;

  const last5 = sorted.slice(-5);
  const volMean =
    last5.reduce((s, b) => s + b.v, 0) / Math.max(last5.length, 1) || 1;
  const lastVol = sorted[sorted.length - 1]!.v;
  const volRatio = lastVol / volMean;

  const score = Math.abs(pct5d) * volRatio;
  return { ticker, pct5d, volRatio, score };
}
