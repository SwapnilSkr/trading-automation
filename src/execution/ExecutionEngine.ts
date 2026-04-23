import { env } from "../config/env.js";
import type { BrokerClient } from "../broker/types.js";
import type { Ohlc1m, StrategyId, TechnicalSnapshot, TradeLogDoc } from "../types/domain.js";
import {
  callJudgeModel,
  type JudgeInput,
  type JudgeResult,
} from "../ai/judge.js";
import { embedCandlePattern } from "../embeddings/patternEmbedding.js";
import {
  querySimilarPatterns,
  type SimilarPattern,
  scoreFromNeighbors,
} from "../pinecone/patternStore.js";
import {
  fetchOhlcRange,
  fetchLatestOpenExecutedTradeByTicker,
  fetchOpenExecutedTrades,
  fetchExecutedTradesSince,
  insertBacktestTrade,
  insertTrade,
  updateTradeExit,
  updateTradePartialExits,
} from "../db/repositories.js";
import { atr as computeAtr, rsi, vwap, volumeZScore } from "../indicators/core.js";
import {
  evaluateEma20BreakRetest,
  evaluateBigBoy,
  evaluateInitialBalanceBreakRetest,
  evaluateInsideBarBreakoutRetest,
  evaluateMeanReversion,
  evaluateOpenDrivePullback,
  evaluateOrb,
  evaluateOrbFakeoutReversal,
  evaluateIndexLaggardCatchup,
  evaluateEmaRibbonTrend,
  evaluateOrbRetest15m,
  evaluatePrevDayBreakRetest,
  evaluateVolatilityContractionBreakout,
  evaluateVwapPullbackTrend,
  evaluateVwapReclaimContinuation,
  evaluateVwapReclaimReject,
  type TriggerHit,
} from "../strategies/triggers.js";
import { pct5dFromIntradayHistory } from "../market/relativeStrength.js";
import { isNifty50Heavyweight } from "../market/niftyHeavyweights.js";
import { priorDayHighLow } from "../indicators/bigBoy.js";
import {
  createSafetyState,
  evaluateSafety,
  type SafetyState,
} from "./safety.js";
import {
  loadStrategyHealth,
  isStrategyAllowed,
  getStrategyTrackRecord,
  type StrategyHealth,
} from "./strategyTracker.js";
import { DateTime } from "luxon";
import { IST, nowIST } from "../time/ist.js";
import type { ObjectId } from "mongodb";
import {
  evaluateMarketRegime,
  type MarketRegimeSnapshot,
} from "../risk/marketRegime.js";
import {
  evaluatePortfolioRisk,
  type PortfolioPosition,
} from "../risk/portfolioRisk.js";
import { evaluateTimeWindow } from "../risk/timeWindow.js";
import { evaluateSessionPolicy } from "../risk/sessionPolicy.js";
import { getTickerMetadata, getTickerSector } from "../market/tickerMetadata.js";
import { classifyVolRegimeFromCandles } from "../market/volRegime.js";
import {
  getPartialExitPlan,
  partialTargetHit,
  partialTargetPrice,
  plannedPartialQty,
  pnlForExit,
  type PartialExitReason,
} from "./partialExits.js";

export interface BacktestPassOptions {
  /** Wall-clock time being simulated (IST session context) */
  simulatedAt: Date;
  judgeModel?: string;
  /** If true, do not call broker (replay only) */
  skipOrders?: boolean;
  /** Write to `trades_backtest` instead of `trades` */
  persistBacktest?: boolean;
  runId?: string;
  /** If true, skip OpenRouter entirely (deterministic deny) */
  skipJudge?: boolean;
  marketSnapshot?: MarketRegimeSnapshot;
  portfolioPositions?: PortfolioPosition[];
  /**
   * If set, called instead of `insertBacktestTrade` — lets the orchestrator
   * simulate exits before persisting the completed trade document.
   */
  onTradeEntry?: (
    doc: TradeLogDoc,
    entryPrice: number,
    side: "BUY" | "SELL"
  ) => Promise<void>;
}

interface LivePosition {
  ticker: string;
  side: "BUY" | "SELL";
  entryPrice: number;
  entryTime: Date;
  peakPrice: number;
  strategy: string;
  tradeId?: ObjectId;
  qty: number;
  remainingQty: number;
  realizedPnl: number;
  partialExits: NonNullable<TradeLogDoc["partial_exits"]>;
  completedPartialReasons: PartialExitReason[];
  atrAtEntry?: number;
  entryScore?: number;
}

interface Layer1Decision {
  pass: boolean;
  reasons: string[];
  atrPct?: number;
  volumeZ?: number;
}

interface SizingDecision {
  qty: number;
  baseQty: number;
  confidenceMultiplier: number;
  riskMultiplier: number;
  marketMultiplier: number;
  stopDistance?: number;
  maxNotionalQty?: number;
}

interface RankedTrigger {
  hit: TriggerHit;
  score: number;
}

export class ExecutionEngine {
  private safety: SafetyState = createSafetyState();
  private openCount = 0;
  /** Live: last time we ran judge or Pinecone gate for this strategy:ticker */
  private lastJudgeByStrategyTicker = new Map<string, number>();
  /** Live: last hard risk veto time for this strategy:ticker */
  private lastRiskVetoByStrategyTicker = new Map<string, number>();
  /** Live: timestamp of last position exit per ticker — prevents immediate re-entry after stop-out */
  private lastExitByTicker = new Map<string, number>();
  /** Live paper positions tracked for stop/target management */
  private livePositions = new Map<string, LivePosition>();
  /** Rolling strategy performance (loaded once per session start) */
  private strategyHealthMap = new Map<StrategyId, StrategyHealth>();
  /** Yesterday's lessons for judge context */
  private yesterdaysLessons?: string;
  /** Confidence calibration table: bucket(0.0..0.9) -> empirical score */
  private confidenceCalibration = new Map<number, { score: number; n: number }>();
  private confidenceCalibrationSamples = 0;

  constructor(private broker: BrokerClient) {}

  /** Load strategy health from recent trades (call once at session start) */
  async refreshStrategyHealth(): Promise<void> {
    if (!env.strategyAutoGateEnabled) return;
    this.strategyHealthMap = await loadStrategyHealth();
    const disabled = [...this.strategyHealthMap.values()].filter((h) => !h.allowed);
    const reenabled = [...this.strategyHealthMap.values()].filter(
      (h) => h.allowed && h.gate_status === "REENABLED"
    );
    if (disabled.length > 0) {
      for (const h of disabled) {
        console.log(
          `[Strategy Gate] ${h.strategy} DISABLED: ${h.reason} (${h.trades} trades)`
        );
      }
    }
    if (reenabled.length > 0) {
      for (const h of reenabled) {
        console.log(
          `[Strategy Gate] ${h.strategy} REENABLED: ${h.reason ?? "improvement trigger"}`
        );
      }
    }
  }

  /** Build empirical confidence calibration from recent executed live trades. */
  async refreshConfidenceCalibration(): Promise<void> {
    this.confidenceCalibration.clear();
    this.confidenceCalibrationSamples = 0;
    if (!env.confidenceCalibrationEnabled) return;
    const lookbackFrom = nowIST()
      .minus({ days: Math.max(1, env.confidenceCalibrationLookbackDays) })
      .toJSDate();
    const rows = await fetchExecutedTradesSince(lookbackFrom, env.executionEnv);
    if (rows.length < env.confidenceCalibrationMinSamples) return;

    const buckets = new Map<number, { n: number; sum: number }>();
    for (const t of rows) {
      const conf = Math.max(0, Math.min(0.999, t.ai_confidence ?? 0));
      const b = Math.floor(conf * 10) / 10;
      const cur = buckets.get(b) ?? { n: 0, sum: 0 };
      const outcome = t.result?.outcome;
      const realized =
        outcome === "WIN" ? 1 : outcome === "BREAKEVEN" ? 0.5 : 0;
      cur.n += 1;
      cur.sum += realized;
      buckets.set(b, cur);
    }

    for (const [b, v] of buckets) {
      if (v.n < 5) continue;
      this.confidenceCalibration.set(b, { score: v.sum / v.n, n: v.n });
      this.confidenceCalibrationSamples += v.n;
    }
    if (this.confidenceCalibrationSamples > 0) {
      console.log(
        `[Calibration] confidence table loaded (${this.confidenceCalibrationSamples} samples, buckets=${this.confidenceCalibration.size})`
      );
    }
  }

