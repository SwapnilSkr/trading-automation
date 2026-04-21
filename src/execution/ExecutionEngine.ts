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
  insertBacktestTrade,
  insertTrade,
  updateTradeExit,
} from "../db/repositories.js";
import {
  evaluateEma20BreakRetest,
  evaluateBigBoy,
  evaluateInitialBalanceBreakRetest,
  evaluateInsideBarBreakoutRetest,
  evaluateMeanReversion,
  evaluateOpenDrivePullback,
  evaluateOrb,
  evaluateOrbFakeoutReversal,
  evaluateOrbRetest15m,
  evaluatePrevDayBreakRetest,
  evaluateVolatilityContractionBreakout,
  evaluateVwapPullbackTrend,
  evaluateVwapReclaimContinuation,
  evaluateVwapReclaimReject,
  type TriggerHit,
} from "../strategies/triggers.js";
import { priorDayHighLow } from "../indicators/bigBoy.js";
import { checkSafety, createSafetyState, type SafetyState } from "./safety.js";
import { DateTime } from "luxon";
import { IST, nowIST } from "../time/ist.js";
import type { ObjectId } from "mongodb";

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
}

export class ExecutionEngine {
  private safety: SafetyState = createSafetyState();
  private openCount = 0;
  /** Live: last time we ran judge or Pinecone gate for this strategy:ticker */
  private lastJudgeByStrategyTicker = new Map<string, number>();
  /** Live paper positions tracked for stop/target management */
  private livePositions = new Map<string, LivePosition>();

  constructor(private broker: BrokerClient) {}

