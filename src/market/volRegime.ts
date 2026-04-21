import { env } from "../config/env.js";
import type { Ohlc1m } from "../types/domain.js";

export type VolRegime = "LOW" | "MID" | "HIGH";

export function classifyVolRegimeFromCandles(
  sessionCandles: Ohlc1m[]
): VolRegime | undefined {
  const lookback = Math.max(10, Math.floor(env.volRegimeLookbackBars));
  if (sessionCandles.length < lookback + 1) return undefined;

  const slice = sessionCandles.slice(-lookback - 1);
  const returnsPct: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    const prev = slice[i - 1]!.c;
    const curr = slice[i]!.c;
    if (prev <= 0) continue;
    returnsPct.push(((curr - prev) / prev) * 100);
  }
  if (returnsPct.length < 8) return undefined;

  const mean = returnsPct.reduce((a, b) => a + b, 0) / returnsPct.length;
  const variance =
    returnsPct.reduce((s, r) => s + (r - mean) ** 2, 0) / returnsPct.length;
  const sigma = Math.sqrt(variance);

  if (sigma < env.volRegimeLowMaxPct) return "LOW";
  if (sigma >= env.volRegimeHighMinPct) return "HIGH";
  return "MID";
}
