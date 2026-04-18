import type { Ohlc1m } from "../types/domain.js";
import { avgVolume, volumeZScore } from "./core.js";

export interface OrbLevels {
  high: number;
  low: number;
  start: Date;
  end: Date;
}

/** First `minutes` bars of session — pass only today's candles from open */
export function openingRange(
  sessionCandles: Ohlc1m[],
  minutes = 15
): OrbLevels | undefined {
  const first = sessionCandles.slice(0, minutes);
  if (first.length < minutes) return undefined;
  let hi = -Infinity;
  let lo = Infinity;
  for (const c of first) {
    hi = Math.max(hi, c.h);
    lo = Math.min(lo, c.l);
  }
  return {
    high: hi,
    low: lo,
    start: first[0]!.ts,
    end: first[first.length - 1]!.ts,
  };
}

export interface OrbBreakoutSignal {
  kind: "ORB_BREAKOUT_UP";
  orb: OrbLevels;
  volumeZ: number;
  spikeVsAvg: number;
}

/** Break above ORB high with volume spike (> 1.5x recent average) */
export function detectOrbBreakoutUp(
  sessionCandles: Ohlc1m[],
  orbMinutes = 15,
  spikeMultiplier = 1.5
): OrbBreakoutSignal | undefined {
  const orb = openingRange(sessionCandles, orbMinutes);
  if (!orb) return undefined;
  const afterOrb = sessionCandles.slice(orbMinutes);
  if (afterOrb.length === 0) return undefined;
  const last = afterOrb[afterOrb.length - 1]!;
  if (last.c <= orb.high) return undefined;

  const vz = volumeZScore(sessionCandles, 20);
  const av = avgVolume(sessionCandles, 20);
  if (vz === undefined || av === undefined || av === 0) return undefined;
  const spikeVsAvg = last.v / av;
  if (spikeVsAvg < spikeMultiplier) return undefined;

  return { kind: "ORB_BREAKOUT_UP", orb, volumeZ: vz, spikeVsAvg };
}
