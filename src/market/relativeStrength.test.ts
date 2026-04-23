import { describe, expect, test } from "bun:test";
import {
  pct5dFromIntradayHistory,
  niftySessionSustainsBullish,
} from "./relativeStrength.js";
import type { Ohlc1m } from "../types/domain.js";

function bar(
  day: string,
  h: number,
  m: number,
  c: number,
  v = 1e6
): Ohlc1m {
  return {
    ticker: "X",
    ts: new Date(`${day}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+05:30`),
    o: c,
    h: c,
    l: c,
    c,
    v,
  };
}

describe("pct5dFromIntradayHistory", () => {
  test("matches 6-session window (close to close over 5 steps)", () => {
    const days = [
      "2026-04-15",
      "2026-04-16",
      "2026-04-17",
      "2026-04-18",
      "2026-04-21",
      "2026-04-22",
    ];
    const closes = [100, 102, 104, 103, 105, 110];
    const ohlc: Ohlc1m[] = days.map((d, i) => bar(d, 9, 15, closes[i]!));
    const pct = pct5dFromIntradayHistory(ohlc);
    expect(pct).toBeDefined();
    expect(pct).toBeCloseTo(((110 - 100) / 100) * 100, 5);
  });
});

describe("niftySessionSustainsBullish", () => {
  test("true when from-open gain and last above VWAP", () => {
    const o = 20000;
    const t0 = new Date("2026-04-22T09:20:00+05:30");
    const t1 = new Date("2026-04-22T09:21:00+05:30");
    const t2 = new Date("2026-04-22T09:22:00+05:30");
    const mid = o * 1.003;
    const candles: Ohlc1m[] = [
      { ticker: "NIFTY50", ts: t0, o, h: o * 1.001, l: o * 0.999, c: o, v: 0 },
      { ticker: "NIFTY50", ts: t1, o, h: mid * 1.001, l: mid * 0.999, c: mid, v: 0 },
      {
        ticker: "NIFTY50",
        ts: t2,
        o: mid,
        h: o * 1.01,
        l: o,
        c: o * 1.006,
        v: 0,
      },
    ];
    expect(niftySessionSustainsBullish(candles, 0.01)).toBe(true);
  });
});