  /** Load realized PnL guardrails from Mongo at session start. */
  async refreshRiskControls(): Promise<void> {
    const now = nowIST();
    const sinceWeek = now.minus({ days: 7 }).toJSDate();
    const since3d = now.minus({ days: 3 }).toJSDate();
    const todayStart = now.startOf("day").toJSDate();
    const rows = await fetchExecutedTradesSince(sinceWeek, env.executionEnv);
    const pnlSince = (from: Date) =>
      rows
        .filter((t) => t.exit_time !== undefined && t.exit_time >= from)
        .reduce((s, t) => s + (t.result?.pnl ?? 0), 0);
    this.safety.weeklyPnl = pnlSince(sinceWeek);
    this.safety.rolling3dPnl = pnlSince(since3d);
    this.safety.dailyPnl = pnlSince(todayStart);

    this.safety.consecutiveLosses = 0;
    for (const t of [...rows].reverse()) {
      if (!t.result?.outcome) continue;
      if (t.result.outcome === "LOSS") this.safety.consecutiveLosses++;
      else break;
    }
  }

  /** Set yesterday's lessons for judge context injection */
  setYesterdaysLessons(lessons: string | undefined): void {
    this.yesterdaysLessons = lessons;
  }

  private calibratedConfidence(raw: number): number {
    const clamped = Math.max(0, Math.min(1, raw));
    if (!env.confidenceCalibrationEnabled) return clamped;
    if (this.confidenceCalibrationSamples < env.confidenceCalibrationMinSamples) {
      return clamped;
    }
    const b = Math.floor(Math.max(0, Math.min(0.999, clamped)) * 10) / 10;
    const row = this.confidenceCalibration.get(b);
    if (!row) return clamped;
    const w = Math.max(0, Math.min(1, env.confidenceCalibrationWeight));
    return clamped * (1 - w) + row.score * w;
  }

  private judgeCooldownForScore(candidateScore: number): number {
    if (!env.adaptiveJudgeCooldownEnabled) return env.judgeCooldownMs;
    const lo = Math.max(1_000, env.adaptiveJudgeCooldownMinMs);
    const hi = Math.max(lo, env.adaptiveJudgeCooldownMaxMs);
    const s = Math.max(0, Math.min(1, candidateScore));
    const scaled = lo + (1 - s) * (hi - lo);
    return Math.floor(scaled);
  }

  /**
   * Compute position size based on ATR and confidence.
   * Risk a fixed % of equity per trade, scaled by judge confidence.
   */
  private computeSizing(
    entryPrice: number,
    atrValue: number | undefined,
    confidence: number,
    riskMultiplier: number,
    marketMultiplier: number
  ): SizingDecision {
    const maxNotionalQty =
      entryPrice > 0 && env.maxNotionalPerTradePct > 0
        ? Math.max(
            1,
            Math.floor(
              (env.accountEquity * env.maxNotionalPerTradePct) / entryPrice
            )
          )
        : undefined;
    const qtyCap =
      maxNotionalQty !== undefined
        ? Math.min(env.maxQtyPerTrade, maxNotionalQty)
        : env.maxQtyPerTrade;

    if (!env.atrSizingEnabled || !atrValue || atrValue <= 0) {
      const baseQty = env.backtestPositionQty;
      const qty = Math.max(
        env.minQtyPerTrade,
        Math.min(qtyCap, Math.floor(baseQty * riskMultiplier * marketMultiplier))
      );
      return {
        qty,
        baseQty,
        confidenceMultiplier: 1,
        riskMultiplier,
        marketMultiplier,
        maxNotionalQty,
      };
    }
    const riskPerTrade = env.accountEquity * env.riskPerTradePct;
    const stopDistance = atrValue * env.atrStopMultiple;
    if (stopDistance <= 0) {
      return {
        qty: env.minQtyPerTrade,
        baseQty: env.minQtyPerTrade,
        confidenceMultiplier: 1,
        riskMultiplier,
        marketMultiplier,
        stopDistance,
        maxNotionalQty,
      };
    }
    const baseQty = Math.floor(riskPerTrade / stopDistance);
    const confMultiplier = env.confidenceSizingEnabled
      ? Math.max(
          0.5,
          Math.min(
            env.confidenceMultiplierMax,
            0.5 + confidence * env.confidenceScaleFactor
          )
        )
      : 1;
    const qty = Math.floor(
      baseQty * confMultiplier * riskMultiplier * marketMultiplier
    );
    return {
      qty: Math.max(env.minQtyPerTrade, Math.min(qtyCap, qty)),
      baseQty,
      confidenceMultiplier: confMultiplier,
      riskMultiplier,
      marketMultiplier,
      stopDistance,
      maxNotionalQty,
    };
  }

  recordPnl(delta: number): void {
    this.safety.dailyPnl += delta;
    this.safety.rolling3dPnl += delta;
    this.safety.weeklyPnl += delta;
    if (delta < 0) this.safety.consecutiveLosses += 1;
    else if (delta > 0) this.safety.consecutiveLosses = 0;
  }

  getOpenCount(): number {
    return this.openCount;
  }

  setOpenCount(n: number): void {
    this.openCount = n;
  }

  async restoreOpenPositionsFromMongo(): Promise<void> {
    const openTrades = await fetchOpenExecutedTrades(env.executionEnv);
    if (openTrades.length === 0) return;

    let restored = 0;
    for (const t of openTrades) {
      if (!t.side || typeof t.entry_price !== "number") continue;
      const partialExits = t.partial_exits ?? [];
      const partialQty = partialExits.reduce((s, p) => s + p.qty, 0);
      const remainingQty = Math.max(0, (t.qty ?? 1) - partialQty);
      const existing = this.livePositions.get(t.ticker);
      if (existing && existing.entryTime >= t.entry_time) continue;
      this.livePositions.set(t.ticker, {
        ticker: t.ticker,
        side: t.side,
        entryPrice: t.entry_price,
        entryTime: t.entry_time,
        peakPrice: t.entry_price,
        strategy: t.strategy,
        tradeId: t._id,
        qty: t.qty ?? 1,
        remainingQty,
        realizedPnl: partialExits.reduce((s, p) => s + p.pnl, 0),
        partialExits,
        completedPartialReasons: partialExits
          .map((p) => p.reason)
          .filter((r): r is PartialExitReason => r === "SCALE_1" || r === "SCALE_2"),
        atrAtEntry: t.atr_at_entry,
      });
      restored++;
    }
    if (restored > 0) {
      console.log(
        `[Execution] restored ${restored} open position(s) from Mongo`
      );
      this.openCount = Math.max(this.openCount, this.livePositions.size);
    }
  }

  /**
   * Rebuild in-memory cooldown maps from recent trade history after a restart.
   * Prevents re-entry on tickers that were stopped out right before the restart,
   * and skips redundant judge calls for strategy:ticker pairs entered very recently.
   * Call from orchestrator.startup() after restoreOpenPositionsFromMongo().
   */
  async restoreInMemoryCooldownsFromMongo(): Promise<void> {
    const nowMs = Date.now();
    // Look back far enough to cover the longest cooldown window we care about.
    const lookbackMs = Math.max(
      env.tickerReentryCooldownMs,
      env.adaptiveJudgeCooldownEnabled ? env.adaptiveJudgeCooldownMaxMs : env.judgeCooldownMs
    );
    const since = new Date(nowMs - lookbackMs);

    let trades: TradeLogDoc[];
    try {
      trades = await fetchExecutedTradesSince(since, env.executionEnv);
    } catch {
      // Non-fatal: cooldowns will simply reset after restart
      return;
    }

    let exitRestored = 0;
    let judgeRestored = 0;

    const judgeCooldownMs = env.adaptiveJudgeCooldownEnabled
      ? env.adaptiveJudgeCooldownMaxMs
      : env.judgeCooldownMs;

    for (const t of trades) {
      // Re-entry cooldown: restore from the most recent exit_time per ticker
      if (t.exit_time instanceof Date) {
        const exitMs = t.exit_time.getTime();
        if (nowMs - exitMs < env.tickerReentryCooldownMs) {
          const prev = this.lastExitByTicker.get(t.ticker) ?? 0;
          if (exitMs > prev) {
            this.lastExitByTicker.set(t.ticker, exitMs);
            exitRestored++;
          }
        }
      }

      // Judge cooldown: closed trades with a recent entry_time means we called the judge
      if (t.entry_time instanceof Date) {
        const entryMs = t.entry_time.getTime();
        if (nowMs - entryMs < judgeCooldownMs) {
          const key = `${t.strategy}:${t.ticker}`;
          const prev = this.lastJudgeByStrategyTicker.get(key) ?? 0;
          if (entryMs > prev) {
            this.lastJudgeByStrategyTicker.set(key, entryMs);
            judgeRestored++;
          }
        }
      }
    }

    // Also seed judge cooldown from open positions already restored into livePositions
    // (fetchExecutedTradesSince only returns closed trades)
    for (const pos of this.livePositions.values()) {
      const entryMs = pos.entryTime.getTime();
      if (nowMs - entryMs < judgeCooldownMs) {
        const key = `${pos.strategy}:${pos.ticker}`;
        const prev = this.lastJudgeByStrategyTicker.get(key) ?? 0;
        if (entryMs > prev) {
          this.lastJudgeByStrategyTicker.set(key, entryMs);
          judgeRestored++;
        }
      }
    }

    if (exitRestored > 0 || judgeRestored > 0) {
      console.log(
        `[Execution] restored cooldowns from Mongo: ${exitRestored} ticker re-entry, ${judgeRestored} judge`
      );
    }
  }