  recordPnl(delta: number): void {
    this.safety.dailyPnl += delta;
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

    const stopPct = env.exitStopPct;
    const targetPct = env.exitTargetPct;
    const trailTriggerPct = env.exitTrailTriggerPct;
    const trailDistPct = env.exitTrailDistPct;

    let shouldExit = false;
    let exitReason = "";

    if (pos.side === "BUY") {
      const stopPrice = pos.entryPrice * (1 - stopPct);
      const targetPrice = pos.entryPrice * (1 + targetPct);
      const trailActive = pos.peakPrice >= pos.entryPrice * (1 + trailTriggerPct);
      const trailStop = trailActive ? pos.peakPrice * (1 - trailDistPct) : 0;
      const effectiveStop = trailActive ? Math.max(stopPrice, trailStop) : stopPrice;

      if (bar.c >= targetPrice) { shouldExit = true; exitReason = `target hit (${targetPrice.toFixed(2)})`; }
      else if (bar.c <= effectiveStop) { shouldExit = true; exitReason = `stop hit (${effectiveStop.toFixed(2)}${trailActive ? " trailing" : ""})`; }
    } else {
      const stopPrice = pos.entryPrice * (1 + stopPct);
      const targetPrice = pos.entryPrice * (1 - targetPct);
      const trailActive = pos.peakPrice <= pos.entryPrice * (1 - trailTriggerPct);
      const trailStop = trailActive ? pos.peakPrice * (1 + trailDistPct) : Infinity;
      const effectiveStop = trailActive ? Math.min(stopPrice, trailStop) : stopPrice;

      if (bar.c <= targetPrice) { shouldExit = true; exitReason = `target hit (${targetPrice.toFixed(2)})`; }
      else if (bar.c >= effectiveStop) { shouldExit = true; exitReason = `stop hit (${effectiveStop.toFixed(2)}${trailActive ? " trailing" : ""})`; }
    }

    if (shouldExit) {
      console.log(`[Exit] ${ticker} ${pos.side} — ${exitReason} @ ${bar.c}`);
      await this.broker.closeIntraday(ticker);
      this.livePositions.delete(ticker);
      this.openCount = Math.max(0, this.openCount - 1);
      const result = this.liveResultFromExit(pos, bar.c);
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

  async forceSquareOffTrackedPosition(
    ticker: string,
    exitPrice: number,
    exitTime: Date
  ): Promise<void> {
    const pos = this.livePositions.get(ticker);
    if (!pos) return;
    this.livePositions.delete(ticker);
    this.openCount = Math.max(0, this.openCount - 1);
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
    const pos: LivePosition = {
      ticker,
      side: t.side,
      entryPrice: t.entry_price,
      entryTime: t.entry_time,
      peakPrice: t.entry_price,
      strategy: t.strategy,
      tradeId: t._id,
    };
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
    },
    backtest?: BacktestPassOptions
  ): Promise<void> {
    if (!checkSafety(this.safety, this.openCount)) return;

    const { ticker, sessionCandles, last5m, niftyTrendHint, newsHeadlines } =
      args;
    if (sessionCandles.length < 30) {
      if (!backtest && env.liveDebugScans) {
        console.log(
          `[Scan] ${ticker} skipped: insufficient bars (${sessionCandles.length}/30)`
        );
      }
      return;
    }

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

    const sim = backtest?.simulatedAt
      ? DateTime.fromJSDate(backtest.simulatedAt, { zone: IST })
      : nowIST();
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

    const gatedTriggers = applyVolRegimeGating(triggers, sessionCandles);

    if (!backtest && env.liveDebugScans) {
      if (triggers.length === 0) {
        console.log(
          `[Scan] ${ticker} no triggers (bars=${sessionCandles.length})`
        );
      } else {
        console.log(
          `[Scan] ${ticker} triggers=${triggers.length} gated=${gatedTriggers.length} [${gatedTriggers.map((t) => `${t.strategy}:${t.side}`).join(", ")}]`
        );
      }
    }

    for (const hit of gatedTriggers) {
      await this.maybeExecute(ticker, hit, {
        niftyTrendHint,
        newsHeadlines,
        sessionCandles,
      }, backtest);
    }
  }

  private async maybeExecute(
    ticker: string,
    hit: TriggerHit,
    ctx: {
      niftyTrendHint?: string;
      newsHeadlines?: string[];
      sessionCandles: Ohlc1m[];
    },
    backtest?: BacktestPassOptions
  ): Promise<void> {
    if (!checkSafety(this.safety, this.openCount)) return;

    const nowMs = backtest?.simulatedAt.getTime() ?? Date.now();
    const strategyTickerKey = `${hit.strategy}:${ticker}`;
    if (
      !backtest &&
      nowMs - (this.lastJudgeByStrategyTicker.get(strategyTickerKey) ?? 0) < env.judgeCooldownMs
    ) {
      if (env.liveDebugScans) {
        console.log(
          `[Decision] ${ticker} ${hit.strategy} rejected: cooldown active`
        );
      }
      return;
    }

    const vector = await embedCandlePattern(ctx.sessionCandles);
    const rawNeighbors = await querySimilarPatterns(vector, 8);
    const neighbors =
      backtest?.simulatedAt !== undefined
        ? filterCausalNeighborsForBacktest(rawNeighbors, backtest.simulatedAt)
        : rawNeighbors;
    const mem = scoreFromNeighbors(neighbors, 0.72);

    let judgeInput: JudgeInput = {
      strategy: hit.strategy,
      ticker,
      triggerHint: hit.hint,
      niftyContext: ctx.niftyTrendHint,
      newsHeadlines: ctx.newsHeadlines,
    };

    if (hit.strategy === "ORB_15M") {
      judgeInput = {
        ...judgeInput,
        similarPatternsSummary: mem.useMemory
          ? `Memory: ~${(mem.pWin * 100).toFixed(0)}% win in similar setups`
          : undefined,
      };
    } else if (hit.strategy === "BIG_BOY_SWEEP") {
      judgeInput = {
        ...judgeInput,
        similarPatternsSummary: neighbors.length
          ? neighbors
              .slice(0, 3)
              .map(
                (n) =>
                  `${n.meta.outcome} ${n.meta.pnl_percent}% @ ${n.meta.date}`
              )
              .join("; ")
          : "No close historical fakeouts indexed",
      };
    } else {
      judgeInput = {
        ...judgeInput,
        similarPatternsSummary: mem.useMemory
          ? `Z-score regime memory pWin~${mem.pWin.toFixed(2)}`
          : undefined,
      };
    }

    const judgeModel =
      backtest?.judgeModel ??
      (backtest ? env.judgeModelBacktest : undefined);

    const top = neighbors[0];
    const pineconeGate =
      !backtest &&
      env.pineconeGateEnabled &&
      top !== undefined &&
      top.score >= env.pineconeGateMinScore &&
      top.meta.outcome === "WIN";

    const skipJudgeMode =
      backtest?.skipJudge === true || (!backtest && env.liveSkipJudge);

    let judge: JudgeResult;
    if (skipJudgeMode) {
      judge = {
        approve: true,
        confidence: 0.5,
        reasoning: backtest?.skipJudge
          ? "skipJudge: technical trigger auto-approved (LLM bypassed)"
          : "LIVE_SKIP_JUDGE: technical trigger auto-approved (LLM bypassed)",
      };
    } else if (pineconeGate) {
      judge = {
        approve: true,
        confidence: Math.min(0.99, top.score),
        reasoning: `PINECONE_MATCH id=${top.id} score=${top.score.toFixed(
          4
        )} outcome=${top.meta.outcome}`,
      };
    } else {
      judge = await callJudgeModel(judgeInput, { model: judgeModel });
    }

    if (!backtest) {
      const strategyTickerKey = `${hit.strategy}:${ticker}`;
      this.lastJudgeByStrategyTicker.set(strategyTickerKey, nowMs);
    }

    if (!backtest && env.liveDebugScans) {
      const via = skipJudgeMode
        ? "skip-judge"
        : pineconeGate
          ? "pinecone-gate"
          : "llm-judge";
      console.log(
        `[Decision] ${ticker} ${hit.strategy} ${hit.side} approve=${judge.approve} via=${via} conf=${judge.confidence.toFixed(2)} reason="${shortReason(judge.reasoning)}"`
      );
    }

    const snap = normalizeSnapshot(hit.snapshot);
    const entryTime = backtest?.simulatedAt ?? new Date();

    const doc: TradeLogDoc = {
      ticker,
      entry_time: entryTime,
      strategy: hit.strategy as StrategyId,
      env: backtest ? "PAPER" : env.executionEnv,
      order_executed: false,
      technical_snapshot: snap,
      ai_confidence: judge.confidence,
      ai_reasoning: judge.reasoning,
      ...(backtest?.runId ? { backtest_run_id: backtest.runId } : {}),
    };

    const side: "BUY" | "SELL" =
      hit.side ??
      (hit.strategy === "MEAN_REV_Z"
        ? (snap.z_score_vwap ?? 0) > 0
          ? "SELL"
          : "BUY"
        : hit.strategy === "VWAP_RECLAIM_REJECT"
          ? (snap.vwap_signal ?? 1) < 0
            ? "SELL"
            : "BUY"
        : "BUY");

    const entryPrice =
      ctx.sessionCandles[ctx.sessionCandles.length - 1]?.c ?? 0;

    const doOrder =
      judge.approve &&
      checkSafety(this.safety, this.openCount) &&
      !backtest?.skipOrders;

    let liveEntryPersisted = false;
    if (doOrder) {
      doc.order_executed = true;
      doc.side = side;
      doc.entry_price = entryPrice;
      await this.broker.placePaperOrder({
        ticker,
        side,
        qty: 1,
        strategy: hit.strategy,
      });
      if (!backtest && env.liveDebugScans) {
        console.log(
          `[Entry] ${ticker} ${hit.strategy} ${side} @ ${entryPrice.toFixed(2)}`
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
        await insertTrade(doc);
        if (env.liveDebugScans) {
          console.log(
            `[Decision] ${ticker} ${hit.strategy} persisted as non-entry (approve=${judge.approve})`
          );
        }
      }
    }
  }

  private liveResultFromExit(
    pos: LivePosition,
    exitPrice: number
  ): NonNullable<TradeLogDoc["result"]> {
    const pnlRaw =
      pos.side === "BUY" ? exitPrice - pos.entryPrice : pos.entryPrice - exitPrice;
    const pnl = parseFloat(pnlRaw.toFixed(2));
    const pctBase = Math.max(1e-9, pos.entryPrice);
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

function allowedInRegime(strategy: StrategyId, regime: VolRegime): boolean {
  if (
    strategy === "ORB_15M" ||
    strategy === "ORB_RETEST_15M" ||
    strategy === "INITIAL_BALANCE_BREAK_RETEST" ||
    strategy === "VOLATILITY_CONTRACTION_BREAKOUT" ||
    strategy === "INSIDE_BAR_BREAKOUT_WITH_RETEST" ||
    strategy === "EMA20_BREAK_RETEST" ||
    strategy === "PREV_DAY_HIGH_LOW_BREAK_RETEST"
  ) {
    return regime === "LOW"
      ? env.volRegimeOrbLow
      : regime === "MID"
        ? env.volRegimeOrbMid
        : env.volRegimeOrbHigh;
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
