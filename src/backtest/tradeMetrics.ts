import type { TradeLogDoc, TradeOutcome } from "../types/domain.js";

/**
 * Intraday trade-sequence PnL stats for backtest (matches backtest-analyze core math).
 */
export interface BacktestRunStats {
  /** Closed trades with PnL */
  trades: number;
  wins: number;
  losses: number;
  breakeven: number;
  totalPnl: number;
  sumWin: number;
  sumLoss: number;
  winRate: number;
  /** Gross wins / gross losses; Infinity if no losing trades but had wins */
  profitFactor: number;
  maxDrawdown: number;
  sharpeEstimate: number;
}

function maxDrawdown(pnls: number[]): number {
  let peak = 0;
  let cum = 0;
  let dd = 0;
  for (const p of pnls) {
    cum += p;
    if (cum > peak) peak = cum;
    const drawdown = peak - cum;
    if (drawdown > dd) dd = drawdown;
  }
  return dd;
}

function sharpeEstimate(pnls: number[]): number {
  if (pnls.length < 2) return 0;
  const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const variance = pnls.reduce((a, b) => a + (b - mean) ** 2, 0) / (pnls.length - 1);
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return (mean / std) * Math.sqrt(252);
}

/**
 * Summarize a list of `trades_backtest` docs (same backtest run only).
 * Uses sequential PnL for max drawdown (order matters).
 */
export function summarizeTrades(trades: TradeLogDoc[]): BacktestRunStats {
  const withResult = trades.filter((t) => t.result !== undefined);
  const pnls: number[] = [];
  let wins = 0;
  let losses = 0;
  let breakeven = 0;
  let totalPnl = 0;
  let sumWin = 0;
  let sumLoss = 0;
  for (const t of withResult) {
    const pnl = t.result!.pnl;
    const outcome = t.result!.outcome as TradeOutcome;
    totalPnl += pnl;
    pnls.push(pnl);
    if (outcome === "WIN") {
      wins++;
      sumWin += pnl;
    } else if (outcome === "LOSS") {
      losses++;
      sumLoss += Math.abs(pnl);
    } else breakeven++;
  }
  const n = withResult.length;
  const winRate = n > 0 ? wins / n : 0;
  const profitFactor =
    sumLoss > 0 ? sumWin / sumLoss : sumWin > 0 ? Number.POSITIVE_INFINITY : 0;
  return {
    trades: n,
    wins,
    losses,
    breakeven,
    totalPnl,
    sumWin,
    sumLoss,
    winRate,
    profitFactor,
    maxDrawdown: maxDrawdown(pnls),
    sharpeEstimate: sharpeEstimate(pnls),
  };
}
