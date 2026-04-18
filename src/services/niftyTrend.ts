import { fetchOhlcRange } from "../db/repositories.js";
import type { BrokerClient } from "../broker/types.js";
import { env } from "../config/env.js";
import { nowIST } from "../time/ist.js";
import type { Ohlc1m } from "../types/domain.js";

/** Simple exponential moving average on close prices */
function ema(candles: Ohlc1m[], period: number): number | undefined {
  if (candles.length < period) return undefined;
  const k = 2 / (period + 1);
  let val = candles.slice(0, period).reduce((s, c) => s + c.c, 0) / period;
  for (let i = period; i < candles.length; i++) {
    val = candles[i]!.c * k + val * (1 - k);
  }
  return val;
}

function vwap(candles: Ohlc1m[]): number | undefined {
  if (candles.length === 0) return undefined;
  let sumPV = 0;
  let sumV = 0;
  for (const c of candles) {
    const tp = (c.h + c.l + c.c) / 3;
    sumPV += tp * c.v;
    sumV += c.v;
  }
  return sumV === 0 ? undefined : sumPV / sumV;
}

/**
 * Returns a human-readable NIFTY50 trend string for the judge prompt.
 * Falls back to "NIFTY50 data unavailable" if no 1m bars exist in Mongo.
 *
 * Does NOT call the broker — reads only from Mongo so it works offline
 * and doesn't consume rate-limit budget during the live scan loop.
 */
export async function fetchNiftyTrendContext(
  _broker?: BrokerClient
): Promise<string> {
  const ticker = env.niftySymbol;
  const now = nowIST();
  const dayStart = now.startOf("day").toJSDate();
  const dayEnd = now.toJSDate();

  try {
    const bars = await fetchOhlcRange(ticker, dayStart, dayEnd);
    if (bars.length < 20) {
      return `${ticker} data insufficient (${bars.length} bars) — treating as neutral`;
    }

    const last = bars[bars.length - 1]!;
    const open = bars[0]!.o;
    const changePct = ((last.c - open) / open) * 100;
    const vwapVal = vwap(bars);
    const ema20 = ema(bars, 20);
    const ema50 = ema(bars, Math.min(50, bars.length));

    const trendDir =
      ema20 !== undefined && ema50 !== undefined
        ? ema20 > ema50
          ? "bullish"
          : "bearish"
        : changePct >= 0
        ? "up"
        : "down";

    const vwapPos =
      vwapVal !== undefined
        ? last.c > vwapVal
          ? `above VWAP (${vwapVal.toFixed(0)})`
          : `below VWAP (${vwapVal.toFixed(0)})`
        : "VWAP unavailable";

    const sign = changePct >= 0 ? "+" : "";
    return `${ticker} ${trendDir} trend, ${sign}${changePct.toFixed(2)}% from open, ${vwapPos}`;
  } catch (e) {
    return `${ticker} trend fetch failed: ${String(e).slice(0, 60)}`;
  }
}