  /**
   * Call on each EXECUTION tick BEFORE runScanningPass.
   * Checks open paper positions against stop/target using latest candle.
   * Closes positions that hit their levels via broker.closeIntraday.
   */
  async checkLiveExits(ticker: string, sessionCandles: Ohlc1m[]): Promise<void> {
    const pos = this.livePositions.get(ticker);
    if (!pos || sessionCandles.length === 0) return;

    const bar = sessionCandles[sessionCandles.length - 1]!;

    // Update peak
    if (pos.side === "BUY" && bar.h > pos.peakPrice) pos.peakPrice = bar.h;
    if (pos.side === "SELL" && bar.l < pos.peakPrice) pos.peakPrice = bar.l;

    await this.processLivePartialExits(pos, bar);
    if (pos.remainingQty <= 0) return;

    // ATR-based exits: use ATR at entry if available, else fall back to fixed %
    const useAtr = env.atrExitsEnabled && pos.atrAtEntry !== undefined && pos.atrAtEntry > 0;
    const stopDist = useAtr
      ? pos.atrAtEntry! * env.atrStopMultiple
      : pos.entryPrice * env.exitStopPct;
    const targetDist = env.partialExitsEnabled && useAtr
      ? Infinity
      : useAtr
        ? pos.atrAtEntry! * env.atrTargetMultiple
        : pos.entryPrice * env.exitTargetPct;
    const trailTriggerDist = useAtr
      ? pos.atrAtEntry! * env.atrTrailTriggerMultiple
      : pos.entryPrice * env.exitTrailTriggerPct;
    const trailDistAbs = useAtr
      ? pos.atrAtEntry! * env.atrTrailDistMultiple
      : pos.peakPrice * env.exitTrailDistPct;

    let shouldExit = false;
    let exitReason = "";
    // Exit price: use the stop/target level that was hit, not bar close.
    // This avoids both over- and under-estimating PnL when price blows through a level mid-bar.
    let exitPrice = bar.c;

    if (pos.side === "BUY") {
      const stopPrice = pos.entryPrice - stopDist;
      const targetPrice = pos.entryPrice + targetDist;
      const trailActive = pos.peakPrice >= pos.entryPrice + trailTriggerDist;
      const trailStop = trailActive ? pos.peakPrice - trailDistAbs : 0;
      const effectiveStop = trailActive ? Math.max(stopPrice, trailStop) : stopPrice;

      // Use bar.h/bar.l — catches intrabar stop/target hits that bar.c misses entirely
      if (bar.h >= targetPrice) {
        shouldExit = true;
        exitPrice = targetPrice;
        exitReason = `target hit (${targetPrice.toFixed(2)})`;
      } else if (bar.l <= effectiveStop) {
        shouldExit = true;
        exitPrice = effectiveStop;
        exitReason = `stop hit (${effectiveStop.toFixed(2)}${trailActive ? " trailing" : ""})`;
      }
    } else {
      const stopPrice = pos.entryPrice + stopDist;
      const targetPrice = pos.entryPrice - targetDist;
      const trailActive = pos.peakPrice <= pos.entryPrice - trailTriggerDist;
      const trailStop = trailActive ? pos.peakPrice + trailDistAbs : Infinity;
      const effectiveStop = trailActive ? Math.min(stopPrice, trailStop) : stopPrice;

      if (bar.l <= targetPrice) {
        shouldExit = true;
        exitPrice = targetPrice;
        exitReason = `target hit (${targetPrice.toFixed(2)})`;
      } else if (bar.h >= effectiveStop) {
        shouldExit = true;
        exitPrice = effectiveStop;
        exitReason = `stop hit (${effectiveStop.toFixed(2)}${trailActive ? " trailing" : ""})`;
      }
    }

    if (shouldExit) {
      console.log(`[Exit] ${ticker} ${pos.side} — ${exitReason} @ ${exitPrice.toFixed(2)}`);
      await this.broker.closeIntraday(ticker);
      this.livePositions.delete(ticker);
      this.openCount = Math.max(0, this.openCount - 1);
      this.lastExitByTicker.set(ticker, Date.now());
      const result = this.liveResultFromExit(pos, exitPrice);
      const pnl = result.pnl;
      this.recordPnl(pnl);
      if (pos.tradeId) {
        await updateTradeExit(pos.tradeId, {
          exit_time: bar.ts,
          result,
        });
      }
    }
  }

  private async processLivePartialExits(
    pos: LivePosition,
    bar: Ohlc1m
  ): Promise<void> {
    if (!env.partialExitsEnabled) return;
    if (!pos.atrAtEntry || pos.atrAtEntry <= 0) return;

    for (const step of getPartialExitPlan()) {
      if (pos.completedPartialReasons.includes(step.reason)) continue;
      const target = partialTargetPrice(
        pos.side,
        pos.entryPrice,
        pos.atrAtEntry,
        step.atrMultiple
      );
      if (!partialTargetHit(pos.side, bar.h, bar.l, target)) continue;
      const qty = plannedPartialQty(pos.qty, pos.remainingQty, step.qtyPct);
      if (qty <= 0) {
        pos.completedPartialReasons.push(step.reason);
        continue;
      }

      const closeSide: "BUY" | "SELL" = pos.side === "BUY" ? "SELL" : "BUY";
      await this.broker.placePaperOrder({
        ticker: pos.ticker,
        side: closeSide,
        qty,
        strategy: `${pos.strategy}:${step.reason}`,
      });
      const pnl = pnlForExit(pos.side, pos.entryPrice, bar.c, qty);
      pos.remainingQty = Math.max(0, pos.remainingQty - qty);
      pos.realizedPnl += pnl.pnl;
      pos.completedPartialReasons.push(step.reason);
      pos.partialExits.push({
        ts: bar.ts,
        price: bar.c,
        qty,
        reason: step.reason,
        pnl: pnl.pnl,
        pnl_percent: pnl.pnlPercent,
        remaining_qty: pos.remainingQty,
      });
      if (pos.tradeId) {
        await updateTradePartialExits(pos.tradeId, pos.partialExits);
      }
      if (env.liveDebugScans) {
        console.log(
          `[Exit] ${pos.ticker} ${step.reason} qty=${qty} @ ${bar.c.toFixed(2)} remaining=${pos.remainingQty}`
        );
      }
    }
  }

  async forceSquareOffTrackedPosition(
    ticker: string,
    exitPrice: number,
    exitTime: Date
  ): Promise<void> {
    const pos = this.livePositions.get(ticker);
    if (!pos) return;
    this.livePositions.delete(ticker);
    this.openCount = Math.max(0, this.openCount - 1);
    this.lastExitByTicker.set(ticker, Date.now());
    const result = this.liveResultFromExit(pos, exitPrice);
    this.recordPnl(result.pnl);
    if (pos.tradeId) {
      await updateTradeExit(pos.tradeId, {
        exit_time: exitTime,
        result,
      });
    }
  }

