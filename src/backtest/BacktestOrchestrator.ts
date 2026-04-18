import { DateTime } from "luxon";
import { env } from "../config/env.js";
import { createBroker } from "../broker/factory.js";
import { AngelOneStubBroker } from "../broker/angelOneStub.js";
import {
  ExecutionEngine,
  type BacktestPassOptions,
} from "../execution/ExecutionEngine.js";
import { fetchOhlcRange } from "../db/repositories.js";
import { getHeadlinesForBacktest } from "../services/historicalNewsFeed.js";
import type { Ohlc1m } from "../types/domain.js";
import { IST, isIndianWeekday } from "../time/ist.js";

export interface BacktestConfig {
  from: string;
  to: string;
  tickers: string[];
  stepMinutes: number;
  judgeModel?: string;
  skipJudge: boolean;
  /** When true, never calls broker (recommended for replay) */
  skipOrders: boolean;
  persistTrades: boolean;
}

export interface BacktestSummary {
  runId: string;
  sessions: number;
  steps: number;
  scanCalls: number;
}

function* sessionTimeSteps(
  day: DateTime,
  stepMinutes: number
): Generator<DateTime> {
  let t = day.set({ hour: 9, minute: 15, second: 0, millisecond: 0 });
  const end = day.set({ hour: 15, minute: 29, second: 0, millisecond: 0 });
  while (t <= end) {
    yield t;
    t = t.plus({ minutes: stepMinutes });
  }
}

function aggregateLastNMinutes(candles: Ohlc1m[], n: number): Ohlc1m | undefined {
  if (candles.length === 0) return undefined;
  const slice = candles.slice(-n);
  const first = slice[0]!;
  const last = slice[slice.length - 1]!;
  return {
    ticker: last.ticker,
    ts: last.ts,
    o: first.o,
    h: Math.max(...slice.map((c) => c.h)),
    l: Math.min(...slice.map((c) => c.l)),
    c: last.c,
    v: slice.reduce((s, c) => s + c.v, 0),
  };
}

/**
 * Replay Mongo `ohlc_1m` through the execution engine with a simulated clock
 * (no dependency on `currentRunMode()` / live IST).
 */
export async function runBacktestReplay(
  config: BacktestConfig
): Promise<BacktestSummary> {
  const runId = `bt-${Date.now()}`;
  const start = DateTime.fromISO(config.from, { zone: IST }).startOf("day");
  const end = DateTime.fromISO(config.to, { zone: IST }).endOf("day");
  if (!start.isValid || !end.isValid) {
    throw new Error(`Invalid --from / --to (use YYYY-MM-DD, IST): ${config.from} ${config.to}`);
  }

  const summary: BacktestSummary = {
    runId,
    sessions: 0,
    steps: 0,
    scanCalls: 0,
  };

  let d = start;
  while (d <= end) {
    if (!isIndianWeekday(d)) {
      d = d.plus({ days: 1 });
      continue;
    }

    summary.sessions += 1;
    const dayStart = d.startOf("day").toJSDate();
    const dayEnd = d.endOf("day").toJSDate();

    for (const ticker of config.tickers) {
      const broker = config.skipOrders
        ? new AngelOneStubBroker()
        : createBroker();
      const engine = new ExecutionEngine(broker);
      const dayBars = await fetchOhlcRange(ticker, dayStart, dayEnd);
      if (dayBars.length < 40) {
        console.warn(
          `[Backtest] skip ${ticker} ${d.toISODate()}: only ${dayBars.length} bars (need history in Mongo)`
        );
        continue;
      }

      const sessionStart = d.set({ hour: 9, minute: 15 }).toJSDate();

      for (const simDt of sessionTimeSteps(d, config.stepMinutes)) {
        const sim = simDt.toJSDate();
        const sessionCandles = dayBars.filter(
          (b) => b.ts >= sessionStart && b.ts <= sim
        );
        if (sessionCandles.length < 30) continue;

        summary.steps += 1;
        const last5m = aggregateLastNMinutes(sessionCandles, 5);
        const newsHeadlines = await getHeadlinesForBacktest(sim);

        const bt: BacktestPassOptions = {
          simulatedAt: sim,
          judgeModel: config.judgeModel ?? env.judgeModelBacktest,
          skipOrders: config.skipOrders,
          persistBacktest: config.persistTrades,
          runId,
          skipJudge: config.skipJudge,
        };

        await engine.runScanningPass(
          {
            ticker,
            sessionCandles,
            last5m,
            niftyTrendHint: `Replay IST ${d.toFormat("yyyy-MM-dd")} ${simDt.toFormat("HH:mm")}`,
            newsHeadlines,
          },
          bt
        );
        summary.scanCalls += 1;
      }
    }

    d = d.plus({ days: 1 });
  }

  return summary;
}
