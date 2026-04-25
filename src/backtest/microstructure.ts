import { env } from "../config/env.js";
import type { Ohlc1m } from "../types/domain.js";

export interface BacktestRealismConfig {
  enabled: boolean;
  entryLatencyBars: number;
  pessimisticIntrabar: boolean;
  spreadBps: number;
  baseSlippageBps: number;
  impactBpsPer1PctParticipation: number;
  volatilityBpsCoeff: number;
  feesEnabled: boolean;
  brokeragePct: number;
  brokerageCapPerOrder: number;
  sttSellPct: number;
  exchangeTxnPct: number;
  sebiPct: number;
  gstPct: number;
  stampDutyBuyPct: number;
}

export function getBacktestRealismConfig(): BacktestRealismConfig {
  return {
    enabled: env.backtestRealismEnabled,
    entryLatencyBars: Math.max(0, env.backtestEntryLatencyBars),
    pessimisticIntrabar: env.backtestPessimisticIntrabar,
    spreadBps: Math.max(0, env.backtestSpreadBps),
    baseSlippageBps: Math.max(0, env.backtestBaseSlippageBps),
    impactBpsPer1PctParticipation: Math.max(0, env.backtestImpactBpsPer1PctParticipation),
    volatilityBpsCoeff: Math.max(0, env.backtestVolatilitySlippageCoeff),
    feesEnabled: env.backtestFeesEnabled,
    brokeragePct: Math.max(0, env.backtestBrokeragePct),
    brokerageCapPerOrder: Math.max(0, env.backtestBrokerageCapPerOrder),
    sttSellPct: Math.max(0, env.backtestSttSellPct),
    exchangeTxnPct: Math.max(0, env.backtestExchangeTxnPct),
    sebiPct: Math.max(0, env.backtestSebiPct),
    gstPct: Math.max(0, env.backtestGstPct),
    stampDutyBuyPct: Math.max(0, env.backtestStampDutyBuyPct),
  };
}

function estimateAdverseBps(
  bar: Ohlc1m,
  qty: number,
  cfg: BacktestRealismConfig
): number {
  const participationPct = (qty / Math.max(1, bar.v)) * 100;
  const impactBps = cfg.impactBpsPer1PctParticipation * participationPct;
  const rangeBps = ((bar.h - bar.l) / Math.max(1e-9, bar.c)) * 10_000;
  const volBps = rangeBps * cfg.volatilityBpsCoeff;
  return cfg.baseSlippageBps + impactBps + volBps;
}

/**
 * Adverse execution model:
 * - spread half paid on each side
 * - base slippage
 * - volume-impact component via participation%
 * - volatility component via bar range
 */
export function applyExecutionFill(
  referencePrice: number,
  side: "BUY" | "SELL",
  bar: Ohlc1m,
  qty: number,
  cfg: BacktestRealismConfig
): { fillPrice: number; slippageRupees: number; totalBps: number } {
  if (!cfg.enabled) {
    return { fillPrice: referencePrice, slippageRupees: 0, totalBps: 0 };
  }

  const halfSpreadBps = cfg.spreadBps / 2;
  const adverseBps = estimateAdverseBps(bar, qty, cfg);
  const totalBps = halfSpreadBps + adverseBps;
  const move = totalBps / 10_000;

  const fillPrice =
    side === "BUY"
      ? referencePrice * (1 + move)
      : referencePrice * (1 - move);

  const slippageRupees =
    side === "BUY"
      ? Math.max(0, fillPrice - referencePrice) * qty
      : Math.max(0, referencePrice - fillPrice) * qty;

  return { fillPrice, slippageRupees, totalBps };
}

/**
 * Optional limit fill at bar touch (simplified). Enable with `BACKTEST_LIMIT_TOUCH_FILL`
 * and wire from a backtest that supplies `limitPrice` when `EXECUTE_LIMIT_ORDERS` is mirrored in sim.
 * Buy: fill at `min(limitPrice, bar.h)`; sell: at `max(limitPrice, bar.l)`.
 */
export function applyLimitFillAtBarTouch(
  side: "BUY" | "SELL",
  bar: Ohlc1m,
  limitPrice: number
): number {
  if (side === "BUY") return Math.min(limitPrice, bar.h);
  return Math.max(limitPrice, bar.l);
}

export interface ChargeBreakdown {
  total: number;
  brokerage: number;
  stt: number;
  exchangeTxn: number;
  sebi: number;
  gst: number;
  stampDuty: number;
}

/**
 * Indian intraday equity-style charges approximation.
 * Values are env-configurable so you can map this to your broker plan.
 */
export function computeIntradayCharges(
  side: "BUY" | "SELL",
  entryPrice: number,
  exitPrice: number,
  qty: number,
  cfg: BacktestRealismConfig
): ChargeBreakdown {
  if (!cfg.feesEnabled) {
    return {
      total: 0,
      brokerage: 0,
      stt: 0,
      exchangeTxn: 0,
      sebi: 0,
      gst: 0,
      stampDuty: 0,
    };
  }

  const buyTurnover = (side === "BUY" ? entryPrice : exitPrice) * qty;
  const sellTurnover = (side === "BUY" ? exitPrice : entryPrice) * qty;
  const turnover = buyTurnover + sellTurnover;

  const brokerageBuy = Math.min(buyTurnover * cfg.brokeragePct, cfg.brokerageCapPerOrder);
  const brokerageSell = Math.min(
    sellTurnover * cfg.brokeragePct,
    cfg.brokerageCapPerOrder
  );
  const brokerage = brokerageBuy + brokerageSell;
  const exchangeTxn = turnover * cfg.exchangeTxnPct;
  const sebi = turnover * cfg.sebiPct;
  const stt = sellTurnover * cfg.sttSellPct;
  const stampDuty = buyTurnover * cfg.stampDutyBuyPct;
  const gst = (brokerage + exchangeTxn) * cfg.gstPct;
  const total = brokerage + exchangeTxn + sebi + stt + stampDuty + gst;

  return { total, brokerage, stt, exchangeTxn, sebi, gst, stampDuty };
}