  async forceSquareOffPersistedPositionForTicker(
    ticker: string,
    exitPrice: number,
    exitTime: Date
  ): Promise<void> {
    if (this.livePositions.has(ticker)) return;
    const t = await fetchLatestOpenExecutedTradeByTicker(ticker, env.executionEnv);
    if (!t || !t.side || typeof t.entry_price !== "number") return;
    const partialExits = t.partial_exits ?? [];
    const partialQty = partialExits.reduce((s, p) => s + p.qty, 0);
    const pos: LivePosition = {
      ticker,
      side: t.side,
      entryPrice: t.entry_price,
      entryTime: t.entry_time,
      peakPrice: t.entry_price,
      strategy: t.strategy,
      tradeId: t._id,
      qty: t.qty ?? 1,
      remainingQty: Math.max(0, (t.qty ?? 1) - partialQty),
      realizedPnl: partialExits.reduce((s, p) => s + p.pnl, 0),
      partialExits,
      completedPartialReasons: partialExits
        .map((p) => p.reason)
        .filter((r): r is PartialExitReason => r === "SCALE_1" || r === "SCALE_2"),
      atrAtEntry: t.atr_at_entry,
    };
    this.lastExitByTicker.set(ticker, Date.now());
    const result = this.liveResultFromExit(pos, exitPrice);
    this.recordPnl(result.pnl);
    await updateTradeExit(t._id, {
      exit_time: exitTime,
      result,
    });
    console.log(
      `[Exit] ${ticker} reconciled persisted trade @ ${exitPrice.toFixed(2)}`
    );
  }

  async runScanningPass(
    args: {
      ticker: string;
      sessionCandles: Ohlc1m[];
      last5m?: Ohlc1m;
      niftyTrendHint?: string;
      newsHeadlines?: string[];
      marketSnapshot?: MarketRegimeSnapshot;
    },
    backtest?: BacktestPassOptions
  ): Promise<void> {
    const preScanSafety = evaluateSafety(this.safety, this.openCount);
    if (!preScanSafety.allowed) {
      const nonBookReasons = preScanSafety.reasons.filter(
        (r) => r !== "Max concurrent trades reached"
      );
      if (!(env.replacementEnabled && nonBookReasons.length === 0)) return;
    }

    const { ticker, sessionCandles, last5m, niftyTrendHint, newsHeadlines, marketSnapshot } =
      args;

    // Ticker re-entry cooldown: block new entries on a ticker recently exited (stop-out or replace)
    if (!backtest && env.tickerReentryCooldownMs > 0) {
      const lastExitMs = this.lastExitByTicker.get(ticker) ?? 0;
      const elapsedMs = Date.now() - lastExitMs;
      if (elapsedMs < env.tickerReentryCooldownMs) {
        if (env.liveDebugScans) {
          const remainingSec = Math.ceil((env.tickerReentryCooldownMs - elapsedMs) / 1000);
          console.log(`[Scan] ${ticker} skipped: re-entry cooldown active (${remainingSec}s remaining)`);
        }
        return;
      }
    }

    if (sessionCandles.length < 30) {
      if (!backtest && env.liveDebugScans) {
        console.log(
          `[Scan] ${ticker} skipped: insufficient bars (${sessionCandles.length}/30)`
        );
      }
      return;
    }

    const sim = backtest?.simulatedAt
      ? DateTime.fromJSDate(backtest.simulatedAt, { zone: IST })
      : nowIST();

    const triggers: TriggerHit[] = [];
    if (env.backtestEnableOrb15m) {
      const orb = evaluateOrb(sessionCandles);
      if (orb) triggers.push(orb);
    }
    if (env.backtestEnableOrbRetest15m) {
      const orbRetest = evaluateOrbRetest15m(sessionCandles);
      if (orbRetest) triggers.push(orbRetest);
    }
    if (env.backtestEnableMeanRevZ) {
      const mr = evaluateMeanReversion(sessionCandles);
      if (mr) triggers.push(mr);
    }
    if (env.backtestEnableVwapReclaimReject) {
      const vw = evaluateVwapReclaimReject(sessionCandles);
      if (vw) triggers.push(vw);
    }
    if (env.backtestEnableVwapPullbackTrend) {
      const vwPull = evaluateVwapPullbackTrend(sessionCandles);
      if (vwPull) triggers.push(vwPull);
    }
    if (env.backtestEnableEma20BreakRetest) {
      const emaRetest = evaluateEma20BreakRetest(sessionCandles);
      if (emaRetest) triggers.push(emaRetest);
    }
    if (env.backtestEnableVwapReclaimContinuation) {
      const vwapCont = evaluateVwapReclaimContinuation(sessionCandles);
      if (vwapCont) triggers.push(vwapCont);
    }
    if (env.backtestEnableInitialBalanceBreakRetest) {
      const ib = evaluateInitialBalanceBreakRetest(sessionCandles);
      if (ib) triggers.push(ib);
    }
    if (env.backtestEnableVolContractionBreakout) {
      const vc = evaluateVolatilityContractionBreakout(sessionCandles);
      if (vc) triggers.push(vc);
    }
    if (env.backtestEnableInsideBarBreakoutRetest) {
      const ibb = evaluateInsideBarBreakoutRetest(sessionCandles);
      if (ibb) triggers.push(ibb);
    }
    if (env.backtestEnableOpenDrivePullback) {
      const odp = evaluateOpenDrivePullback(sessionCandles);
      if (odp) triggers.push(odp);
    }
    if (env.backtestEnableOrbFakeoutReversal) {
      const ofr = evaluateOrbFakeoutReversal(sessionCandles);
      if (ofr) triggers.push(ofr);
    }
    if (env.backtestEnableEmaRibbonTrend) {
      const ert = evaluateEmaRibbonTrend(sessionCandles);
      if (ert) triggers.push(ert);
    }

    if (
      env.backtestEnableIndexLaggardCatchup &&
      isNifty50Heavyweight(ticker, { isBacktest: Boolean(backtest) })
    ) {
      const at = backtest?.simulatedAt ?? new Date();
      const dayStart = sim.startOf("day").toJSDate();
      const histFrom = sim.minus({ days: 22 }).startOf("day").toJSDate();
      const [idxSession, idxHist, tkHist] = await Promise.all([
        fetchOhlcRange(env.niftySymbol, dayStart, at),
        fetchOhlcRange(env.niftySymbol, histFrom, at),
        fetchOhlcRange(ticker, histFrom, at),
      ]);
      const i5 = pct5dFromIntradayHistory(idxHist);
      const t5 = pct5dFromIntradayHistory(tkHist);
      if (i5 !== undefined && t5 !== undefined) {
        const catchup = evaluateIndexLaggardCatchup(
          ticker,
          sessionCandles,
          idxSession,
          i5,
          t5,
          Boolean(backtest)
        );
        if (catchup) triggers.push(catchup);
      }
    }

    const priorDayStart = sim.startOf("day").minus({ days: 1 });
    const priorFrom = priorDayStart.startOf("day").toJSDate();
    const priorTo = priorDayStart.endOf("day").toJSDate();
    const priorDay = await fetchOhlcRange(ticker, priorFrom, priorTo);
    const pd = priorDayHighLow(priorDay);
    if (env.backtestEnableBigBoySweep && pd && last5m) {
      const bb = evaluateBigBoy(last5m, pd);
      if (bb) triggers.push(bb);
    }
    if (env.backtestEnablePrevDayBreakRetest && pd) {
      const pdRetest = evaluatePrevDayBreakRetest(sessionCandles, pd);
      if (pdRetest) triggers.push(pdRetest);
    }

    const volGated = applyVolRegimeGating(triggers, sessionCandles);

    // Strategy auto-gate: filter out strategies with poor rolling performance
    const gatedTriggers = !backtest
      ? volGated.filter((t) => {
          const allowed = isStrategyAllowed(t.strategy, this.strategyHealthMap);
          if (!allowed && env.liveDebugScans) {
            const h = this.strategyHealthMap.get(t.strategy);
            console.log(
              `[Strategy Gate] ${ticker} ${t.strategy} blocked: ${h?.reason ?? "unknown"}`
            );
          }
          return allowed;
        })
      : volGated;

    if (!backtest && env.liveDebugScans) {
      if (triggers.length === 0) {
        console.log(
          `[Scan] ${ticker} no triggers (bars=${sessionCandles.length})`
        );
      } else {
        console.log(
          `[Scan] ${ticker} triggers=${triggers.length} volGated=${volGated.length} stratGated=${gatedTriggers.length} [${gatedTriggers.map((t) => `${t.strategy}:${t.side}`).join(", ")}]`
        );
      }
    }

    let executableTriggers = gatedTriggers;
    if (!backtest && gatedTriggers.length > 0) {
      const positions = this.openPositionsForRisk();
      const grossNotional = positions.reduce(
        (s, p) => s + Math.abs(p.entryPrice * p.qty),
        0
      );
      const betaNotional = positions.reduce((s, p) => {
        const beta = Math.abs(getTickerMetadata(p.ticker).beta);
        return s + Math.abs(p.entryPrice * p.qty) * beta;
      }, 0);
      const grossCap = Math.max(1, env.accountEquity * env.maxGrossExposurePct);
      const betaCap = Math.max(1, env.accountEquity * env.maxBetaExposurePct);
      const noExposureHeadroom = grossNotional >= grossCap || betaNotional >= betaCap;

      executableTriggers = gatedTriggers.filter((t) => {
        if (noExposureHeadroom) return false;
        return true;
      });
      if (
        env.liveDebugScans &&
        executableTriggers.length < gatedTriggers.length &&
        gatedTriggers.length > 0
      ) {
        console.log(
          `[PreFilter] ${ticker} dropped ${gatedTriggers.length - executableTriggers.length}/${gatedTriggers.length} candidates (portfolio headroom)`
        );
      }
    }

    const rankedTriggers = rankTriggers(executableTriggers, sessionCandles);
    const shortlisted = env.candidateQueueEnabled
      ? rankedTriggers.slice(0, Math.max(1, env.maxCandidatesPerTicker))
      : rankedTriggers;
    if (!backtest && env.liveDebugScans && shortlisted.length < rankedTriggers.length) {
      console.log(
        `[Queue] ${ticker} selected ${shortlisted.length}/${rankedTriggers.length} top candidates`
      );
    }

    for (const ranked of shortlisted) {
      await this.maybeExecute(
        ticker,
        ranked.hit,
        {
          niftyTrendHint,
          newsHeadlines,
          sessionCandles,
          marketSnapshot: marketSnapshot ?? backtest?.marketSnapshot,
        },
        backtest,
        ranked.score
      );
    }
  }

