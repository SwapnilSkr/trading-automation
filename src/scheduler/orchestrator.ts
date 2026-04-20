import type { BrokerClient } from "../broker/types.js";
import {
  ensureIndexes,
  fetchOhlcRange,
  getSessionWatchlist,
} from "../db/repositories.js";
import { ExecutionEngine } from "../execution/ExecutionEngine.js";
import { fetchTodayNewsContext } from "../services/news.js";
import { syncIntradayHistory, syncOhlcForRange } from "../services/marketSync.js";
import { runDiscoverySync } from "../services/discoveryRun.js";
import { runPreopenPivot } from "../services/preopenPivot.js";
import { fetchNiftyTrendContext } from "../services/niftyTrend.js";
import { env } from "../config/env.js";
import {
  istDateString,
  minutesSinceMidnightIST,
  nowIST,
} from "../time/ist.js";
import { resolveWatchlistTickers } from "../services/watchlist.js";
import { currentRunMode, describeMode, type RunMode } from "./mode.js";

export class TradingOrchestrator {
  private lastMode: RunMode | null = null;
  private engine: ExecutionEngine;
  private nightlyDiscoveryIstDay?: string;
  private nightlyDiscoveryRunning = false;
  private preopenPivotIstDay?: string;
  private lastExecSyncAtMs = 0;
  private execSyncRunning = false;
  private tickerResyncLastAtMs = new Map<string, number>();

  constructor(private broker: BrokerClient) {
    this.engine = new ExecutionEngine(broker);
  }

  async startup(): Promise<void> {
    await ensureIndexes();
    console.log("[Orchestrator] indexes ensured");
    await this.engine.restoreOpenPositionsFromMongo();
  }

  async tick(): Promise<void> {
    const mode = currentRunMode();
    if (mode !== this.lastMode) {
      console.log("[Phase]", describeMode(mode));
      this.lastMode = mode;
    }

    switch (mode) {
      case "INIT": {
        await this.broker.authenticate();
        await this.broker.refreshSessionIfNeeded();
        await fetchTodayNewsContext();
        const n = nowIST();
        const d = istDateString(n);
        const m = minutesSinceMidnightIST(n);
        if (
          env.preopenPivotEnabled &&
          env.tradingTickerSource === "active_watchlist" &&
          m >= 9 * 60 + 10 &&
          this.preopenPivotIstDay !== d
        ) {
          this.preopenPivotIstDay = d;
          try {
            const session = await getSessionWatchlist();
            const candidates = [
              ...new Set([
                ...(session?.tickers ?? []),
                ...env.watchedTickers,
              ]),
            ];
            const r = await runPreopenPivot(this.broker, candidates);
            if (r) {
              console.log("[Orchestrator] preopen pivot", r.tickers.join(","));
            }
          } catch (e) {
            console.error("[Orchestrator] preopen pivot failed", e);
          }
        }
        break;
      }
      case "OBSERVATION": {
        /* VWAP calibration window — no trades */
        break;
      }
      case "EXECUTION": {
        const news = await fetchTodayNewsContext();
        const niftyTrend = await fetchNiftyTrendContext(this.broker);
        const day = nowIST().startOf("day").toJSDate();
        const end = nowIST().toJSDate();
        const watch = await resolveWatchlistTickers();
        await this.maybeSyncExecutionBars(watch, end);
        for (const ticker of watch) {
          let candles = await fetchOhlcRange(ticker, day, end);
          if (candles.length < 30) {
            await this.maybeResyncTickerForExecution(ticker, end);
            candles = await fetchOhlcRange(ticker, day, end);
          }
          const last5m = aggregateLastNMinutes(candles, 5);
          // Check exits first (stop-loss / profit-target / trailing stop)
          await this.engine.checkLiveExits(ticker, candles);
          await this.engine.runScanningPass({
            ticker,
            sessionCandles: candles,
            last5m,
            niftyTrendHint: niftyTrend,
            newsHeadlines: news,
          });
        }
        try {
          const positions = await this.broker.listOpenPositions();
          this.engine.setOpenCount(positions.length);
        } catch (e) {
          console.error(
            "[Orchestrator] listOpenPositions failed (continuing with previous open count)",
            e
          );
        }
        break;
      }
      case "SQUARE_OFF": {
        const watch = await resolveWatchlistTickers();
        const day = nowIST().startOf("day").toJSDate();
        const end = nowIST().toJSDate();
        for (const ticker of watch) {
          const candles = await fetchOhlcRange(ticker, day, end);
          const last = candles[candles.length - 1];
          if (last) {
            await this.engine.forceSquareOffTrackedPosition(
              ticker,
              last.c,
              end
            );
            await this.engine.forceSquareOffPersistedPositionForTicker(
              ticker,
              last.c,
              end
            );
          }
          await this.broker.closeIntraday(ticker);
        }
        this.engine.setOpenCount(0);
        break;
      }
      case "SYNC": {
        await syncIntradayHistory(this.broker);
        break;
      }
      case "POST_MORTEM": {
        const n2 = nowIST();
        const d2 = istDateString(n2);
        const m2 = minutesSinceMidnightIST(n2);
        if (
          env.nightlyDiscoveryEnabled &&
          m2 >= 18 * 60 &&
          m2 < 21 * 60 &&
          this.nightlyDiscoveryIstDay !== d2 &&
          !this.nightlyDiscoveryRunning
        ) {
          this.nightlyDiscoveryIstDay = d2;
          this.nightlyDiscoveryRunning = true;
          console.log("[Orchestrator] nightly discovery-sync starting");
          void runDiscoverySync(this.broker, {
            days: 5,
            top: 10,
            refreshUniverseCsv: false,
            skipOhlcSync: false,
            dryRun: false,
            asOfDate: d2,
            updateCurrentSession: true,
            writeSnapshot: true,
            snapshotSource: "nightly_discovery",
          })
            .then((res) => {
              console.log(
                "[Orchestrator] nightly discovery done",
                res.effectiveFor,
                res.performers.map((p) => p.ticker).join(",")
              );
            })
            .catch((e) =>
              console.error("[Orchestrator] nightly discovery failed", e)
            )
            .finally(() => {
              this.nightlyDiscoveryRunning = false;
            });
        }
        break;
      }
      default:
        break;
    }
  }

