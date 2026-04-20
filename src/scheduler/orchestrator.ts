import type { BrokerClient } from "../broker/types.js";
import {
  ensureIndexes,
  fetchOhlcRange,
  getSessionWatchlist,
} from "../db/repositories.js";
import { ExecutionEngine } from "../execution/ExecutionEngine.js";
import { fetchTodayNewsContext } from "../services/news.js";
import { syncIntradayHistory } from "../services/marketSync.js";
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

  constructor(private broker: BrokerClient) {
    this.engine = new ExecutionEngine(broker);
  }

  async startup(): Promise<void> {
    await ensureIndexes();
    console.log("[Orchestrator] indexes ensured");
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
        for (const ticker of watch) {
          const candles = await fetchOhlcRange(ticker, day, end);
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
        const positions = await this.broker.listOpenPositions();
        this.engine.setOpenCount(positions.length);
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
