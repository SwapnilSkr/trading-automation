import type { Ohlc1m, StrategyId } from "../types/domain.js";
import {
  rsi,
  rsiBullishDivergence,
  rsiBearishDivergence,
  zScoreVsVwap,
  vwap,
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

export function evaluateVwapReclaimReject(
  sessionCandles: Ohlc1m[]
): TriggerHit | undefined {
  if (sessionCandles.length < 25) return undefined;

  const last = sessionCandles[sessionCandles.length - 1]!;
  const prev = sessionCandles[sessionCandles.length - 2]!;
  const vw = vwap(sessionCandles.slice(-Math.min(30, sessionCandles.length)));
  const vz = volumeZScore(sessionCandles, 20);

  const touchTol = 0.0015; // 0.15%
  const touched =
    (last.l <= vw && last.h >= vw) ||
    Math.abs(last.l - vw) / vw <= touchTol ||
    Math.abs(last.h - vw) / vw <= touchTol;
  const volumeOk = vz === undefined || vz > 0;

  const reclaim = prev.c < vw && last.c > vw && touched && volumeOk;
  const reject = prev.c > vw && last.c < vw && touched && volumeOk;

  if (!reclaim && !reject) return undefined;

  return {
    strategy: "VWAP_RECLAIM_REJECT",
    snapshot: {
      vwap: vw,
      prev_close: prev.c,
      last_close: last.c,
      vwap_dist: ((last.c - vw) / vw) * 100,
      vwap_signal: reclaim ? 1 : -1,
      volume_z: vz,
    },
    hint: reclaim
      ? "VWAP reclaim: close crossed back above VWAP after prior weakness"
      : "VWAP rejection: close crossed back below VWAP after prior strength",
  };
}
