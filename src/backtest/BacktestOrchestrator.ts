import { DateTime } from "luxon";
import { env } from "../config/env.js";
import { createBroker } from "../broker/factory.js";
import { AngelOneStubBroker } from "../broker/angelOneStub.js";
import {
  ExecutionEngine,
  type BacktestPassOptions,
} from "../execution/ExecutionEngine.js";
import {
  fetchOhlcRange,
  getWatchlistSnapshotForEffectiveDate,
} from "../db/repositories.js";
import { getHeadlinesForBacktest } from "../services/historicalNewsFeed.js";
import type { Ohlc1m, StrategyId, TradeLogDoc } from "../types/domain.js";
import { IST, isIndianWeekday } from "../time/ist.js";
import {
  type SimPosition,
  type ExitParams,
  processBarForExits,
  closeAllAtEod,
} from "../execution/exitSimulator.js";

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
  /**
   * `static` — use `tickers` every session.
   * `snapshots` — for each IST session day, load `watchlist_snapshots.effective_date`;
   *   if missing, use `tickers` as fallback.
   */
  watchlistMode?: "static" | "snapshots";
}

export interface BacktestSummary {
  runId: string;
  sessions: number;
  steps: number;
  scanCalls: number;
  /** Only populated when persistTrades=true and exit simulation runs */
  tradesEntered: number;
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
 * Replay Mongo `ohlc_1m` bar-by-bar through the execution engine with a
 * simulated IST clock. Includes stop-loss / profit-target exit simulation
 * so `trades_backtest` contains complete entry + exit + PnL records.
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

  const exitParams: ExitParams = {
    stopPct: env.exitStopPct,
    targetPct: env.exitTargetPct,
    trailTriggerPct: env.exitTrailTriggerPct,
    trailDistPct: env.exitTrailDistPct,
    qty: env.backtestPositionQty,
  };

  const summary: BacktestSummary = {
    runId,
    sessions: 0,
    steps: 0,
    scanCalls: 0,
    tradesEntered: 0,
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

    const dayKey = d.toFormat("yyyy-MM-dd");
    let dayTickers = config.tickers;
    if (config.watchlistMode === "snapshots") {
      const snap = await getWatchlistSnapshotForEffectiveDate(dayKey);
      if (snap?.tickers?.length) {
        dayTickers = snap.tickers;
        console.log(`[Backtest] ${dayKey} watchlist from snapshot (${dayTickers.length} names)`);
      } else {
        console.warn(`[Backtest] ${dayKey} no watchlist_snapshots — fallback static list`);
      }
    }

    for (const ticker of dayTickers) {
      const broker = config.skipOrders ? new AngelOneStubBroker() : createBroker();
      const engine = new ExecutionEngine(broker);
      const dayBars = await fetchOhlcRange(ticker, dayStart, dayEnd);
      if (dayBars.length < 40) {
        console.warn(`[Backtest] skip ${ticker} ${d.toISODate()}: only ${dayBars.length} bars`);
        continue;
      }

      const sessionStart = d.set({ hour: 9, minute: 15 }).toJSDate();
      const sessionEnd = d.set({ hour: 15, minute: 29 }).toJSDate();
      const sessionBars = dayBars.filter(
        (b) => b.ts >= sessionStart && b.ts <= sessionEnd
      );
      if (sessionBars.length === 0) continue;

      // Open positions for this ticker+day
      let openPositions: SimPosition[] = [];
      let lastScanMs = sessionStart.getTime() - 1; // force first scan

      for (let bi = 0; bi < sessionBars.length; bi++) {
        const bar = sessionBars[bi]!;

        // 1. Check exits for open positions on this bar
        if (openPositions.length > 0) {
          openPositions = await processBarForExits(
            openPositions,
            bar,
            exitParams,
            config.persistTrades
          );
        }

        // 2. Decide whether to run a scan at this bar
        const elapsedMin = (bar.ts.getTime() - lastScanMs) / 60_000;
        const haveCapacity = openPositions.length < env.maxConcurrentTrades;
        if (elapsedMin < config.stepMinutes || !haveCapacity) continue;

        summary.steps += 1;
        lastScanMs = bar.ts.getTime();

        const sessionCandles = sessionBars.slice(0, bi + 1);
        if (sessionCandles.length < 30) continue;

        const last5m = aggregateLastNMinutes(sessionCandles, 5);
        const newsHeadlines = await getHeadlinesForBacktest(bar.ts);

        // Capture newly entered trades so we can simulate exits
        const newEntries: { doc: TradeLogDoc; entryPrice: number; side: "BUY" | "SELL" }[] = [];

        const bt: BacktestPassOptions = {
          simulatedAt: bar.ts,
          judgeModel: config.judgeModel ?? env.judgeModelBacktest,
          skipOrders: config.skipOrders,
          persistBacktest: false, // we handle persistence below
          runId,
          skipJudge: config.skipJudge,
          onTradeEntry: async (doc, entryPrice, side) => {
            newEntries.push({ doc, entryPrice, side });
          },
        };

        await engine.runScanningPass(
          {
            ticker,
            sessionCandles,
            last5m,
            niftyTrendHint: `Replay IST ${d.toFormat("yyyy-MM-dd")} ${DateTime.fromJSDate(bar.ts, { zone: IST }).toFormat("HH:mm")}`,
            newsHeadlines,
          },
          bt
        );
        summary.scanCalls += 1;

        // Register new positions for exit tracking
        for (const { doc, entryPrice, side } of newEntries) {
          openPositions.push({
            ticker,
            entryPrice,
            side,
            strategy: doc.strategy as StrategyId,
            entryTime: bar.ts,
            peakPrice: entryPrice,
            doc,
          });
          summary.tradesEntered += 1;
        }
      }

      // 3. EOD: force-close everything at last bar's close
      const lastBar = sessionBars[sessionBars.length - 1]!;
      if (openPositions.length > 0) {
        await closeAllAtEod(openPositions, lastBar, exitParams, config.persistTrades);
      }
    }

    d = d.plus({ days: 1 });
  }

  return summary;
}
