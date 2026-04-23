import { DateTime } from "luxon";
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
import {
  detectLiquidityGrab,
  type PriorDayRange,
} from "../indicators/bigBoy.js";
import { IST } from "../time/ist.js";
import { env } from "../config/env.js";
import { isNifty50Heavyweight } from "../market/niftyHeavyweights.js";
import { niftySessionSustainsBullish } from "../market/relativeStrength.js";

export interface TriggerHit {
  strategy: StrategyId;
  side: "BUY" | "SELL";
  snapshot: Record<string, number | undefined>;
  hint: string;
}

const OPEN_MIN = 9 * 60 + 15;

function minuteOfBar(c: Ohlc1m): number {
  const dt = DateTime.fromJSDate(c.ts, { zone: IST });
  return dt.hour * 60 + dt.minute;
}

function barsInMinuteWindow(
  candles: Ohlc1m[],
  fromMinInclusive: number,
  toMinInclusive: number,
): Ohlc1m[] {
  return candles.filter((c) => {
    const m = minuteOfBar(c);
    return m >= fromMinInclusive && m <= toMinInclusive;
  });
}

function rangeOf(candles: Ohlc1m[]): { high: number; low: number } | undefined {
  if (candles.length === 0) return undefined;
  return {
    high: Math.max(...candles.map((c) => c.h)),
    low: Math.min(...candles.map((c) => c.l)),
  };
}

function ema(candles: Ohlc1m[], period: number): number | undefined {
  if (candles.length < period) return undefined;
  const k = 2 / (period + 1);
  let value = candles.slice(0, period).reduce((s, c) => s + c.c, 0) / period;
  for (let i = period; i < candles.length; i++) {
    value = candles[i]!.c * k + value * (1 - k);
  }
  return value;
}

function hasBreakAbove(
  candles: Ohlc1m[],
  level: number,
  tol = 0.0005,
): boolean {
  return candles.some((c) => c.h > level * (1 + tol));
}

function hasBreakBelow(
  candles: Ohlc1m[],
  level: number,
  tol = 0.0005,
): boolean {
  return candles.some((c) => c.l < level * (1 - tol));
}

function recentBreakAbove(
  candles: Ohlc1m[],
  level: number,
  maxBars: number,
  tol = 0.0005,
): boolean {
  return hasBreakAbove(candles.slice(-Math.max(1, maxBars)), level, tol);
}

function recentBreakBelow(
  candles: Ohlc1m[],
  level: number,
  maxBars: number,
  tol = 0.0005,
): boolean {
  return hasBreakBelow(candles.slice(-Math.max(1, maxBars)), level, tol);
}

export function evaluateOrb(sessionCandles: Ohlc1m[]): TriggerHit | undefined {
  const sig = detectOrbBreakoutUp(sessionCandles, 15, 1.5);
  if (!sig) return undefined;
  const last = sessionCandles[sessionCandles.length - 1]!;
  return {
    strategy: "ORB_15M",
    side: "BUY",
    snapshot: {
      orb_high: sig.orb.high,
      orb_low: sig.orb.low,
      volume_z: sig.volumeZ,
      last_close: last.c,
    },
    hint: "ORB 15m high breakout with volume spike",
  };
}

export function evaluateOrbRetest15m(
  sessionCandles: Ohlc1m[],
): TriggerHit | undefined {
  if (sessionCandles.length < 30) return undefined;
  const orbBars = barsInMinuteWindow(sessionCandles, OPEN_MIN, OPEN_MIN + 14);
  const orb = rangeOf(orbBars);
  if (!orb) return undefined;

  const last = sessionCandles[sessionCandles.length - 1]!;
  const prev = sessionCandles[sessionCandles.length - 2]!;
  if (minuteOfBar(last) < OPEN_MIN + 20) return undefined;

  const afterOrb = sessionCandles.filter((c) => minuteOfBar(c) > OPEN_MIN + 14);
  const completedAfterOrb = afterOrb.slice(0, -1);
  const brokeUp = recentBreakAbove(
    completedAfterOrb,
    orb.high,
    env.retestMaxBarsAfterBreak,
  );
  const brokeDown = recentBreakBelow(
    completedAfterOrb,
    orb.low,
    env.retestMaxBarsAfterBreak,
  );

  const longRetest =
    brokeUp &&
    last.l <= orb.high * 1.001 &&
    last.c > orb.high &&
    last.c > prev.c;

  if (longRetest) {
    return {
      strategy: "ORB_RETEST_15M",
      side: "BUY",
      snapshot: {
        orb_high: orb.high,
        orb_low: orb.low,
        retest_level: orb.high,
        last_close: last.c,
      },
      hint: "ORB breakout retest hold above ORH",
    };
  }

  const shortRetest =
    brokeDown &&
    last.h >= orb.low * 0.999 &&
    last.c < orb.low &&
    last.c < prev.c;

  if (shortRetest) {
    return {
      strategy: "ORB_RETEST_15M",
      side: "SELL",
      snapshot: {
        orb_high: orb.high,
        orb_low: orb.low,
        retest_level: orb.low,
        last_close: last.c,
      },
      hint: "ORB breakdown retest fail below ORL",
    };
  }

  return undefined;
}

export function evaluateMeanReversion(
  sessionCandles: Ohlc1m[],
): TriggerHit | undefined {
  const z = zScoreVsVwap(sessionCandles, 20);
  const r = rsi(14, sessionCandles);
  const vz = volumeZScore(sessionCandles, 20);
  if (z === undefined || r === undefined) return undefined;

  // Lowered from 2.5 to 2.0: catches overextensions sooner.
  // Removed divergence requirement — just use RSI extreme directly.
  const overextended = z > 2.0 && r > 68;
  const oversold = z < -2.0 && r < 32;

  if (!overextended && !oversold) return undefined;

  return {
    strategy: "MEAN_REV_Z",
    side: overextended ? "SELL" : "BUY",
    snapshot: {
      z_score_vwap: z,
      rsi: r,
      volume_z: vz,
      meanrev_signal: overextended ? -1 : 1,
    },
    hint: overextended
      ? `Overextended vs VWAP (z=${z.toFixed(2)}, RSI=${r.toFixed(0)}) — mean reversion short`
      : `Oversold vs VWAP (z=${z.toFixed(2)}, RSI=${r.toFixed(0)}) — mean reversion long`,
  };
}