  private openPositionsForRisk(): PortfolioPosition[] {
    return [...this.livePositions.values()].map((p) => ({
      ticker: p.ticker,
      side: p.side,
      entryPrice: p.entryPrice,
      qty: p.remainingQty,
    }));
  }

  private async maybeExecute(
    ticker: string,
    hit: TriggerHit,
    ctx: {
      niftyTrendHint?: string;
      newsHeadlines?: string[];
      sessionCandles: Ohlc1m[];
      marketSnapshot?: MarketRegimeSnapshot;
    },
    backtest?: BacktestPassOptions,
    candidateScore = 0.5
  ): Promise<void> {
    const nowMs = backtest?.simulatedAt.getTime() ?? Date.now();
    const strategyTickerKey = `${hit.strategy}:${ticker}`;
    const selectedJudgeModel =
      backtest?.judgeModel ??
      (backtest ? env.judgeModelBacktest : env.judgeModel);

    if (!backtest) {
      const judgeLastAt = this.lastJudgeByStrategyTicker.get(strategyTickerKey) ?? 0;
      const judgeElapsed = nowMs - judgeLastAt;
      const judgeCooldownMs = this.judgeCooldownForScore(candidateScore);
      if (judgeElapsed < judgeCooldownMs) {
        const remaining = judgeCooldownMs - judgeElapsed;
        if (env.liveDebugScans) {
          console.log(
            `[Decision] ${ticker} ${hit.strategy} rejected: judge cooldown active (${Math.ceil(
              remaining / 1000
            )}s)`
          );
        }
        await insertTrade({
          ticker,
          entry_time: new Date(nowMs),
          strategy: hit.strategy as StrategyId,
          env: env.executionEnv,
          order_executed: false,
          technical_snapshot: normalizeSnapshot(hit.snapshot),
          ai_model: selectedJudgeModel,
          ai_confidence: 0,
          ai_confidence_raw: 0,
          ai_reasoning: `COOLDOWN_JUDGE: active ${Math.ceil(remaining / 1000)}s`,
        });
        return;
      }

      const vetoLastAt = this.lastRiskVetoByStrategyTicker.get(strategyTickerKey) ?? 0;
      const vetoElapsed = nowMs - vetoLastAt;
      if (vetoElapsed < env.riskVetoRetryCooldownMs) {
        const remaining = env.riskVetoRetryCooldownMs - vetoElapsed;
        if (env.liveDebugScans) {
          console.log(
            `[Decision] ${ticker} ${hit.strategy} rejected: risk-veto cooldown active (${Math.ceil(
              remaining / 1000
            )}s)`
          );
        }
        await insertTrade({
          ticker,
          entry_time: new Date(nowMs),
          strategy: hit.strategy as StrategyId,
          env: env.executionEnv,
          order_executed: false,
          technical_snapshot: normalizeSnapshot(hit.snapshot),
          ai_model: selectedJudgeModel,
          ai_confidence: 0,
          ai_confidence_raw: 0,
          ai_reasoning: `COOLDOWN_RISK_VETO: active ${Math.ceil(remaining / 1000)}s`,
        });
        return;
      }
    }

    const entryTime = backtest?.simulatedAt ?? new Date();
    const entryPrice =
      ctx.sessionCandles[ctx.sessionCandles.length - 1]?.c ?? 0;
    const atrValue = computeAtr(env.atrPeriod, ctx.sessionCandles);
    const volZValue = volumeZScore(ctx.sessionCandles, 20);
    const side: "BUY" | "SELL" = hit.side;
    const snap = normalizeSnapshot(hit.snapshot);
    const safetyEval = evaluateSafety(this.safety, this.openCount);
    const timeEval = evaluateTimeWindow(hit.strategy, entryTime);
    const sessionEval = evaluateSessionPolicy(entryTime);
    const marketEval = evaluateMarketRegime(
      hit.strategy,
      side,
      ctx.marketSnapshot
    );
    const prePortfolioRiskMultiplier = Math.max(
      0.05,
      safetyEval.throttleMultiplier * sessionEval.size_multiplier
    );
    const preliminarySizing = this.computeSizing(
      entryPrice,
      atrValue,
      0.5,
      prePortfolioRiskMultiplier,
      marketEval.size_multiplier
    );
    const portfolioEval = await evaluatePortfolioRisk({
      ticker,
      side,
      entryPrice,
      qty: preliminarySizing.qty,
      openPositions: backtest?.portfolioPositions ?? this.openPositionsForRisk(),
      at: entryTime,
      throttleMultiplier: safetyEval.throttleMultiplier,
    });
    const safetyReasons =
      !backtest && env.replacementEnabled
        ? safetyEval.reasons.filter((r) => r !== "Max concurrent trades reached")
        : safetyEval.reasons;
    const hardGateReasons = [
      ...safetyReasons,
      ...timeEval.reasons,
      ...marketEval.reasons,
      ...portfolioEval.reasons,
    ];

    const baseDoc: TradeLogDoc = {
      ticker,
      entry_time: entryTime,
      strategy: hit.strategy as StrategyId,
      env: backtest ? "PAPER" : env.executionEnv,
      order_executed: false,
      technical_snapshot: snap,
      ai_model: selectedJudgeModel,
      ai_confidence: 0,
      ai_reasoning: "",
      risk_eval: {
        ...portfolioEval,
        allowed: hardGateReasons.length === 0,
        reasons: hardGateReasons,
        soft_penalties: [
          ...(portfolioEval.soft_penalties ?? []),
          ...sessionEval.reasons,
        ],
        size_multiplier: portfolioEval.size_multiplier,
      },
      market_eval: {
        ...marketEval,
        session_phase: sessionEval.phase,
        session_size_multiplier: sessionEval.size_multiplier,
        session_confidence_floor: sessionEval.confidence_floor,
      },
      sizing_eval: {
        base_qty: preliminarySizing.baseQty,
        final_qty:
          portfolioEval.recommended_qty !== undefined &&
          portfolioEval.recommended_qty >= env.minQtyPerTrade
            ? Math.min(preliminarySizing.qty, portfolioEval.recommended_qty)
            : preliminarySizing.qty,
        confidence_multiplier: preliminarySizing.confidenceMultiplier,
        risk_multiplier: preliminarySizing.riskMultiplier,
        market_multiplier: preliminarySizing.marketMultiplier,
        stop_distance: preliminarySizing.stopDistance,
        max_notional_qty: preliminarySizing.maxNotionalQty,
        exposure_fit_qty:
          portfolioEval.recommended_qty !== undefined &&
          portfolioEval.recommended_qty >= env.minQtyPerTrade
            ? portfolioEval.recommended_qty
            : undefined,
        confidence_sizing_enabled: env.confidenceSizingEnabled,
      },
      ...(backtest?.runId ? { backtest_run_id: backtest.runId } : {}),
    };

    if (hardGateReasons.length > 0) {
      baseDoc.ai_reasoning = `RISK_VETO: ${hardGateReasons.join("; ")}`;
      if (!backtest) this.lastRiskVetoByStrategyTicker.set(strategyTickerKey, nowMs);
      if (!backtest && env.liveDebugScans) {
        console.log(
          `[Risk] ${ticker} ${hit.strategy} ${side} blocked: ${hardGateReasons.join("; ")}`
        );
      }
      if (backtest?.persistBacktest) await insertBacktestTrade(baseDoc);
      else if (!backtest) await insertTrade(baseDoc);
      return;
    }

    const layer1 = evaluateLayer1Decision(entryPrice, atrValue, volZValue);
    const enforceLayer1 = env.shadowEvalEnforceLayer1 && !backtest;

    // Build enriched price context for judge
    const priceContext = buildPriceContext(ctx.sessionCandles);
    const indicators = buildIndicators(ctx.sessionCandles);
    const strategyRecord = getStrategyTrackRecord(
      hit.strategy,
      this.strategyHealthMap
    );

    let judge: JudgeResult;
    let decisionVia:
      | "skip-judge"
      | "pinecone-gate"
      | "llm-judge"
      | "layer1-veto";
    let patternSummary: string | undefined;
    const sector = getTickerSector(ticker);
    const volRegime = classifyVolRegimeFromCandles(ctx.sessionCandles);
    if (enforceLayer1 && !layer1.pass) {
      judge = {
        approve: false,
        confidence: 0,
        reasoning: `LAYER1_VETO: ${layer1.reasons.join("; ")}`,
      };
      decisionVia = "layer1-veto";
    } else {
      const vector = await embedCandlePattern(ctx.sessionCandles);
      const rawNeighbors = await querySimilarPatterns(vector, 8);
      const neighbors =
        backtest?.simulatedAt !== undefined
          ? filterCausalNeighborsForBacktest(rawNeighbors, backtest.simulatedAt)
          : rawNeighbors;
      const mem = scoreFromNeighbors(neighbors, 0.72);

      // Build pattern memory summary
      if (mem.useMemory) {
        const strongNeighbors = neighbors.filter((n) => n.score >= 0.72);
        const avgPnl = strongNeighbors.length > 0
          ? strongNeighbors.reduce((s, n) => s + n.meta.pnl_percent, 0) / strongNeighbors.length
          : 0;
        patternSummary = `Similar patterns: ${strongNeighbors.length} found | Win rate: ${(mem.pWin * 100).toFixed(0)}% | Avg PnL: ${avgPnl > 0 ? "+" : ""}${avgPnl.toFixed(1)}%`;
        if (neighbors[0]) {
          patternSummary += `\nBest match: score=${neighbors[0].score.toFixed(3)}, outcome=${neighbors[0].meta.outcome}, pnl=${neighbors[0].meta.pnl_percent > 0 ? "+" : ""}${neighbors[0].meta.pnl_percent.toFixed(1)}%`;
        }
      } else if (neighbors.length > 0 && hit.strategy === "BIG_BOY_SWEEP") {
        patternSummary = neighbors
          .slice(0, 3)
          .map((n) => `${n.meta.outcome} ${n.meta.pnl_percent}% @ ${n.meta.date}`)
          .join("; ");
      }

      const indexLaggardContext =
        hit.strategy === "INDEX_LAGGARD_CATCHUP"
          ? `5d NIFTY ${Number(hit.snapshot.index_pct5d).toFixed(2)}% vs laggard ${Number(hit.snapshot.ticker_pct5d).toFixed(2)}%; Nifty today ${Number(hit.snapshot.nifty_from_open_pct).toFixed(2)}% from open; trigger_mode=${hit.snapshot.trigger_mode}`
          : undefined;

      const judgeInput: JudgeInput = {
        strategy: hit.strategy,
        ticker,
        side: hit.side,
        triggerHint: hit.hint,
        niftyContext: ctx.niftyTrendHint,
        indexLaggardContext,
        newsHeadlines: ctx.newsHeadlines,
        similarPatternsSummary: patternSummary,
        priceContext,
        indicators,
        strategyTrackRecord: strategyRecord,
        yesterdaysLessons: this.yesterdaysLessons,
      };

      const pineconeConsensus = evaluatePineconeConsensus(
        neighbors,
        hit.strategy,
        sector,
        volRegime
      );
      const pineconeGate =
        !backtest &&
        env.pineconeGateEnabled &&
        pineconeConsensus.approve;

      const skipJudgeMode =
        backtest?.skipJudge === true || (!backtest && env.liveSkipJudge);

      if (skipJudgeMode) {
        judge = {
          approve: true,
          confidence: 0.5,
          reasoning: backtest?.skipJudge
            ? "skipJudge: technical trigger auto-approved (LLM bypassed)"
            : "LIVE_SKIP_JUDGE: technical trigger auto-approved (LLM bypassed)",
        };
        decisionVia = "skip-judge";
      } else if (pineconeGate) {
        judge = {
          approve: true,
          confidence: Math.min(0.99, pineconeConsensus.avgScore),
          reasoning: `PINECONE_CONSENSUS neighbors=${pineconeConsensus.neighborCount} wr=${(pineconeConsensus.winRate * 100).toFixed(0)}% avg_score=${pineconeConsensus.avgScore.toFixed(4)}`,
        };
        decisionVia = "pinecone-gate";
      } else {
        judge = await callJudgeModel(judgeInput, { model: selectedJudgeModel });
        decisionVia = "llm-judge";
      }
    }

    if (!backtest) {
      const strategyTickerKey = `${hit.strategy}:${ticker}`;
      this.lastJudgeByStrategyTicker.set(strategyTickerKey, nowMs);
    }

    const calibratedConfidence = this.calibratedConfidence(judge.confidence);
    const minConfidenceRequired = Math.max(
      marketEval.confidence_floor ?? 0,
      sessionEval.confidence_floor
    );
    if (judge.approve && calibratedConfidence < minConfidenceRequired) {
      judge = {
        approve: false,
        confidence: calibratedConfidence,
        reasoning: `CONFIDENCE_FLOOR: ${calibratedConfidence.toFixed(2)} < ${minConfidenceRequired.toFixed(2)}; ${judge.reasoning}`,
      };
    }
    const finalDecision: "APPROVE" | "DENY" = judge.approve ? "APPROVE" : "DENY";
    const counterfactualTwoLayerDecision: "APPROVE" | "DENY" =
      layer1.pass && judge.approve ? "APPROVE" : "DENY";

    if (!backtest && env.liveDebugScans) {
      console.log(
        `[Decision] ${ticker} ${hit.strategy} ${hit.side} approve=${judge.approve} via=${decisionVia} l1=${layer1.pass ? "PASS" : "BLOCK"} cf2=${counterfactualTwoLayerDecision} conf_raw=${judge.confidence.toFixed(2)} conf_final=${calibratedConfidence.toFixed(2)} floor=${minConfidenceRequired.toFixed(2)} reason="${shortReason(judge.reasoning)}"`
      );
    }

    const effectiveRiskMultiplier = Math.max(
      0.05,
      safetyEval.throttleMultiplier *
        sessionEval.size_multiplier *
        Math.max(0.05, portfolioEval.size_multiplier ?? 1)
    );
    const sizingBase = this.computeSizing(
      entryPrice,
      atrValue,
      calibratedConfidence,
      effectiveRiskMultiplier,
      marketEval.size_multiplier
    );
    const exposureFitQty =
      portfolioEval.recommended_qty !== undefined &&
      portfolioEval.recommended_qty >= env.minQtyPerTrade
        ? portfolioEval.recommended_qty
        : undefined;
    const sizing: SizingDecision = {
      ...sizingBase,
      qty:
        exposureFitQty !== undefined
          ? Math.min(sizingBase.qty, exposureFitQty)
          : sizingBase.qty,
    };
    const qty = sizing.qty;
    const doc: TradeLogDoc = {
      ...baseDoc,
      ai_confidence: calibratedConfidence,
      ai_confidence_raw: judge.confidence,
      ai_reasoning: judge.reasoning,
      sizing_eval: {
        base_qty: sizing.baseQty,
        final_qty: sizing.qty,
        confidence_multiplier: sizing.confidenceMultiplier,
        risk_multiplier: sizing.riskMultiplier,
        market_multiplier: sizing.marketMultiplier,
        stop_distance: sizing.stopDistance,
        max_notional_qty: sizing.maxNotionalQty,
        exposure_fit_qty: exposureFitQty,
        confidence_sizing_enabled: env.confidenceSizingEnabled,
      },
    };

    if (env.shadowEvalEnabled || env.shadowEvalEnforceLayer1) {
      doc.shadow_eval = {
        enabled: true,
        layer1_decision: layer1.pass ? "PASS" : "BLOCK",
        layer1_reasons: layer1.reasons.length > 0 ? layer1.reasons : undefined,
        layer1_volume_z: layer1.volumeZ,
        layer1_atr_pct: layer1.atrPct,
        layer2_decision: judge.approve ? "APPROVE" : "DENY",
        layer2_via: decisionVia,
        final_decision: finalDecision,
        counterfactual_two_layer_decision: counterfactualTwoLayerDecision,
        disagreed: finalDecision !== counterfactualTwoLayerDecision,
      };
    }

    const decisionScore = Math.max(
      0,
      Math.min(1, candidateScore * 0.4 + calibratedConfidence * 0.6)
    );
    let doOrder = judge.approve && !backtest?.skipOrders;
    let nonEntryReason: string | undefined;

    if (!backtest && doOrder) {
      if (this.openCount >= env.maxConcurrentTrades) {
        const replaced = await this.maybeReplaceWeakestPosition(
          decisionScore,
          calibratedConfidence
        );
        if (!replaced) {
          doOrder = false;
          nonEntryReason = `BOOK_FULL: open=${this.openCount}/${env.maxConcurrentTrades} replacement_rejected`;
        }
      }
      if (doOrder) {
        const orderSafety = evaluateSafety(this.safety, this.openCount);
        const orderSafetyReasons = env.replacementEnabled
          ? orderSafety.reasons.filter((r) => r !== "Max concurrent trades reached")
          : orderSafety.reasons;
        if (orderSafetyReasons.length > 0) {
          doOrder = false;
          nonEntryReason = `ORDER_BLOCK: ${orderSafetyReasons.join("; ")}`;
        }
      }
    }

    if (judge.approve && backtest) {
      // Backtest replay may bypass broker orders; still mark a complete executed entry.
      doc.order_executed = true;
      doc.side = side;
      doc.entry_price = entryPrice;
      doc.qty = qty;
      doc.atr_at_entry = atrValue;
    }

    let liveEntryPersisted = false;
    if (doOrder) {
      doc.order_executed = true;
      doc.side = side;
      doc.entry_price = entryPrice;
      doc.qty = qty;
      doc.atr_at_entry = atrValue;
      await this.broker.placePaperOrder({
        ticker,
        side,
        qty,
        strategy: hit.strategy,
      });
      if (!backtest && env.liveDebugScans) {
        console.log(
          `[Entry] ${ticker} ${hit.strategy} ${side} qty=${qty} @ ${entryPrice.toFixed(2)} ATR=${atrValue?.toFixed(2) ?? "n/a"}`
        );
      }
      this.openCount += 1;
      // Track position for live stop/target management
      if (!backtest) {
        const tradeId = await insertTrade(doc);
        liveEntryPersisted = true;
        this.livePositions.set(ticker, {
          ticker,
          side,
          entryPrice,
          entryTime: entryTime,
          peakPrice: entryPrice,
          strategy: hit.strategy,
          tradeId,
          qty,
          remainingQty: qty,
          realizedPnl: 0,
          partialExits: [],
          completedPartialReasons: [],
          atrAtEntry: atrValue,
          entryScore: decisionScore,
        });
      }
    }

    if (judge.approve && backtest?.onTradeEntry) {
      // Delegate persistence to orchestrator (for exit simulation)
      await backtest.onTradeEntry(doc, entryPrice, side);
    } else if (backtest?.persistBacktest) {
      await insertBacktestTrade(doc);
    } else if (!backtest) {
      if (!liveEntryPersisted) {
        if (judge.approve && nonEntryReason) {
          doc.ai_reasoning = `${doc.ai_reasoning} | ${nonEntryReason}`;
        }
        await insertTrade(doc);
        if (env.liveDebugScans) {
          console.log(
            `[Decision] ${ticker} ${hit.strategy} persisted as non-entry (approve=${judge.approve})`
          );
        }
      }
    }
  }