  private async maybeSyncExecutionBars(
    tickers: string[],
    end: Date
  ): Promise<void> {
    if (!env.liveExecSyncEnabled) return;
    if (tickers.length === 0) return;
    if (this.execSyncRunning) return;

    const intervalMs = Math.max(1, env.liveExecSyncIntervalMinutes) * 60_000;
    if (Date.now() - this.lastExecSyncAtMs < intervalMs) return;

    this.execSyncRunning = true;
    try {
      const lookbackMins = Math.max(30, env.liveExecSyncLookbackMinutes);
      const from = nowIST()
        .minus({ minutes: lookbackMins })
        .startOf("minute")
        .toJSDate();
      const results = await syncOhlcForRange(this.broker, from, end, tickers);
      const tickersWithBars = results.filter((r) => r.bars > 0).length;
      const totalBars = results.reduce((s, r) => s + r.bars, 0);
      console.log(
        `[Orchestrator] exec auto-sync: ${tickersWithBars}/${results.length} tickers, bars=${totalBars}`
      );
    } catch (e) {
      console.error("[Orchestrator] exec auto-sync failed", e);
    } finally {
      this.lastExecSyncAtMs = Date.now();
      this.execSyncRunning = false;
    }
  }

  private async maybeResyncTickerForExecution(
    ticker: string,
    end: Date
  ): Promise<void> {
    if (!env.liveExecSyncEnabled) return;

    const cooldownMs =
      Math.max(1, env.liveExecTickerResyncCooldownMinutes) * 60_000;
    const lastAt = this.tickerResyncLastAtMs.get(ticker) ?? 0;
    if (Date.now() - lastAt < cooldownMs) return;
    this.tickerResyncLastAtMs.set(ticker, Date.now());

    const lookbackMins = Math.max(30, env.liveExecSyncLookbackMinutes);
    const from = nowIST()
      .minus({ minutes: lookbackMins })
      .startOf("minute")
      .toJSDate();
    try {
      const [r] = await syncOhlcForRange(this.broker, from, end, [ticker]);
      console.log(
        `[Orchestrator] ticker resync ${ticker}: ${r?.bars ?? 0} bars`
      );
    } catch (e) {
      console.error(`[Orchestrator] ticker resync failed ${ticker}`, e);
    }
  }
}

function aggregateLastNMinutes(
  candles: Awaited<ReturnType<typeof fetchOhlcRange>>,
  n: number
): (typeof candles)[0] | undefined {
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
