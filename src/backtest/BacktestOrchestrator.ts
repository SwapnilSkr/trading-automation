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
import {
  applyExecutionFill,
  getBacktestRealismConfig,
} from "./microstructure.js";
import { buildMarketRegimeSnapshot } from "../risk/marketRegime.js";

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

interface TimelineBar {
  ticker: string;
  bar: Ohlc1m;
  index: number;
}

interface PendingEntry {
  ticker: string;
  activateAtMs: number;
  signalPrice: number;
  side: "BUY" | "SELL";
  qty: number;
  atrAtEntry?: number;
  doc: TradeLogDoc;
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
    pessimisticIntrabar: env.backtestPessimisticIntrabar,
    realism: getBacktestRealismConfig(),
  };

  const summary: BacktestSummary = {
    runId,
    sessions: 0,
    steps: 0,
    scanCalls: 0,
    tradesEntered: 0,
  };

  const broker = config.skipOrders ? new AngelOneStubBroker() : createBroker();
  const engine = new ExecutionEngine(broker);

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
    const marketSnapshotCache = new Map<number, BacktestPassOptions["marketSnapshot"]>();
    const newsCache = new Map<number, string[]>();
    const sessionStart = d.set({ hour: 9, minute: 15 }).toJSDate();
    const sessionEnd = d.set({ hour: 15, minute: 29 }).toJSDate();

    const barsByTicker = new Map<string, Ohlc1m[]>();
    for (const ticker of dayTickers) {
      const dayBars = await fetchOhlcRange(ticker, dayStart, dayEnd);
      if (dayBars.length < 40) {
        console.warn(
          `[Backtest] skip ${ticker} ${d.toISODate()}: only ${dayBars.length} bars`
        );
        continue;
      }
      const sessionBars = dayBars.filter(
        (b) => b.ts >= sessionStart && b.ts <= sessionEnd
      );
      if (sessionBars.length > 0) barsByTicker.set(ticker, sessionBars);
    }
    if (barsByTicker.size === 0) {
      d = d.plus({ days: 1 });
      continue;
    }

    const timeline = new Map<number, TimelineBar[]>();
    for (const [ticker, bars] of barsByTicker) {
      bars.forEach((bar, index) => {
        const ts = bar.ts.getTime();
        const row = timeline.get(ts) ?? [];
        row.push({ ticker, bar, index });
        timeline.set(ts, row);
      });
    }
    const timelineMs = [...timeline.keys()].sort((a, b) => a - b);

    let openPositions: SimPosition[] = [];
    const pendingEntries: PendingEntry[] = [];
    const lastScanByTicker = new Map<string, number>();
    const latestBarsByTicker = new Map<string, Ohlc1m>();
    const candlesByTicker = new Map<string, Ohlc1m[]>();

    for (const [ticker] of barsByTicker) {
      lastScanByTicker.set(ticker, sessionStart.getTime() - 1);
      candlesByTicker.set(ticker, []);
    }

    for (const tsMs of timelineMs) {
      const rows = timeline.get(tsMs) ?? [];
      for (const r of rows) {
        latestBarsByTicker.set(r.ticker, r.bar);
        const arr = candlesByTicker.get(r.ticker) ?? [];
        arr.push(r.bar);
        candlesByTicker.set(r.ticker, arr);
      }

      if (pendingEntries.length > 0) {
        const remainingPending: PendingEntry[] = [];
        for (const p of pendingEntries) {
          const activeRow = rows.find(
            (r) => r.ticker === p.ticker && tsMs >= p.activateAtMs
          );
          if (!activeRow) {
            remainingPending.push(p);
            continue;
          }
          if (openPositions.length >= env.maxConcurrentTrades) continue;
          const ref =
            exitParams.realism.entryLatencyBars > 0
              ? activeRow.bar.o
              : p.signalPrice;
          const fill = applyExecutionFill(
            ref,
            p.side,
            activeRow.bar,
            p.qty,
            exitParams.realism
          );
          p.doc.entry_time = activeRow.bar.ts;
          p.doc.entry_price = fill.fillPrice;
          openPositions.push({
            ticker: p.ticker,
            entryPrice: fill.fillPrice,
            qty: p.qty,
            remainingQty: p.qty,
            realizedPnl: 0,
            partialExits: [],
            completedPartialReasons: [],
            entryReferencePrice: ref,
            entrySlippageRupees: fill.slippageRupees,
            side: p.side,
            strategy: p.doc.strategy as StrategyId,
            entryTime: activeRow.bar.ts,
            peakPrice: fill.fillPrice,
            atrAtEntry: p.atrAtEntry,
            doc: p.doc,
          });
          summary.tradesEntered += 1;
        }
        pendingEntries.length = 0;
        pendingEntries.push(...remainingPending);
      }

      for (const r of rows) {
        const sameTicker = openPositions.filter((p) => p.ticker === r.ticker);
        if (sameTicker.length === 0) continue;
        const stillOpen = await processBarForExits(
          sameTicker,
          r.bar,
          exitParams,
          config.persistTrades
        );
        openPositions = openPositions.filter((p) => p.ticker !== r.ticker);
        openPositions.push(...stillOpen);
      }

      for (const r of rows) {
        const lastScan = lastScanByTicker.get(r.ticker) ?? sessionStart.getTime() - 1;
        const elapsedMin = (tsMs - lastScan) / 60_000;
        const haveCapacity =
          openPositions.length + pendingEntries.length < env.maxConcurrentTrades;
        if (elapsedMin < config.stepMinutes || !haveCapacity) continue;

        lastScanByTicker.set(r.ticker, tsMs);
        summary.steps += 1;

        const sessionCandles = candlesByTicker.get(r.ticker) ?? [];
        if (sessionCandles.length < 30) continue;

        const last5m = aggregateLastNMinutes(sessionCandles, 5);
        let newsHeadlines = newsCache.get(tsMs);
        if (!newsHeadlines) {
          newsHeadlines = await getHeadlinesForBacktest(r.bar.ts);
          newsCache.set(tsMs, newsHeadlines);
        }

        let marketSnapshot = marketSnapshotCache.get(tsMs);
        if (env.marketGateEnabled && !marketSnapshot) {
          marketSnapshot = await buildMarketRegimeSnapshot(
            [...barsByTicker.keys()],
            r.bar.ts
          );
          marketSnapshotCache.set(tsMs, marketSnapshot);
        }

        const newEntries: Array<{
          doc: TradeLogDoc;
          entryPrice: number;
          side: "BUY" | "SELL";
          qty: number;
          atrAtEntry?: number;
        }> = [];

        const bt: BacktestPassOptions = {
          simulatedAt: r.bar.ts,
          judgeModel: config.judgeModel ?? env.judgeModelBacktest,
          skipOrders: config.skipOrders,
          persistBacktest: false,
          runId,
          skipJudge: config.skipJudge,
          marketSnapshot,
          portfolioPositions: openPositions.map((p) => ({
            ticker: p.ticker,
            side: p.side,
            entryPrice: p.entryPrice,
            qty: p.remainingQty,
          })),
          onTradeEntry: async (doc, entryPrice, side) => {
            newEntries.push({
              doc,
              entryPrice,
              side,
              qty: doc.qty ?? env.backtestPositionQty,
              atrAtEntry: doc.atr_at_entry,
            });
          },
        };

        await engine.runScanningPass(
          {
            ticker: r.ticker,
            sessionCandles,
            last5m,
            niftyTrendHint: `Replay IST ${d.toFormat("yyyy-MM-dd")} ${DateTime.fromJSDate(r.bar.ts, { zone: IST }).toFormat("HH:mm")}`,
            newsHeadlines,
            marketSnapshot,
          },
          bt
        );
        summary.scanCalls += 1;

        for (const ne of newEntries) {
          const bars = barsByTicker.get(r.ticker);
          if (!bars) continue;
          const activationIdx = Math.min(
            bars.length - 1,
            r.index + Math.max(0, exitParams.realism.entryLatencyBars)
          );
          const activationBar = bars[activationIdx];
          if (!activationBar) continue;
          pendingEntries.push({
            ticker: r.ticker,
            activateAtMs: activationBar.ts.getTime(),
            signalPrice: ne.entryPrice,
            side: ne.side,
            qty: ne.qty,
            atrAtEntry: ne.atrAtEntry,
            doc: ne.doc,
          });
        }
      }
    }

    if (openPositions.length > 0) {
      for (const [ticker, lastBar] of latestBarsByTicker) {
        const sameTicker = openPositions.filter((p) => p.ticker === ticker);
        if (sameTicker.length === 0) continue;
        await closeAllAtEod(sameTicker, lastBar, exitParams, config.persistTrades);
        openPositions = openPositions.filter((p) => p.ticker !== ticker);
      }
    }

    d = d.plus({ days: 1 });
  }

  return summary;
}