  private weakestOpenPosition():
    | { ticker: string; score: number; pos: LivePosition }
    | undefined {
    let weakest:
      | { ticker: string; score: number; pos: LivePosition }
      | undefined;
    for (const [ticker, pos] of this.livePositions.entries()) {
      const score = pos.entryScore ?? 0;
      if (!weakest || score < weakest.score) {
        weakest = { ticker, score, pos };
      }
    }
    return weakest;
  }

  private async maybeReplaceWeakestPosition(
    incomingScore: number,
    judgeConfidence: number
  ): Promise<boolean> {
    if (!env.replacementEnabled) return false;
    if (judgeConfidence < env.replacementMinConfidence) return false;
    const weakest = this.weakestOpenPosition();
    if (!weakest) return false;
    const delta = incomingScore - weakest.score;
    if (delta < env.replacementMinScoreDelta) return false;

    const now = nowIST();
    const day = now.startOf("day").toJSDate();
    const candles = await fetchOhlcRange(weakest.ticker, day, now.toJSDate());
    const last = candles[candles.length - 1];
    if (!last) return false;

    await this.broker.closeIntraday(weakest.ticker);
    this.livePositions.delete(weakest.ticker);
    this.openCount = Math.max(0, this.openCount - 1);
    this.lastExitByTicker.set(weakest.ticker, Date.now());
    const result = this.liveResultFromExit(weakest.pos, last.c);
    this.recordPnl(result.pnl);
    if (weakest.pos.tradeId) {
      await updateTradeExit(weakest.pos.tradeId, {
        exit_time: now.toJSDate(),
        result,
      });
    }
    if (env.liveDebugScans) {
      console.log(
        `[Replace] closed ${weakest.ticker} score=${weakest.score.toFixed(
          2
        )} for incoming score=${incomingScore.toFixed(2)} delta=${delta.toFixed(2)}`
      );
    }
    return true;
  }

