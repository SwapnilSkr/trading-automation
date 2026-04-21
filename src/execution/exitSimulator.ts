import type { Ohlc1m, StrategyId, TradeLogDoc, TradeOutcome } from "../types/domain.js";
import { insertBacktestTrade } from "../db/repositories.js";
import {
  applyExecutionFill,
  computeIntradayCharges,
  type BacktestRealismConfig,
} from "../backtest/microstructure.js";
import { env } from "../config/env.js";
import {
  getPartialExitPlan,
  partialTargetHit,
  partialTargetPrice,
  plannedPartialQty,
  type PartialExitReason,
} from "./partialExits.js";

export interface SimPosition {
  ticker: string;
  entryPrice: number;
  qty: number;
  remainingQty: number;
  realizedPnl: number;
  partialExits: NonNullable<TradeLogDoc["partial_exits"]>;
  completedPartialReasons: PartialExitReason[];
  entryReferencePrice?: number;
  entrySlippageRupees?: number;
  side: "BUY" | "SELL";
  strategy: StrategyId;
  entryTime: Date;
  /** Tracks the best price reached (for trailing stop) */
  peakPrice: number;
  /** ATR at time of entry for dynamic exits */
  atrAtEntry?: number;
  /** The partial trade doc — filled with exit info on close */
  doc: TradeLogDoc;
}

export interface ExitParams {
  stopPct: number;
  targetPct: number;
  trailTriggerPct: number;
  trailDistPct: number;
  pessimisticIntrabar: boolean;
  realism: BacktestRealismConfig;
}

type ExitResult =
  | { exited: true; exitPrice: number; outcome: TradeOutcome; pnlPct: number }
  | { exited: false };

/**
 * Check whether a bar triggers exit for a position.
 * Uses H for target check, L for stop check (BUY); reversed for SELL.
 * Returns the updated position with peak tracked.
 */
export function checkExitOnBar(
  pos: SimPosition,
  bar: Ohlc1m,
  params: ExitParams
): { result: ExitResult; updatedPeak: number } {
  const { stopPct, targetPct, trailTriggerPct, trailDistPct } = params;
  let peak = pos.peakPrice;

  // ATR-based exits: use ATR at entry if available, else fall back to fixed %
  const useAtr = env.atrExitsEnabled && pos.atrAtEntry !== undefined && pos.atrAtEntry > 0;
  const stopDist = useAtr
    ? pos.atrAtEntry! * env.atrStopMultiple
    : pos.entryPrice * stopPct;
  const targetDist = env.partialExitsEnabled && useAtr
    ? Infinity
    : useAtr
      ? pos.atrAtEntry! * env.atrTargetMultiple
      : pos.entryPrice * targetPct;
  const trailTriggerDist = useAtr
    ? pos.atrAtEntry! * env.atrTrailTriggerMultiple
    : pos.entryPrice * trailTriggerPct;

  if (pos.side === "BUY") {
    // Update peak
    if (bar.h > peak) peak = bar.h;

    const trailDistAbs = useAtr
      ? pos.atrAtEntry! * env.atrTrailDistMultiple
      : peak * trailDistPct;
    const stopPrice = pos.entryPrice - stopDist;
    const targetPrice = pos.entryPrice + targetDist;

    // Trailing stop: kicks in once we've moved trailTriggerDist above entry
    const trailActive = peak >= pos.entryPrice + trailTriggerDist;
    const trailStop = trailActive ? peak - trailDistAbs : 0;
    const effectiveStop = trailActive ? Math.max(stopPrice, trailStop) : stopPrice;

    const targetHit = bar.h >= targetPrice;
    const stopHit = bar.l <= effectiveStop;

    if (targetHit && stopHit) {
      const exitPrice = params.pessimisticIntrabar ? effectiveStop : targetPrice;
      const pnlPct = (exitPrice - pos.entryPrice) / pos.entryPrice;
      const outcome: TradeOutcome =
        exitPrice >= targetPrice ? "WIN" : pnlPct >= -0.001 ? "BREAKEVEN" : "LOSS";
      return { result: { exited: true, exitPrice, outcome, pnlPct }, updatedPeak: peak };
    }

    if (targetHit) {
      const pnlPct = (targetPrice - pos.entryPrice) / pos.entryPrice;
      return { result: { exited: true, exitPrice: targetPrice, outcome: "WIN", pnlPct }, updatedPeak: peak };
    }
    if (stopHit) {
      const exitPrice = effectiveStop;
      const pnlPct = (exitPrice - pos.entryPrice) / pos.entryPrice;
      const outcome: TradeOutcome = pnlPct >= -0.001 ? "BREAKEVEN" : "LOSS";
      return { result: { exited: true, exitPrice, outcome, pnlPct }, updatedPeak: peak };
    }
  } else {
    // SELL (short)
    if (bar.l < peak) peak = bar.l;

    const trailDistAbs = useAtr
      ? pos.atrAtEntry! * env.atrTrailDistMultiple
      : peak * trailDistPct;
    const stopPrice = pos.entryPrice + stopDist;
    const targetPrice = pos.entryPrice - targetDist;

    const trailActive = peak <= pos.entryPrice - trailTriggerDist;
    const trailStop = trailActive ? peak + trailDistAbs : Infinity;
    const effectiveStop = trailActive ? Math.min(stopPrice, trailStop) : stopPrice;

    const targetHit = bar.l <= targetPrice;
    const stopHit = bar.h >= effectiveStop;

    if (targetHit && stopHit) {
      const exitPrice = params.pessimisticIntrabar ? effectiveStop : targetPrice;
      const pnlPct = (pos.entryPrice - exitPrice) / pos.entryPrice;
      const outcome: TradeOutcome =
        exitPrice <= targetPrice ? "WIN" : pnlPct >= -0.001 ? "BREAKEVEN" : "LOSS";
      return { result: { exited: true, exitPrice, outcome, pnlPct }, updatedPeak: peak };
    }

    if (targetHit) {
      const pnlPct = (pos.entryPrice - targetPrice) / pos.entryPrice;
      return { result: { exited: true, exitPrice: targetPrice, outcome: "WIN", pnlPct }, updatedPeak: peak };
    }
    if (stopHit) {
      const exitPrice = effectiveStop;
      const pnlPct = (pos.entryPrice - exitPrice) / pos.entryPrice;
      const outcome: TradeOutcome = pnlPct >= -0.001 ? "BREAKEVEN" : "LOSS";
      return { result: { exited: true, exitPrice, outcome, pnlPct }, updatedPeak: peak };
    }
  }

  return { result: { exited: false }, updatedPeak: peak };
}

