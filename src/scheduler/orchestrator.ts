import type { BrokerClient } from "../broker/types.js";
import { ensureIndexes } from "../db/repositories.js";
import { ExecutionEngine } from "../execution/ExecutionEngine.js";
import { fetchTodayNewsContext } from "../services/news.js";
import { syncIntradayHistory } from "../services/marketSync.js";
import { fetchOhlcRange } from "../db/repositories.js";
import { env } from "../config/env.js";
import { nowIST } from "../time/ist.js";
import { currentRunMode, describeMode, type RunMode } from "./mode.js";

export class TradingOrchestrator {
  private lastMode: RunMode | null = null;
  private engine: ExecutionEngine;

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
        break;
      }
      case "OBSERVATION": {
        /* VWAP calibration window — no trades */
        break;
      }
      case "EXECUTION": {
        const news = await fetchTodayNewsContext();
        const day = nowIST().startOf("day").toJSDate();
        const end = nowIST().toJSDate();
        for (const ticker of env.watchedTickers) {
          const candles = await fetchOhlcRange(ticker, day, end);
          const last5m = aggregateLastNMinutes(candles, 5);
          await this.engine.runScanningPass({
            ticker,
            sessionCandles: candles,
            last5m,
            niftyTrendHint: "stub: wire NIFTY trend",
            newsHeadlines: news,
          });
        }
        const positions = await this.broker.listOpenPositions();
        this.engine.setOpenCount(positions.length);
        break;
      }
      case "SQUARE_OFF": {
        for (const ticker of env.watchedTickers) {
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
        /* Heavy analysis runs in analyst.js (PM2 cron). */
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