  private liveResultFromExit(
    pos: LivePosition,
    exitPrice: number
  ): NonNullable<TradeLogDoc["result"]> {
    const pnlPerShare =
      pos.side === "BUY" ? exitPrice - pos.entryPrice : pos.entryPrice - exitPrice;
    const pnlRaw = pos.realizedPnl + pnlPerShare * pos.remainingQty;
    const pnl = parseFloat(pnlRaw.toFixed(2));
    const pctBase = Math.max(1e-9, pos.entryPrice * pos.qty);
    const pnlPercent = (pnlRaw / pctBase) * 100;
    const outcome =
      pnlPercent > 0.1 ? "WIN" : pnlPercent < -0.1 ? "LOSS" : "BREAKEVEN";
    return {
      pnl,
      slippage: 0,
      outcome,
      pnl_percent: parseFloat(pnlPercent.toFixed(3)),
    };
  }
}

function shortReason(reason: string): string {
  const r = reason.replace(/\s+/g, " ").trim();
  return r.length <= 140 ? r : `${r.slice(0, 137)}...`;
}

function evaluateLayer1Decision(
  entryPrice: number,
  atrValue: number | undefined,
  volumeZ: number | undefined
): Layer1Decision {
  const reasons: string[] = [];
  const atrPct =
    atrValue !== undefined && entryPrice > 0
      ? (atrValue / entryPrice) * 100
      : undefined;

  if (volumeZ !== undefined && volumeZ < env.layer1MinVolumeZ) {
    reasons.push(
      `volume_z=${volumeZ.toFixed(2)}<${env.layer1MinVolumeZ.toFixed(2)}`
    );
  }
  if (atrPct !== undefined && atrPct > env.layer1MaxAtrPct) {
    reasons.push(
      `atr_pct=${atrPct.toFixed(2)}>${env.layer1MaxAtrPct.toFixed(2)}`
    );
  }

  return {
    pass: reasons.length === 0,
    reasons,
    atrPct,
    volumeZ,
  };
}

type VolRegime = "LOW" | "MID" | "HIGH";