function applyPartialExitsOnBar(
  pos: SimPosition,
  bar: Ohlc1m,
  params: ExitParams
): SimPosition {
  if (!env.partialExitsEnabled || !pos.atrAtEntry || pos.atrAtEntry <= 0) {
    return pos;
  }

  let next = { ...pos, partialExits: [...pos.partialExits], completedPartialReasons: [...pos.completedPartialReasons] };
  for (const step of getPartialExitPlan()) {
    if (next.completedPartialReasons.includes(step.reason)) continue;
    const target = partialTargetPrice(
      next.side,
      next.entryPrice,
      next.atrAtEntry!,
      step.atrMultiple
    );
    if (!partialTargetHit(next.side, bar.h, bar.l, target)) continue;
    const qty = plannedPartialQty(next.qty, next.remainingQty, step.qtyPct);
    if (qty <= 0) {
      next.completedPartialReasons.push(step.reason);
      continue;
    }

    const closeSide: "BUY" | "SELL" = next.side === "BUY" ? "SELL" : "BUY";
    const fill = applyExecutionFill(target, closeSide, bar, qty, params.realism);
    const grossPnl =
      next.side === "BUY"
        ? (fill.fillPrice - next.entryPrice) * qty
        : (next.entryPrice - fill.fillPrice) * qty;
    const charges = computeIntradayCharges(
      next.side,
      next.entryPrice,
      fill.fillPrice,
      qty,
      params.realism
    );
    const netPnl = grossPnl - charges.total;
    const netPct = netPnl / Math.max(1e-9, next.entryPrice * qty);
    next.remainingQty = Math.max(0, next.remainingQty - qty);
    next.realizedPnl += netPnl;
    next.completedPartialReasons.push(step.reason);
    next.partialExits.push({
      ts: bar.ts,
      price: parseFloat(fill.fillPrice.toFixed(2)),
      qty,
      reason: step.reason,
      pnl: parseFloat(netPnl.toFixed(2)),
      pnl_percent: parseFloat((netPct * 100).toFixed(3)),
      remaining_qty: next.remainingQty,
    });
    next.doc.partial_exits = next.partialExits;
  }
  return next;
}

