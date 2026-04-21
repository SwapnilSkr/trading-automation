import { env } from "../config/env.js";

export type PartialExitReason = "SCALE_1" | "SCALE_2";

export interface PartialExitPlan {
  reason: PartialExitReason;
  atrMultiple: number;
  qtyPct: number;
}

export function getPartialExitPlan(): PartialExitPlan[] {
  if (!env.partialExitsEnabled) return [];
  return [
    {
      reason: "SCALE_1",
      atrMultiple: env.partialExit1AtrMultiple,
      qtyPct: env.partialExit1QtyPct,
    },
    {
      reason: "SCALE_2",
      atrMultiple: env.partialExit2AtrMultiple,
      qtyPct: env.partialExit2QtyPct,
    },
  ];
}

export function partialTargetPrice(
  side: "BUY" | "SELL",
  entryPrice: number,
  atrAtEntry: number,
  atrMultiple: number
): number {
  const dist = atrAtEntry * atrMultiple;
  return side === "BUY" ? entryPrice + dist : entryPrice - dist;
}

export function partialTargetHit(
  side: "BUY" | "SELL",
  highOrClose: number,
  lowOrClose: number,
  targetPrice: number
): boolean {
  return side === "BUY" ? highOrClose >= targetPrice : lowOrClose <= targetPrice;
}

export function plannedPartialQty(
  initialQty: number,
  remainingQty: number,
  qtyPct: number
): number {
  if (initialQty < 3 || remainingQty <= 1) return 0;
  const planned = Math.floor(initialQty * qtyPct);
  return Math.max(0, Math.min(planned, remainingQty - 1));
}

export function pnlForExit(
  side: "BUY" | "SELL",
  entryPrice: number,
  exitPrice: number,
  qty: number
): { pnl: number; pnlPercent: number } {
  const perShare = side === "BUY" ? exitPrice - entryPrice : entryPrice - exitPrice;
  const pnl = perShare * qty;
  const pnlPercent = perShare / Math.max(1e-9, entryPrice);
  return {
    pnl: parseFloat(pnl.toFixed(2)),
    pnlPercent: parseFloat((pnlPercent * 100).toFixed(3)),
  };
}