export function evaluateBigBoy(
  last5mBar: Ohlc1m,
  pd: PriorDayRange,
): TriggerHit | undefined {
  const sweep = detectLiquidityGrab(last5mBar, pd);
  if (!sweep) return undefined;
  return {
    strategy: "BIG_BOY_SWEEP",
    side: sweep.level === "PDH" ? "SELL" : "BUY",
    snapshot: {
      pdh: pd.pdh,
      pdl: pd.pdl,
      c: last5mBar.c,
      h: last5mBar.h,
      l: last5mBar.l,
      sweep_level: sweep.level === "PDH" ? 1 : -1,
    },
    hint: `Liquidity grab at ${sweep.level}`,
  };
}

export function evaluateVwapReclaimReject(
  sessionCandles: Ohlc1m[],
): TriggerHit | undefined {
  if (sessionCandles.length < 25) return undefined;

  const last = sessionCandles[sessionCandles.length - 1]!;
  const prev = sessionCandles[sessionCandles.length - 2]!;
  const vw = vwap(sessionCandles);
  const vz = volumeZScore(sessionCandles, 20);

  const touchTol = 0.0015;
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
    side: reclaim ? "BUY" : "SELL",
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

export function evaluateVwapPullbackTrend(
  sessionCandles: Ohlc1m[],
): TriggerHit | undefined {
  if (sessionCandles.length < 55) return undefined;

  const last = sessionCandles[sessionCandles.length - 1]!;
  const prev = sessionCandles[sessionCandles.length - 2]!;
  const vw = vwap(sessionCandles);
  const e20 = ema(sessionCandles, 20);
  const e50 = ema(sessionCandles, 50);
  if (e20 === undefined || e50 === undefined) return undefined;

  const upTrend = e20 > e50 && last.c > e20 && last.c > vw;
  const downTrend = e20 < e50 && last.c < e20 && last.c < vw;

  const longPullback =
    upTrend &&
    prev.l <= Math.max(vw, e20) * 1.0015 &&
    last.c > prev.c &&
    last.c > e20;

  if (longPullback) {
    return {
      strategy: "VWAP_PULLBACK_TREND",
      side: "BUY",
      snapshot: { vwap: vw, ema20: e20, ema50: e50, last_close: last.c },
      hint: "Uptrend pullback to VWAP/EMA20 held and resumed",
    };
  }

  const shortPullback =
    downTrend &&
    prev.h >= Math.min(vw, e20) * 0.9985 &&
    last.c < prev.c &&
    last.c < e20;

  if (shortPullback) {
    return {
      strategy: "VWAP_PULLBACK_TREND",
      side: "SELL",
      snapshot: { vwap: vw, ema20: e20, ema50: e50, last_close: last.c },
      hint: "Downtrend pullback to VWAP/EMA20 failed and resumed lower",
    };
  }

  return undefined;
}

export function evaluatePrevDayBreakRetest(
  sessionCandles: Ohlc1m[],
  pd: PriorDayRange,
): TriggerHit | undefined {
  if (sessionCandles.length < 40) return undefined;

  const last = sessionCandles[sessionCandles.length - 1]!;
  const prev = sessionCandles[sessionCandles.length - 2]!;

  const completed = sessionCandles.slice(0, -1);
  const brokePdh = recentBreakAbove(
    completed,
    pd.pdh,
    env.retestMaxBarsAfterBreak,
    0.0008,
  );
  const longRetest =
    brokePdh && last.l <= pd.pdh * 1.001 && last.c > pd.pdh && last.c > prev.c;
  if (longRetest) {
    return {
      strategy: "PREV_DAY_HIGH_LOW_BREAK_RETEST",
      side: "BUY",
      snapshot: {
        pdh: pd.pdh,
        pdl: pd.pdl,
        retest_level: pd.pdh,
        last_close: last.c,
      },
      hint: "Prior-day high break and retest hold",
    };
  }

  const brokePdl = recentBreakBelow(
    completed,
    pd.pdl,
    env.retestMaxBarsAfterBreak,
    0.0008,
  );
  const shortRetest =
    brokePdl && last.h >= pd.pdl * 0.999 && last.c < pd.pdl && last.c < prev.c;
  if (shortRetest) {
    return {
      strategy: "PREV_DAY_HIGH_LOW_BREAK_RETEST",
      side: "SELL",
      snapshot: {
        pdh: pd.pdh,
        pdl: pd.pdl,
        retest_level: pd.pdl,
        last_close: last.c,
      },
      hint: "Prior-day low break and retest fail",
    };
  }

  return undefined;
}

export function evaluateEma20BreakRetest(
  sessionCandles: Ohlc1m[],
): TriggerHit | undefined {
  if (sessionCandles.length < 30) return undefined;
  const e20 = ema(sessionCandles, 20);
  if (e20 === undefined) return undefined;

  const last = sessionCandles[sessionCandles.length - 1]!;
  const prev = sessionCandles[sessionCandles.length - 2]!;
  const vz = volumeZScore(sessionCandles, 20);
  const volumeOk = vz === undefined || vz >= env.ema20RetestMinVolumeZ;

  const long =
    volumeOk && prev.c < e20 && last.c > e20 && last.l <= e20 * 1.001;
  if (long) {
    return {
      strategy: "EMA20_BREAK_RETEST",
      side: "BUY",
      snapshot: {
        ema20: e20,
        prev_close: prev.c,
        last_close: last.c,
        volume_z: vz,
      },
      hint: "EMA20 bullish reclaim with retest hold",
    };
  }

  const short =
    volumeOk && prev.c > e20 && last.c < e20 && last.h >= e20 * 0.999;
  if (short) {
    return {
      strategy: "EMA20_BREAK_RETEST",
      side: "SELL",
      snapshot: {
        ema20: e20,
        prev_close: prev.c,
        last_close: last.c,
        volume_z: vz,
      },
      hint: "EMA20 bearish break with retest fail",
    };
  }

  return undefined;
}

export function evaluateVwapReclaimContinuation(
  sessionCandles: Ohlc1m[],
): TriggerHit | undefined {
  if (sessionCandles.length < 35) return undefined;
  const last = sessionCandles[sessionCandles.length - 1]!;
  const last2 = sessionCandles[sessionCandles.length - 2]!;
  const last3 = sessionCandles[sessionCandles.length - 3]!;
  const vw = vwap(sessionCandles);
  const vz = volumeZScore(sessionCandles, 20) ?? 0;

  const crossedUpRecent = last3.c < vw && last2.c > vw;
  const long =
    crossedUpRecent &&
    last2.c > vw &&
    last.c > vw &&
    vz >= env.vwapContinuationMinVolumeZ;
  if (long) {
    return {
      strategy: "VWAP_RECLAIM_CONTINUATION",
      side: "BUY",
      snapshot: { vwap: vw, last_close: last.c, volume_z: vz },
      hint: "VWAP bullish reclaim with continuation closes above VWAP",
    };
  }

  const crossedDownRecent = last3.c > vw && last2.c < vw;
  const short =
    crossedDownRecent &&
    last2.c < vw &&
    last.c < vw &&
    vz >= env.vwapContinuationMinVolumeZ;
  if (short) {
    return {
      strategy: "VWAP_RECLAIM_CONTINUATION",
      side: "SELL",
      snapshot: { vwap: vw, last_close: last.c, volume_z: vz },
      hint: "VWAP bearish reclaim failure with continuation below VWAP",
    };
  }

  return undefined;
}

export function evaluateInitialBalanceBreakRetest(
  sessionCandles: Ohlc1m[],
): TriggerHit | undefined {
  if (sessionCandles.length < 80) return undefined;

  const ibBars = barsInMinuteWindow(sessionCandles, OPEN_MIN, OPEN_MIN + 59);
  const ib = rangeOf(ibBars);
  if (!ib) return undefined;

  const last = sessionCandles[sessionCandles.length - 1]!;
  const prev = sessionCandles[sessionCandles.length - 2]!;
  if (minuteOfBar(last) < OPEN_MIN + 65) return undefined;

  const afterIb = sessionCandles.filter((c) => minuteOfBar(c) > OPEN_MIN + 59);
  const completedAfterIb = afterIb.slice(0, -1);
  const brokeUp = recentBreakAbove(
    completedAfterIb,
    ib.high,
    env.retestMaxBarsAfterBreak,
    0.0008,
  );
  const brokeDown = recentBreakBelow(
    completedAfterIb,
    ib.low,
    env.retestMaxBarsAfterBreak,
    0.0008,
  );

  if (
    brokeUp &&
    last.l <= ib.high * 1.001 &&
    last.c > ib.high &&
    last.c > prev.c
  ) {
    return {
      strategy: "INITIAL_BALANCE_BREAK_RETEST",
      side: "BUY",
      snapshot: {
        ib_high: ib.high,
        ib_low: ib.low,
        retest_level: ib.high,
        last_close: last.c,
      },
      hint: "Initial balance high break and retest hold",
    };
  }

  if (
    brokeDown &&
    last.h >= ib.low * 0.999 &&
    last.c < ib.low &&
    last.c < prev.c
  ) {
    return {
      strategy: "INITIAL_BALANCE_BREAK_RETEST",
      side: "SELL",
      snapshot: {
        ib_high: ib.high,
        ib_low: ib.low,
        retest_level: ib.low,
        last_close: last.c,
      },
      hint: "Initial balance low break and retest fail",
    };
  }

  return undefined;
}

export function evaluateVolatilityContractionBreakout(
  sessionCandles: Ohlc1m[],
): TriggerHit | undefined {
  if (sessionCandles.length < 50) return undefined;

  const prevWindow = sessionCandles.slice(-40, -20);
  const recentWindow = sessionCandles.slice(-20);
  const prevRange = rangeOf(prevWindow);
  const recentRange = rangeOf(recentWindow);
  if (!prevRange || !recentRange) return undefined;

  const prevSpan = prevRange.high - prevRange.low;
  const recentSpan = recentRange.high - recentRange.low;
  if (prevSpan <= 0) return undefined;

  const contracted = recentSpan <= prevSpan * 0.7;
  if (!contracted) return undefined;

  const last = sessionCandles[sessionCandles.length - 1]!;
  const volZ = volumeZScore(sessionCandles, 20) ?? 0;

  if (last.c > recentRange.high && volZ > 0.5) {
    return {
      strategy: "VOLATILITY_CONTRACTION_BREAKOUT",
      side: "BUY",
      snapshot: {
        contraction_ratio: recentSpan / prevSpan,
        breakout_level: recentRange.high,
        volume_z: volZ,
      },
      hint: "Volatility contraction breakout up with participation",
    };
  }

  if (last.c < recentRange.low && volZ > 0.5) {
    return {
      strategy: "VOLATILITY_CONTRACTION_BREAKOUT",
      side: "SELL",
      snapshot: {
        contraction_ratio: recentSpan / prevSpan,
        breakout_level: recentRange.low,
        volume_z: volZ,
      },
      hint: "Volatility contraction breakout down with participation",
    };
  }

  return undefined;
}

export function evaluateInsideBarBreakoutRetest(
  sessionCandles: Ohlc1m[],
): TriggerHit | undefined {
  if (sessionCandles.length < 8) return undefined;

  const mother = sessionCandles[sessionCandles.length - 4]!;
  const inside = sessionCandles[sessionCandles.length - 3]!;
  const breakout = sessionCandles[sessionCandles.length - 2]!;
  const retest = sessionCandles[sessionCandles.length - 1]!;

  const isInside = inside.h < mother.h && inside.l > mother.l;
  if (!isInside) return undefined;

  const long =
    breakout.c > inside.h &&
    retest.l <= inside.h * 1.001 &&
    retest.c > inside.h;
  if (long) {
    return {
      strategy: "INSIDE_BAR_BREAKOUT_WITH_RETEST",
      side: "BUY",
      snapshot: {
        mother_h: mother.h,
        mother_l: mother.l,
        inside_h: inside.h,
        inside_l: inside.l,
      },
      hint: "Inside-bar upside break and retest hold",
    };
  }

  const short =
    breakout.c < inside.l &&
    retest.h >= inside.l * 0.999 &&
    retest.c < inside.l;
  if (short) {
    return {
      strategy: "INSIDE_BAR_BREAKOUT_WITH_RETEST",
      side: "SELL",
      snapshot: {
        mother_h: mother.h,
        mother_l: mother.l,
        inside_h: inside.h,
        inside_l: inside.l,
      },
      hint: "Inside-bar downside break and retest fail",
    };
  }

  return undefined;
}

export function evaluateOpenDrivePullback(
  sessionCandles: Ohlc1m[],
): TriggerHit | undefined {
  if (sessionCandles.length < 40) return undefined;

  const first15 = barsInMinuteWindow(sessionCandles, OPEN_MIN, OPEN_MIN + 14);
  if (first15.length < 10) return undefined;

  const open = first15[0]!.o;
  const first15Close = first15[first15.length - 1]!.c;
  const driveRet = ((first15Close - open) / open) * 100;

  const last = sessionCandles[sessionCandles.length - 1]!;
  if (minuteOfBar(last) < OPEN_MIN + 25) return undefined;

  const e20 = ema(sessionCandles, 20);
  if (e20 === undefined) return undefined;

  const highSinceOpen = Math.max(...sessionCandles.map((c) => c.h));
  const lowSinceOpen = Math.min(...sessionCandles.map((c) => c.l));

  const driveUp = driveRet > 0.45;
  const driveDown = driveRet < -0.45;

  const pullbackFromHighPct = ((highSinceOpen - last.l) / highSinceOpen) * 100;
  const bounce =
    last.c > e20 && last.c > sessionCandles[sessionCandles.length - 2]!.c;

  if (
    driveUp &&
    pullbackFromHighPct >= 0.15 &&
    pullbackFromHighPct <= 1.2 &&
    bounce
  ) {
    return {
      strategy: "OPEN_DRIVE_PULLBACK",
      side: "BUY",
      snapshot: {
        drive_ret_pct: driveRet,
        ema20: e20,
        pullback_pct: pullbackFromHighPct,
      },
      hint: "Open-drive bullish move, controlled pullback, and trend resumption",
    };
  }

  const pullbackFromLowPct = ((last.h - lowSinceOpen) / lowSinceOpen) * 100;
  const rejection =
    last.c < e20 && last.c < sessionCandles[sessionCandles.length - 2]!.c;

  if (
    driveDown &&
    pullbackFromLowPct >= 0.15 &&
    pullbackFromLowPct <= 1.2 &&
    rejection
  ) {
    return {
      strategy: "OPEN_DRIVE_PULLBACK",
      side: "SELL",
      snapshot: {
        drive_ret_pct: driveRet,
        ema20: e20,
        pullback_pct: pullbackFromLowPct,
      },
      hint: "Open-drive bearish move, weak pullback, and trend continuation",
    };
  }

  return undefined;
}

export function evaluateOrbFakeoutReversal(
  sessionCandles: Ohlc1m[],
): TriggerHit | undefined {
  if (sessionCandles.length < 30) return undefined;

  const orbBars = barsInMinuteWindow(sessionCandles, OPEN_MIN, OPEN_MIN + 14);
  const orb = rangeOf(orbBars);
  if (!orb) return undefined;

  const last = sessionCandles[sessionCandles.length - 1]!;
  if (minuteOfBar(last) < OPEN_MIN + 25) return undefined;

  const postOrb = sessionCandles.filter((c) => minuteOfBar(c) > OPEN_MIN + 14);
  const confirmBars = postOrb.slice(
    -Math.max(1, env.orbFakeoutConfirmationBars),
  );
  const confirmedInside =
    confirmBars.length >= env.orbFakeoutConfirmationBars &&
    confirmBars.every((c) => c.c < orb.high && c.c > orb.low);
  const breakLookback = postOrb.slice(
    0,
    -Math.max(1, env.orbFakeoutConfirmationBars),
  );
  const fakeoutUp =
    hasBreakAbove(breakLookback, orb.high, 0.0008) &&
    confirmedInside &&
    last.c < orb.high &&
    last.c > orb.low;
  if (fakeoutUp) {
    return {
      strategy: "ORB_FAKEOUT_REVERSAL",
      side: "SELL",
      snapshot: { orb_high: orb.high, orb_low: orb.low, last_close: last.c },
      hint: "ORB upside fakeout failed back into range (reversal short)",
    };
  }

  const fakeoutDown =
    hasBreakBelow(breakLookback, orb.low, 0.0008) &&
    confirmedInside &&
    last.c > orb.low &&
    last.c < orb.high;
  if (fakeoutDown) {
    return {
      strategy: "ORB_FAKEOUT_REVERSAL",
      side: "BUY",
      snapshot: { orb_high: orb.high, orb_low: orb.low, last_close: last.c },
      hint: "ORB downside fakeout snapped back into range (reversal long)",
    };
  }

  return undefined;
}

/**
 * Nifty-50 **heavyweight** lags on 5-session % while index is strong; enter long
 * on session VWAP reclaim and/or first hold above 15m ORB high while Nifty spot
 * holds from-open gain above session VWAP.
 */
export function evaluateIndexLaggardCatchup(
  ticker: string,
  sessionCandles: Ohlc1m[],
  indexSessionCandles: Ohlc1m[],
  indexPct5d: number,
  tickerPct5d: number,
  isBacktest = false,
): TriggerHit | undefined {
  if (!isNifty50Heavyweight(ticker, { isBacktest })) return undefined;
  if (sessionCandles.length < 25) return undefined;
  if (indexSessionCandles.length < 5) return undefined;

  if (indexPct5d < env.indexLaggardNiftyPct5dMin) return undefined;
  if (tickerPct5d > env.indexLaggardTickerPct5dMax) return undefined;
  if (
    !niftySessionSustainsBullish(
      indexSessionCandles,
      env.indexLaggardNiftySessionMinFromOpenPct
    )
  ) {
    return undefined;
  }

  const last = sessionCandles[sessionCandles.length - 1]!;
  const prev = sessionCandles[sessionCandles.length - 2]!;
  if (minuteOfBar(last) < OPEN_MIN + 16) return undefined;

  const vw = vwap(sessionCandles);
  const vz = volumeZScore(sessionCandles, 20);
  if (vz !== undefined && vz < env.indexLaggardMinVolumeZ) return undefined;

  const orbBars = barsInMinuteWindow(sessionCandles, OPEN_MIN, OPEN_MIN + 14);
  const orb = rangeOf(orbBars);
  if (!orb) return undefined;

  const nFirst = indexSessionCandles[0]!;
  const nLast = indexSessionCandles[indexSessionCandles.length - 1]!;
  const niftyFromOpenPct =
    nFirst.o > 0 ? ((nLast.c - nFirst.o) / nFirst.o) * 100 : 0;

  const vwapBreak = prev.c <= vw && last.c > vw;
  const orbFirstBreak =
    last.c > orb.high &&
    prev.c <= orb.high * (1 + 0.0005) &&
    last.c > vw;

  if (!vwapBreak && !orbFirstBreak) return undefined;

  const triggerCode = vwapBreak && orbFirstBreak ? 3 : vwapBreak ? 1 : 2;
  return {
    strategy: "INDEX_LAGGARD_CATCHUP",
    side: "BUY",
    snapshot: {
      index_pct5d: indexPct5d,
      ticker_pct5d: tickerPct5d,
      vwap: vw,
      orb_15m_high: orb.high,
      nifty_from_open_pct: niftyFromOpenPct,
      last_close: last.c,
      volume_z: vz,
      trigger_mode: triggerCode,
    },
    hint:
      triggerCode === 3
        ? "INDEX_LAGGARD: divergence + Nifty firm; VWAP + 15m high reclaim"
        : triggerCode === 1
          ? "INDEX_LAGGARD: divergence + Nifty firm; session VWAP reclaim"
          : "INDEX_LAGGARD: divergence + Nifty firm; first break above 15m high",
  };
}

/**
 * EMA ribbon trend-pullback.
 * EMA9 > EMA21 = uptrend; EMA9 < EMA21 = downtrend.
 * Entry when price pulls back to touch EMA9 and resumes in trend direction.
 * Fires more frequently than VWAP_PULLBACK_TREND (no EMA50, only 40 bars needed).
 */
export function evaluateEmaRibbonTrend(
  sessionCandles: Ohlc1m[],
): TriggerHit | undefined {
  if (sessionCandles.length < 40) return undefined;

  const e9 = ema(sessionCandles, 9);
  const e21 = ema(sessionCandles, 21);
  if (e9 === undefined || e21 === undefined) return undefined;

  const last = sessionCandles[sessionCandles.length - 1]!;
  const prev = sessionCandles[sessionCandles.length - 2]!;
  const vz = volumeZScore(sessionCandles, 20) ?? 0;

  // Require meaningful separation — avoids choppy flat markets
  const ribbonGap = Math.abs(e9 - e21) / last.c;
  if (ribbonGap < 0.0012) return undefined;

  const upTrend = e9 > e21;
  const downTrend = e9 < e21;

  // Long: previous bar touched/dipped to EMA9 zone, current bar closes above EMA9
  const longSetup =
    upTrend &&
    prev.l <= e9 * 1.002 &&
    last.c > e9 &&
    last.c > prev.c &&
    vz > -0.3;

  if (longSetup) {
    return {
      strategy: "EMA_RIBBON_TREND",
      side: "BUY",
      snapshot: {
        ema9: e9,
        ema21: e21,
        ribbon_gap_pct: ribbonGap * 100,
        volume_z: vz,
        last_close: last.c,
      },
      hint: `EMA9>EMA21 uptrend: pullback to EMA9 held — trend resumption (gap=${(ribbonGap * 100).toFixed(2)}%)`,
    };
  }

  // Short: previous bar touched/spiked to EMA9 zone, current bar closes below EMA9
  const shortSetup =
    downTrend &&
    prev.h >= e9 * 0.998 &&
    last.c < e9 &&
    last.c < prev.c &&
    vz > -0.3;

  if (shortSetup) {
    return {
      strategy: "EMA_RIBBON_TREND",
      side: "SELL",
      snapshot: {
        ema9: e9,
        ema21: e21,
        ribbon_gap_pct: ribbonGap * 100,
        volume_z: vz,
        last_close: last.c,
      },
      hint: `EMA9<EMA21 downtrend: pullback to EMA9 failed — trend continuation (gap=${(ribbonGap * 100).toFixed(2)}%)`,
    };
  }

  return undefined;
}

/**
 * Candle momentum surge — fires on unusually large directional bars with volume.
 * Works in ALL volatility regimes: signal conditions are self-filtering
 * (needs big bar + volume surge + trend alignment, so noise and chop naturally excluded).
 * Bar range > 1.5× ATR(20) + volume z > 0.8 + close in top/bottom 25% + EMA20 alignment.
 */
export function evaluateCandleMomentumSurge(
  sessionCandles: Ohlc1m[],
): TriggerHit | undefined {
  if (sessionCandles.length < 25) return undefined;

  const last = sessionCandles[sessionCandles.length - 1]!;
  const prev = sessionCandles[sessionCandles.length - 2]!;

  // True-range ATR over last 20 bars
  const lookback = sessionCandles.slice(-21);
  let sumTr = 0;
  for (let i = 1; i < lookback.length; i++) {
    const cur = lookback[i]!;
    const prv = lookback[i - 1]!;
    const tr = Math.max(
      cur.h - cur.l,
      Math.abs(cur.h - prv.c),
      Math.abs(cur.l - prv.c),
    );
    sumTr += tr;
  }
  const avgTr = sumTr / (lookback.length - 1);
  if (avgTr <= 0) return undefined;

  const barRange = last.h - last.l;
  if (barRange < avgTr * 1.5) return undefined;

  const vz = volumeZScore(sessionCandles, 20) ?? 0;
  if (vz < 0.8) return undefined;

  const e20 = ema(sessionCandles, 20);
  if (e20 === undefined) return undefined;

  const rsiVal = rsi(14, sessionCandles);
  if (rsiVal === undefined) return undefined;

  // Close position inside the bar (0 = bottom, 1 = top)
  const closePos = barRange > 0 ? (last.c - last.l) / barRange : 0.5;

  // BUY: bar closes in top 25%, above EMA20, not overbought
  if (closePos >= 0.75 && last.c > e20 && last.c > prev.c && rsiVal < 78) {
    return {
      strategy: "CANDLE_MOMENTUM_SURGE",
      side: "BUY",
      snapshot: {
        bar_range_atr_ratio: barRange / avgTr,
        close_pos_in_bar: closePos,
        volume_z: vz,
        ema20: e20,
        rsi: rsiVal,
      },
      hint: `Momentum surge BUY: bar=${(barRange / avgTr).toFixed(1)}x ATR, top close, vol_z=${vz.toFixed(1)}, RSI=${rsiVal.toFixed(0)}`,
    };
  }

  // SELL: bar closes in bottom 25%, below EMA20, not oversold
  if (closePos <= 0.25 && last.c < e20 && last.c < prev.c && rsiVal > 22) {
    return {
      strategy: "CANDLE_MOMENTUM_SURGE",
      side: "SELL",
      snapshot: {
        bar_range_atr_ratio: barRange / avgTr,
        close_pos_in_bar: closePos,
        volume_z: vz,
        ema20: e20,
        rsi: rsiVal,
      },
      hint: `Momentum surge SELL: bar=${(barRange / avgTr).toFixed(1)}x ATR, bottom close, vol_z=${vz.toFixed(1)}, RSI=${rsiVal.toFixed(0)}`,
    };
  }

  return undefined;
}

/**
 * Trend flag breakout — bull/bear flag pattern.
 * Prior 10 bars: strong directional move (pole). Next 4 bars: tight consolidation (flag).
 * Entry: current bar breaks out of flag range with volume.
 * In HIGH vol the flag condition (< 0.45% range over 4 bars) almost never forms,
 * so the signal self-filters — no external vol-regime gate needed.
 */
export function evaluateTrendFlagBreakout(
  sessionCandles: Ohlc1m[],
): TriggerHit | undefined {
  if (sessionCandles.length < 20) return undefined;

  const last = sessionCandles[sessionCandles.length - 1]!;
  const poleBars = sessionCandles.slice(-15, -5);
  const flagBars = sessionCandles.slice(-5, -1);

  if (poleBars.length < 10 || flagBars.length < 4) return undefined;

  // Pole: net directional move > 0.8%
  const poleStart = poleBars[0]!.c;
  const poleEnd = poleBars[poleBars.length - 1]!.c;
  const poleMovePct = ((poleEnd - poleStart) / poleStart) * 100;
  if (Math.abs(poleMovePct) < 0.8) return undefined;

  // Flag: tight range < 0.45% of price
  const flagRange = rangeOf(flagBars);
  if (!flagRange) return undefined;
  const flagRangePct = ((flagRange.high - flagRange.low) / flagRange.low) * 100;
  if (flagRangePct > 0.45) return undefined;

  // Volume: flag bars quieter than pole bars (consolidation)
  const poleVolAvg = poleBars.reduce((s, b) => s + b.v, 0) / poleBars.length;
  const flagVolAvg = flagBars.reduce((s, b) => s + b.v, 0) / flagBars.length;
  if (poleVolAvg > 0 && flagVolAvg >= poleVolAvg * 0.9) return undefined;

  const vz = volumeZScore(sessionCandles, 20) ?? 0;
  if (vz < 0.5) return undefined;

  // Bull flag breakout
  if (poleMovePct > 0.8 && last.c > flagRange.high) {
    return {
      strategy: "TREND_FLAG_BREAKOUT",
      side: "BUY",
      snapshot: {
        pole_move_pct: poleMovePct,
        flag_range_pct: flagRangePct,
        flag_high: flagRange.high,
        volume_z: vz,
      },
      hint: `Bull flag breakout: pole +${poleMovePct.toFixed(2)}%, flag range ${flagRangePct.toFixed(2)}%, vol_z=${vz.toFixed(1)}`,
    };
  }

  // Bear flag breakdown
  if (poleMovePct < -0.8 && last.c < flagRange.low) {
    return {
      strategy: "TREND_FLAG_BREAKOUT",
      side: "SELL",
      snapshot: {
        pole_move_pct: poleMovePct,
        flag_range_pct: flagRangePct,
        flag_low: flagRange.low,
        volume_z: vz,
      },
      hint: `Bear flag breakdown: pole ${poleMovePct.toFixed(2)}%, flag range ${flagRangePct.toFixed(2)}%, vol_z=${vz.toFixed(1)}`,
    };
  }

  return undefined;
}

/**
 * VWAP reversal confirmation — higher-accuracy version of MEAN_REV_Z.
 * Instead of entering AT the overextension (MEAN_REV_Z), waits for the FIRST
 * confirmation bar showing the reversal has already started. This eliminates most
 * false entries where overextensions simply continue.
 * In LOW vol, z rarely exceeds 2.0 so the signal self-filters — no vol-regime gate needed.
 */
export function evaluateVwapReversalConfirmation(
  sessionCandles: Ohlc1m[],
): TriggerHit | undefined {
  if (sessionCandles.length < 25) return undefined;

  const last = sessionCandles[sessionCandles.length - 1]!;
  const prev = sessionCandles[sessionCandles.length - 2]!;

  // Was the PREVIOUS bar overextended?
  const prevCandles = sessionCandles.slice(0, -1);
  const zPrev = zScoreVsVwap(prevCandles, 20);
  const rPrev = rsi(14, prevCandles);
  if (zPrev === undefined || rPrev === undefined) return undefined;

  // Is the current z-score moving back toward mean (reversal in progress)?
  const zNow = zScoreVsVwap(sessionCandles, 20);
  if (zNow === undefined) return undefined;

  const vw = vwap(sessionCandles);
  const vz = volumeZScore(sessionCandles, 20) ?? 0;

  // SHORT confirmation: prev bar was overextended UP, current bar closes lower
  const shortConfirmed =
    zPrev > 2.0 &&
    rPrev > 65 &&
    last.c < prev.c &&
    zNow < zPrev &&
    last.c > vw * 0.997; // still reasonably above VWAP (not already reversed past it)

  if (shortConfirmed) {
    return {
      strategy: "VWAP_REVERSAL_CONFIRMATION",
      side: "SELL",
      snapshot: {
        z_prev: zPrev,
        z_now: zNow,
        rsi_prev: rPrev,
        vwap: vw,
        volume_z: vz,
      },
      hint: `VWAP reversal SELL: overextension z=${zPrev.toFixed(2)}/RSI=${rPrev.toFixed(0)}, reversal bar confirmed`,
    };
  }

  // LONG confirmation: prev bar was overextended DOWN, current bar closes higher
  const longConfirmed =
    zPrev < -2.0 &&
    rPrev < 35 &&
    last.c > prev.c &&
    zNow > zPrev &&
    last.c < vw * 1.003; // still reasonably below VWAP

  if (longConfirmed) {
    return {
      strategy: "VWAP_REVERSAL_CONFIRMATION",
      side: "BUY",
      snapshot: {
        z_prev: zPrev,
        z_now: zNow,
        rsi_prev: rPrev,
        vwap: vw,
        volume_z: vz,
      },
      hint: `VWAP reversal BUY: overextension z=${zPrev.toFixed(2)}/RSI=${rPrev.toFixed(0)}, reversal bar confirmed`,
    };
  }

  return undefined;
}

/**
 * 5-minute ORB break — uses the tighter 9:15–9:19 opening range instead of the
 * 15-minute range. Fires 30–45 minutes earlier than ORB_15M, with tighter stop
 * levels. Valid only during the morning session (until 11:00).
 * Not vol-gated: the volume and trend conditions are the natural filter.
 */
export function evaluateFiveMinOrbBreak(
  sessionCandles: Ohlc1m[],
): TriggerHit | undefined {
  if (sessionCandles.length < 10) return undefined;

  // Opening range = first 5 bars (9:15–9:19)
  const first5 = barsInMinuteWindow(sessionCandles, OPEN_MIN, OPEN_MIN + 4);
  if (first5.length < 5) return undefined;

  const orb5High = Math.max(...first5.map((c) => c.h));
  const orb5Low = Math.min(...first5.map((c) => c.l));

  const last = sessionCandles[sessionCandles.length - 1]!;
  const prev = sessionCandles[sessionCandles.length - 2]!;
  const nowMin = minuteOfBar(last);

  // Only fire 9:25–11:00 (morning breakout window; past 11:00 this level is stale)
  if (nowMin < OPEN_MIN + 10 || nowMin > 11 * 60) return undefined;

  const vz = volumeZScore(sessionCandles, 20) ?? 0;
  if (vz < 0.5) return undefined;

  const e20 = ema(sessionCandles, 20);
  if (e20 === undefined) return undefined;

  // Upside break: previous close was at/below range high, current breaks above
  if (last.c > orb5High && prev.c <= orb5High * 1.001 && last.c > e20) {
    return {
      strategy: "FIVE_MIN_ORB_BREAK",
      side: "BUY",
      snapshot: {
        orb5_high: orb5High,
        orb5_low: orb5Low,
        volume_z: vz,
        last_close: last.c,
        ema20: e20,
      },
      hint: `5-min ORB BUY break: ${last.c.toFixed(2)} > ${orb5High.toFixed(2)}, vol_z=${vz.toFixed(1)}`,
    };
  }

  // Downside break: previous close was at/above range low, current breaks below
  if (last.c < orb5Low && prev.c >= orb5Low * 0.999 && last.c < e20) {
    return {
      strategy: "FIVE_MIN_ORB_BREAK",
      side: "SELL",
      snapshot: {
        orb5_high: orb5High,
        orb5_low: orb5Low,
        volume_z: vz,
        last_close: last.c,
        ema20: e20,
      },
      hint: `5-min ORB SELL break: ${last.c.toFixed(2)} < ${orb5Low.toFixed(2)}, vol_z=${vz.toFixed(1)}`,
    };
  }

  return undefined;
}

/**
 * Session high / low break — fires when price closes at a NEW session extreme
 * with above-average volume and EMA20 trend alignment.
 * Nothing like this exists in the system. In HIGH vol you get more session H/L
 * extensions, so it works across all regimes (self-amplifying in volatility).
 * Volume requirement (z > 1.0) ensures it's real participation, not thin air.
 */
export function evaluateSessionHighLowBreak(
  sessionCandles: Ohlc1m[],
): TriggerHit | undefined {
  if (sessionCandles.length < 30) return undefined;

  const last = sessionCandles[sessionCandles.length - 1]!;
  const nowMin = minuteOfBar(last);

  // Only after 10:00 so session structure has had time to form
  if (nowMin < 10 * 60) return undefined;

  // Session high/low from all bars EXCEPT the current (avoid lookahead)
  const pastBars = sessionCandles.slice(0, -1);
  const sessionHigh = Math.max(...pastBars.map((c) => c.h));
  const sessionLow = Math.min(...pastBars.map((c) => c.l));

  const e20 = ema(sessionCandles, 20);
  if (e20 === undefined) return undefined;

  const vz = volumeZScore(sessionCandles, 20) ?? 0;
  if (vz < 1.0) return undefined; // Needs meaningful volume participation

  const rsiVal = rsi(14, sessionCandles);
  if (rsiVal === undefined) return undefined;

  // New session HIGH: close breaks above previous session high, trend confirms
  if (last.c > sessionHigh && last.c > e20 && rsiVal < 80) {
    return {
      strategy: "SESSION_HIGH_LOW_BREAK",
      side: "BUY",
      snapshot: {
        session_high: sessionHigh,
        volume_z: vz,
        ema20: e20,
        rsi: rsiVal,
      },
      hint: `New session HIGH: ${last.c.toFixed(2)} > ${sessionHigh.toFixed(2)}, vol_z=${vz.toFixed(1)}, RSI=${rsiVal.toFixed(0)}`,
    };
  }

  // New session LOW: close breaks below previous session low, trend confirms
  if (last.c < sessionLow && last.c < e20 && rsiVal > 20) {
    return {
      strategy: "SESSION_HIGH_LOW_BREAK",
      side: "SELL",
      snapshot: {
        session_low: sessionLow,
        volume_z: vz,
        ema20: e20,
        rsi: rsiVal,
      },
      hint: `New session LOW: ${last.c.toFixed(2)} < ${sessionLow.toFixed(2)}, vol_z=${vz.toFixed(1)}, RSI=${rsiVal.toFixed(0)}`,
    };
  }

  return undefined;
}

/**
 * Engulfing candle with volume — current bar body completely engulfs previous bar
 * body, with volume z > 0.8 and EMA20 trend alignment.
 * Classic price-action reversal/continuation signal. Works in all vol regimes:
 * in HIGH vol you get more engulfing bars naturally. The trend-alignment filter
 * keeps it as continuation, not whipsaw.
 */
export function evaluateEngulfingWithVolume(
  sessionCandles: Ohlc1m[],
): TriggerHit | undefined {
  if (sessionCandles.length < 22) return undefined;

  const last = sessionCandles[sessionCandles.length - 1]!;
  const prev = sessionCandles[sessionCandles.length - 2]!;

  const prevBodyHigh = Math.max(prev.o, prev.c);
  const prevBodyLow = Math.min(prev.o, prev.c);
  const lastBodyHigh = Math.max(last.o, last.c);
  const lastBodyLow = Math.min(last.o, last.c);

  // Require meaningful body sizes (avoids doji engulfing doji)
  const prevBodySize = prevBodyHigh - prevBodyLow;
  const lastBodySize = lastBodyHigh - lastBodyLow;
  if (prevBodySize <= 0 || lastBodySize <= prevBodySize * 0.5) return undefined;

  const e20 = ema(sessionCandles, 20);
  if (e20 === undefined) return undefined;

  const vz = volumeZScore(sessionCandles, 20) ?? 0;
  if (vz < 0.8) return undefined;

  const rsiVal = rsi(14, sessionCandles);
  if (rsiVal === undefined) return undefined;

  // Bullish engulfing: current body covers entire previous body, closes above it
  const bullEngulf =
    last.c > prev.c && // net bullish
    lastBodyLow <= prevBodyLow &&
    lastBodyHigh >= prevBodyHigh;

  if (bullEngulf && last.c > e20 && rsiVal < 75) {
    return {
      strategy: "ENGULFING_WITH_VOLUME",
      side: "BUY",
      snapshot: {
        prev_body_size: prevBodySize,
        last_body_size: lastBodySize,
        engulf_ratio: lastBodySize / prevBodySize,
        volume_z: vz,
        ema20: e20,
        rsi: rsiVal,
      },
      hint: `Bullish engulfing: covers prev bar (${(lastBodySize / prevBodySize).toFixed(1)}x body), vol_z=${vz.toFixed(1)}`,
    };
  }

  // Bearish engulfing: current body covers entire previous body, closes below it
  const bearEngulf =
    last.c < prev.c && // net bearish
    lastBodyHigh >= prevBodyHigh &&
    lastBodyLow <= prevBodyLow;

  if (bearEngulf && last.c < e20 && rsiVal > 25) {
    return {
      strategy: "ENGULFING_WITH_VOLUME",
      side: "SELL",
      snapshot: {
        prev_body_size: prevBodySize,
        last_body_size: lastBodySize,
        engulf_ratio: lastBodySize / prevBodySize,
        volume_z: vz,
        ema20: e20,
        rsi: rsiVal,
      },
      hint: `Bearish engulfing: covers prev bar (${(lastBodySize / prevBodySize).toFixed(1)}x body), vol_z=${vz.toFixed(1)}`,
    };
  }

  return undefined;
}
