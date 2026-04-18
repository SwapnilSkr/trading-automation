import type { Ohlc1m } from "../types/domain.js";

export interface PriorDayRange {
  pdh: number;
  pdl: number;
}

export function priorDayHighLow(dayCandles: Ohlc1m[]): PriorDayRange | undefined {
  if (dayCandles.length === 0) return undefined;
  let hi = -Infinity;
  let lo = Infinity;
  for (const c of dayCandles) {
    hi = Math.max(hi, c.h);
    lo = Math.min(lo, c.l);
  }
  return { pdh: hi, pdl: lo };
}

export interface LiquiditySweepSignal {
  kind: "BIG_BOY_SWEEP";
  level: "PDH" | "PDL";
  pierced: boolean;
  closedInside: boolean;
}

/**
 * 5m candle pierces PDH or PDL but closes back inside prior range (fakeout heuristic).
 * Pass the last candle as aggregated 5m bar.
 */
export function detectLiquidityGrab(
  last5m: Ohlc1m,
  pd: PriorDayRange
): LiquiditySweepSignal | undefined {
  const inside =
    last5m.c < pd.pdh && last5m.c > pd.pdl;
  const piercedHigh = last5m.h > pd.pdh && last5m.c <= pd.pdh;
  const piercedLow = last5m.l < pd.pdl && last5m.c >= pd.pdl;

  if (piercedHigh && inside) {
    return {
      kind: "BIG_BOY_SWEEP",
      level: "PDH",
      pierced: true,
      closedInside: true,
    };
  }
  if (piercedLow && inside) {
    return {
      kind: "BIG_BOY_SWEEP",
      level: "PDL",
      pierced: true,
      closedInside: true,
    };
  }
  return undefined;
}