function classifyVolRegime(sessionCandles: Ohlc1m[]): VolRegime | undefined {
  const lookback = Math.max(10, Math.floor(env.volRegimeLookbackBars));
  if (sessionCandles.length < lookback + 1) return undefined;

  const slice = sessionCandles.slice(-lookback - 1);
  const returnsPct: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    const prev = slice[i - 1]!.c;
    const curr = slice[i]!.c;
    if (prev <= 0) continue;
    returnsPct.push(((curr - prev) / prev) * 100);
  }
  if (returnsPct.length < 8) return undefined;

  const mean = returnsPct.reduce((a, b) => a + b, 0) / returnsPct.length;
  const variance =
    returnsPct.reduce((s, r) => s + (r - mean) ** 2, 0) / returnsPct.length;
  const sigma = Math.sqrt(variance);

  if (sigma < env.volRegimeLowMaxPct) return "LOW";
  if (sigma >= env.volRegimeHighMinPct) return "HIGH";
  return "MID";
}

function rankTriggers(
  triggers: TriggerHit[],
  candles: Ohlc1m[]
): RankedTrigger[] {
  const baseByStrategy: Partial<Record<StrategyId, number>> = {
    INDEX_LAGGARD_CATCHUP: 0.7,
    OPEN_DRIVE_PULLBACK: 0.72,
    VWAP_PULLBACK_TREND: 0.68,
    EMA20_BREAK_RETEST: 0.64,
    ORB_FAKEOUT_REVERSAL: 0.62,
    ORB_15M: 0.6,
    ORB_RETEST_15M: 0.6,
    MEAN_REV_Z: 0.58,
    BIG_BOY_SWEEP: 0.58,
  };
  const volZ = volumeZScore(candles, 20);
  const atrVal = computeAtr(env.atrPeriod, candles);
  const px = candles[candles.length - 1]?.c ?? 0;
  const atrPct = atrVal && px > 0 ? (atrVal / px) * 100 : undefined;

  return triggers
    .map((hit) => {
      const base = baseByStrategy[hit.strategy] ?? 0.55;
      const volBonus =
        volZ !== undefined ? Math.max(-0.08, Math.min(0.1, volZ * 0.05)) : 0;
      const atrPenalty =
        atrPct !== undefined
          ? Math.max(-0.08, Math.min(0, (atrPct - 1.5) * -0.05))
          : 0;
      const score = Math.max(0, Math.min(1, base + volBonus + atrPenalty));
      return { hit, score };
    })
    .sort((a, b) => b.score - a.score);
}

function allowedInRegime(strategy: StrategyId, regime: VolRegime): boolean {
  if (
    strategy === "ORB_15M" ||
    strategy === "ORB_RETEST_15M" ||
    strategy === "INITIAL_BALANCE_BREAK_RETEST" ||
    strategy === "VOLATILITY_CONTRACTION_BREAKOUT" ||
    strategy === "INSIDE_BAR_BREAKOUT_WITH_RETEST" ||
    strategy === "EMA20_BREAK_RETEST" ||
    strategy === "PREV_DAY_HIGH_LOW_BREAK_RETEST" ||
    strategy === "INDEX_LAGGARD_CATCHUP"
  ) {
    return regime === "LOW"
      ? env.volRegimeOrbLow
      : regime === "MID"
        ? env.volRegimeOrbMid
        : env.volRegimeOrbHigh;
  }
  if (strategy === "EMA_RIBBON_TREND") {
    // VWAP-like: works in LOW-MID (trending), blocked in HIGH (choppy)
    return regime === "LOW"
      ? env.volRegimeVwapLow
      : regime === "MID"
        ? env.volRegimeVwapMid
        : env.volRegimeVwapHigh;
  }
  if (strategy === "MEAN_REV_Z" || strategy === "ORB_FAKEOUT_REVERSAL") {
    return regime === "LOW"
      ? env.volRegimeMeanRevLow
      : regime === "MID"
        ? env.volRegimeMeanRevMid
        : env.volRegimeMeanRevHigh;
  }
  if (strategy === "BIG_BOY_SWEEP") {
    return regime === "LOW"
      ? env.volRegimeBigBoyLow
      : regime === "MID"
        ? env.volRegimeBigBoyMid
        : env.volRegimeBigBoyHigh;
  }
  return regime === "LOW"
    ? env.volRegimeVwapLow
    : regime === "MID"
      ? env.volRegimeVwapMid
      : env.volRegimeVwapHigh;
}

function applyVolRegimeGating(
  triggers: TriggerHit[],
  sessionCandles: Ohlc1m[]
): TriggerHit[] {
  if (!env.volRegimeSwitchEnabled || triggers.length === 0) return triggers;
  const regime = classifyVolRegime(sessionCandles);
  if (!regime) return triggers;
  return triggers.filter((t) => allowedInRegime(t.strategy, regime));
}

function normalizeSnapshot(
  raw: Record<string, number | undefined>
): TechnicalSnapshot {
  const t: TechnicalSnapshot = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined) t[k] = v;
  }
  return t;
}

/**
 * For replay, avoid lookahead from memory by allowing only patterns from dates
 * strictly before the simulated session date.
 */
function filterCausalNeighborsForBacktest(
  neighbors: SimilarPattern[],
  simulatedAt: Date
): SimilarPattern[] {
  const simDay = DateTime.fromJSDate(simulatedAt, { zone: IST }).startOf("day");
  return neighbors.filter((n) => {
    const d = DateTime.fromISO(n.meta.date, { zone: IST });
    if (!d.isValid) return false;
    return d.startOf("day") < simDay;
  });
}

function evaluatePineconeConsensus(
  neighbors: SimilarPattern[],
  strategy: StrategyId,
  sector: string,
  volRegime: string | undefined
): { approve: boolean; neighborCount: number; winRate: number; avgScore: number } {
  const strong = neighbors.filter((n) => {
    if (n.score < env.pineconeGateConsensusMinScore) return false;
    if (env.pineconeGateRequireSameStrategy && n.meta.strategy !== strategy) {
      return false;
    }
    return true;
  });

  if (strong.length === 0) {
    return { approve: false, neighborCount: 0, winRate: 0, avgScore: 0 };
  }

  let totalWeight = 0;
  let winWeight = 0;
  let scoreSum = 0;
  for (const n of strong) {
    let weight = 1;
    if (n.meta.sector && n.meta.sector === sector) {
      weight *= env.pineconeGateSameSectorWeight;
    }
    if (volRegime && n.meta.vol_regime && n.meta.vol_regime === volRegime) {
      weight *= env.pineconeGateSameRegimeWeight;
    }
    totalWeight += weight;
    if (n.meta.outcome === "WIN") winWeight += weight;
    scoreSum += n.score;
  }

  const winRate = totalWeight > 0 ? winWeight / totalWeight : 0;
  const avgScore = scoreSum / strong.length;
  return {
    approve:
      strong.length >= env.pineconeGateMinNeighbors &&
      winRate >= env.pineconeGateMinWinRate,
    neighborCount: strong.length,
    winRate,
    avgScore,
  };
}

/** Build last 5 candles as a tabular string for the judge prompt */
function buildPriceContext(candles: Ohlc1m[]): string | undefined {
  if (candles.length < 5) return undefined;
  const last5 = candles.slice(-5);
  const lines = last5.map((c) => {
    const t = DateTime.fromJSDate(c.ts, { zone: IST });
    return `${t.toFormat("HH:mm")}  ${c.o.toFixed(1)}  ${c.h.toFixed(1)}  ${c.l.toFixed(1)}  ${c.c.toFixed(1)}  ${c.v}`;
  });
  return `Time   O       H       L       C       Vol\n${lines.join("\n")}`;
}

/** Build indicator summary string for the judge prompt */
function buildIndicators(candles: Ohlc1m[]): string | undefined {
  if (candles.length < 20) return undefined;
  const parts: string[] = [];

  const rsiVal = rsi(14, candles);
  if (rsiVal !== undefined) parts.push(`RSI(14): ${rsiVal.toFixed(1)}`);

  const atrVal = computeAtr(14, candles);
  if (atrVal !== undefined) parts.push(`ATR(14): ₹${atrVal.toFixed(2)}`);

  const vwapVal = vwap(candles);
  const lastClose = candles[candles.length - 1]!.c;
  const vwapDist = ((lastClose - vwapVal) / vwapVal) * 100;
  parts.push(`VWAP: ${vwapVal.toFixed(1)} (price ${vwapDist >= 0 ? "+" : ""}${vwapDist.toFixed(2)}% ${vwapDist >= 0 ? "above" : "below"})`);

  const volZ = volumeZScore(candles, 20);
  if (volZ !== undefined) parts.push(`Vol Z: ${volZ.toFixed(1)}`);

  return parts.join(" | ");
}