/**
 * Run bar-by-bar exit checks for all open positions.
 * Closes positions that hit stop/target and persists the completed trade doc.
 * Returns the still-open positions.
 */
export async function processBarForExits(
  positions: SimPosition[],
  bar: Ohlc1m,
  params: ExitParams,
  persist = true
): Promise<SimPosition[]> {
  const remaining: SimPosition[] = [];
  for (const pos of positions) {
    const withPartials = applyPartialExitsOnBar(pos, bar, params);
    const { result, updatedPeak } = checkExitOnBar(withPartials, bar, params);
    if (result.exited) {
      const closeSide: "BUY" | "SELL" = withPartials.side === "BUY" ? "SELL" : "BUY";
      const fill = applyExecutionFill(
        result.exitPrice,
        closeSide,
        bar,
        withPartials.remainingQty,
        params.realism
      );
      const grossPnl =
        withPartials.side === "BUY"
          ? (fill.fillPrice - withPartials.entryPrice) * withPartials.remainingQty
          : (withPartials.entryPrice - fill.fillPrice) * withPartials.remainingQty;
      const charges = computeIntradayCharges(
        withPartials.side,
        withPartials.entryPrice,
        fill.fillPrice,
        withPartials.remainingQty,
        params.realism
      );
      const netPnl = withPartials.realizedPnl + grossPnl - charges.total;
      const netPct = netPnl / Math.max(1e-9, withPartials.entryPrice * withPartials.qty);
      const slippage = (withPartials.entrySlippageRupees ?? 0) + fill.slippageRupees;
      const outcome: TradeOutcome =
        netPct > 0.001 ? "WIN" : netPct < -0.001 ? "LOSS" : "BREAKEVEN";
      withPartials.doc.exit_time = bar.ts;
      withPartials.doc.partial_exits = withPartials.partialExits;
      withPartials.doc.result = {
        pnl: parseFloat(netPnl.toFixed(2)),
        slippage: parseFloat(slippage.toFixed(2)),
        outcome,
        pnl_percent: parseFloat((netPct * 100).toFixed(3)),
        gross_pnl: parseFloat(grossPnl.toFixed(2)),
        charges: parseFloat(charges.total.toFixed(2)),
      };
      if (persist) {
        await insertBacktestTrade(withPartials.doc);
      }
    } else {
      remaining.push({ ...withPartials, peakPrice: updatedPeak });
    }
  }
  return remaining;
}

/**
 * Force-close all remaining positions at end of session (EOD).
 */
export async function closeAllAtEod(
  positions: SimPosition[],
  lastBar: Ohlc1m,
  params: ExitParams,
  persist = true
): Promise<void> {
  for (const raw of positions) {
    const pos = applyPartialExitsOnBar(raw, lastBar, params);
    const closeSide: "BUY" | "SELL" = pos.side === "BUY" ? "SELL" : "BUY";
    const fill = applyExecutionFill(
      lastBar.c,
      closeSide,
      lastBar,
      pos.remainingQty,
      params.realism
    );
    const grossPnl =
      pos.side === "BUY"
        ? (fill.fillPrice - pos.entryPrice) * pos.remainingQty
        : (pos.entryPrice - fill.fillPrice) * pos.remainingQty;
    const charges = computeIntradayCharges(
      pos.side,
      pos.entryPrice,
      fill.fillPrice,
      pos.remainingQty,
      params.realism
    );
    const netPnl = pos.realizedPnl + grossPnl - charges.total;
    const netPct = netPnl / Math.max(1e-9, pos.entryPrice * pos.qty);
    const slippage = (pos.entrySlippageRupees ?? 0) + fill.slippageRupees;
    const outcome: TradeOutcome =
      netPct > 0.001 ? "WIN" : netPct < -0.001 ? "LOSS" : "BREAKEVEN";
    pos.doc.exit_time = lastBar.ts;
    pos.doc.partial_exits = pos.partialExits;
    pos.doc.result = {
      pnl: parseFloat(netPnl.toFixed(2)),
      slippage: parseFloat(slippage.toFixed(2)),
      outcome,
      pnl_percent: parseFloat((netPct * 100).toFixed(3)),
      gross_pnl: parseFloat(grossPnl.toFixed(2)),
      charges: parseFloat(charges.total.toFixed(2)),
    };
    if (persist) {
      await insertBacktestTrade(pos.doc);
    }
  }
}
