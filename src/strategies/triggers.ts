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

  const overextended =
    z > 2.5 && (rsiBearishDivergence(sessionCandles) || r > 70);
  const oversold = z < -2.5 && (rsiBullishDivergence(sessionCandles) || r < 30);

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
      ? "Overextended vs VWAP (mean reversion short bias)"
      : "Oversold vs VWAP (mean reversion long bias)",
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
    pullbackFromHighPct >= 0.2 &&
    pullbackFromHighPct <= 0.9 &&
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
    pullbackFromLowPct >= 0.2 &&
    pullbackFromLowPct <= 0.9 &&
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
