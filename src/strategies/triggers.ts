import type { Ohlc1m, StrategyId } from "../types/domain.js";
import {
  rsi,
  rsiBullishDivergence,
  rsiBearishDivergence,
  zScoreVsVwap,
  volumeZScore,
} from "../indicators/core.js";
import { detectOrbBreakoutUp } from "../indicators/orb.js";
import { detectLiquidityGrab, type PriorDayRange } from "../indicators/bigBoy.js";

export interface TriggerHit {
  strategy: StrategyId;
  snapshot: Record<string, number | undefined>;
  hint: string;
}

export function evaluateOrb(
  sessionCandles: Ohlc1m[]
): TriggerHit | undefined {
  const sig = detectOrbBreakoutUp(sessionCandles, 15, 1.5);
  if (!sig) return undefined;
  const last = sessionCandles[sessionCandles.length - 1]!;
  return {
    strategy: "ORB_15M",
    snapshot: {
      orb_high: sig.orb.high,
      orb_low: sig.orb.low,
      volume_z: sig.volumeZ,
      last_close: last.c,
    },
    hint: "ORB 15m high breakout with volume spike",
  };
}

export function evaluateMeanReversion(sessionCandles: Ohlc1m[]): TriggerHit | undefined {
  const z = zScoreVsVwap(sessionCandles, 20);
  const r = rsi(14, sessionCandles);
  const vz = volumeZScore(sessionCandles, 20);
  if (z === undefined || r === undefined) return undefined;

  const overextended = z > 2.5 && (rsiBearishDivergence(sessionCandles) || r > 70);
  const oversold = z < -2.5 && (rsiBullishDivergence(sessionCandles) || r < 30);

  if (!overextended && !oversold) return undefined;

  return {
    strategy: "MEAN_REV_Z",
    snapshot: {
      z_score_vwap: z,
      rsi: r,
      volume_z: vz,
    },
    hint: overextended ? "Overextended vs VWAP (mean reversion short bias)" : "Oversold vs VWAP (mean reversion long bias)",
  };
}

export function evaluateBigBoy(
  last5mBar: Ohlc1m,
  pd: PriorDayRange
): TriggerHit | undefined {
  const sweep = detectLiquidityGrab(last5mBar, pd);
  if (!sweep) return undefined;
  return {
    strategy: "BIG_BOY_SWEEP",
    snapshot: {
      pdh: pd.pdh,
      pdl: pd.pdl,
      c: last5mBar.c,
      h: last5mBar.h,
      l: last5mBar.l,
    },
    hint: `Liquidity grab at ${sweep.level}`,
  };
}
