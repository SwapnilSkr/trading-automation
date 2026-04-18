import type { Ohlc1m, StrategyId, TradeLogDoc, TradeOutcome } from "../types/domain.js";
import { insertBacktestTrade } from "../db/repositories.js";

export interface SimPosition {
  ticker: string;
  entryPrice: number;
  side: "BUY" | "SELL";
  strategy: StrategyId;
  entryTime: Date;
  /** Tracks the best price reached (for trailing stop) */
  peakPrice: number;
  /** The partial trade doc — filled with exit info on close */
  doc: TradeLogDoc;
}

export interface ExitParams {
  stopPct: number;
  targetPct: number;
  trailTriggerPct: number;
  trailDistPct: number;
  qty: number;
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

  if (pos.side === "BUY") {
    // Update peak
    if (bar.h > peak) peak = bar.h;

    const stopPrice = pos.entryPrice * (1 - stopPct);
    const targetPrice = pos.entryPrice * (1 + targetPct);

    // Trailing stop: kicks in once we've moved trailTriggerPct above entry
    const trailActive = peak >= pos.entryPrice * (1 + trailTriggerPct);
    const trailStop = trailActive ? peak * (1 - trailDistPct) : 0;
    const effectiveStop = trailActive ? Math.max(stopPrice, trailStop) : stopPrice;

    // Target hit first (check H vs L ordering within bar)
    if (bar.h >= targetPrice) {
      const pnlPct = (targetPrice - pos.entryPrice) / pos.entryPrice;
      return { result: { exited: true, exitPrice: targetPrice, outcome: "WIN", pnlPct }, updatedPeak: peak };
    }
    // Stop hit
    if (bar.l <= effectiveStop) {
      const exitPrice = effectiveStop;
      const pnlPct = (exitPrice - pos.entryPrice) / pos.entryPrice;
      const outcome: TradeOutcome = pnlPct >= -0.001 ? "BREAKEVEN" : "LOSS";
      return { result: { exited: true, exitPrice, outcome, pnlPct }, updatedPeak: peak };
    }
  } else {
    // SELL (short)
    if (bar.l < peak) peak = bar.l;

    const stopPrice = pos.entryPrice * (1 + stopPct);
    const targetPrice = pos.entryPrice * (1 - targetPct);

    const trailActive = peak <= pos.entryPrice * (1 - trailTriggerPct);
    const trailStop = trailActive ? peak * (1 + trailDistPct) : Infinity;
    const effectiveStop = trailActive ? Math.min(stopPrice, trailStop) : stopPrice;

    if (bar.l <= targetPrice) {
      const pnlPct = (pos.entryPrice - targetPrice) / pos.entryPrice;
      return { result: { exited: true, exitPrice: targetPrice, outcome: "WIN", pnlPct }, updatedPeak: peak };
    }
    if (bar.h >= effectiveStop) {
      const exitPrice = effectiveStop;
      const pnlPct = (pos.entryPrice - exitPrice) / pos.entryPrice;
      const outcome: TradeOutcome = pnlPct >= -0.001 ? "BREAKEVEN" : "LOSS";
      return { result: { exited: true, exitPrice, outcome, pnlPct }, updatedPeak: peak };
    }
  }

  return { result: { exited: false }, updatedPeak: peak };
}

/**
 * Run bar-by-bar exit checks for all open positions.
 * Closes positions that hit stop/target and persists the completed trade doc.
 * Returns the still-open positions.
 */
export async function processBarForExits(
  positions: SimPosition[],
  bar: Ohlc1m,
  params: ExitParams
): Promise<SimPosition[]> {
  const remaining: SimPosition[] = [];
  for (const pos of positions) {
    const { result, updatedPeak } = checkExitOnBar(pos, bar, params);
    if (result.exited) {
      const pnlRupees = result.pnlPct * pos.entryPrice * params.qty;
      pos.doc.exit_time = bar.ts;
      pos.doc.result = {
        pnl: parseFloat(pnlRupees.toFixed(2)),
        slippage: 0,
        outcome: result.outcome,
        pnl_percent: parseFloat((result.pnlPct * 100).toFixed(3)),
      };
      await insertBacktestTrade(pos.doc);
    } else {
      remaining.push({ ...pos, peakPrice: updatedPeak });
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
  params: ExitParams
): Promise<void> {
  for (const pos of positions) {
    const exitPrice = lastBar.c;
    const pnlPct =
      pos.side === "BUY"
        ? (exitPrice - pos.entryPrice) / pos.entryPrice
        : (pos.entryPrice - exitPrice) / pos.entryPrice;
    const pnlRupees = pnlPct * pos.entryPrice * params.qty;
    const outcome: TradeOutcome =
      pnlPct > 0.001 ? "WIN" : pnlPct < -0.001 ? "LOSS" : "BREAKEVEN";
    pos.doc.exit_time = lastBar.ts;
    pos.doc.result = {
      pnl: parseFloat(pnlRupees.toFixed(2)),
      slippage: 0,
      outcome,
      pnl_percent: parseFloat((pnlPct * 100).toFixed(3)),
    };
    await insertBacktestTrade(pos.doc);
  }
}
