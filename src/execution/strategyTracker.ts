import { env } from "../config/env.js";
import { fetchRecentTradesByStrategy } from "../db/repositories.js";
import type { StrategyId } from "../types/domain.js";

export interface StrategyHealth {
  strategy: StrategyId;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number;
  totalPnl: number;
  allowed: boolean;
  reason?: string;
}

const ALL_STRATEGIES: StrategyId[] = [
  "ORB_15M",
  "ORB_RETEST_15M",
  "MEAN_REV_Z",
  "BIG_BOY_SWEEP",
  "VWAP_RECLAIM_REJECT",
  "VWAP_PULLBACK_TREND",
  "PREV_DAY_HIGH_LOW_BREAK_RETEST",
  "EMA20_BREAK_RETEST",
  "VWAP_RECLAIM_CONTINUATION",
  "INITIAL_BALANCE_BREAK_RETEST",
  "VOLATILITY_CONTRACTION_BREAKOUT",
  "INSIDE_BAR_BREAKOUT_WITH_RETEST",
  "OPEN_DRIVE_PULLBACK",
  "ORB_FAKEOUT_REVERSAL",
];

/**
 * Load rolling performance for all strategies from recent trades.
 * Returns a map of strategy → health status.
 */
export async function loadStrategyHealth(): Promise<Map<StrategyId, StrategyHealth>> {
  const window = env.strategyGateWindow;
  const rows = await Promise.all(
    ALL_STRATEGIES.map(async (strategy) => {
      const trades = await fetchRecentTradesByStrategy(
        strategy,
        window,
        env.executionEnv
      );
      const exits = trades.filter((t) => t.result?.outcome);

      let wins = 0;
      let losses = 0;
      let sumWin = 0;
      let sumLoss = 0;
      let totalPnl = 0;

      for (const t of exits) {
        const outcome = t.result!.outcome;
        const pnl = t.result!.pnl;
        totalPnl += pnl;
        if (outcome === "WIN") {
          wins++;
          sumWin += pnl;
        } else if (outcome === "LOSS") {
          losses++;
          sumLoss += Math.abs(pnl);
        }
      }

      const tradeCount = exits.length;
      const winRate = tradeCount > 0 ? wins / tradeCount : 0;
      const profitFactor =
        sumLoss > 0 ? sumWin / sumLoss : sumWin > 0 ? Infinity : 0;

      // Need minimum sample size before gating kicks in
      const hasEnoughData = tradeCount >= env.strategyGateMinTrades;
      const pfOk = !hasEnoughData || profitFactor >= env.strategyGateMinPf;
      const wrOk = !hasEnoughData || winRate >= env.strategyGateMinWinRate;
      const allowed = pfOk && wrOk;

      let reason: string | undefined;
      if (!allowed) {
        const parts: string[] = [];
        if (!pfOk)
          parts.push(`PF=${profitFactor.toFixed(2)}<${env.strategyGateMinPf}`);
        if (!wrOk)
          parts.push(
            `WR=${(winRate * 100).toFixed(0)}%<${(env.strategyGateMinWinRate * 100).toFixed(0)}%`
          );
        reason = parts.join(", ");
      }

      return {
        strategy,
        trades: tradeCount,
        wins,
        losses,
        winRate,
        profitFactor,
        totalPnl,
        allowed,
        reason,
      } as StrategyHealth;
    })
  );
  return new Map(rows.map((r) => [r.strategy, r] as const));
}

/**
 * Check if a strategy is allowed to fire based on its rolling performance.
 */
export function isStrategyAllowed(
  strategy: StrategyId,
  healthMap: Map<StrategyId, StrategyHealth>
): boolean {
  if (!env.strategyAutoGateEnabled) return true;
  const health = healthMap.get(strategy);
  if (!health) return true; // Unknown strategy → allow
  return health.allowed;
}

/**
 * Get a summary string for the judge prompt.
 */
export function getStrategyTrackRecord(
  strategy: StrategyId,
  healthMap: Map<StrategyId, StrategyHealth>
): string | undefined {
  const h = healthMap.get(strategy);
  if (!h || h.trades === 0) return undefined;
  const pfStr = Number.isFinite(h.profitFactor) ? h.profitFactor.toFixed(2) : "∞";
  return `Last ${h.trades} trades: WR=${(h.winRate * 100).toFixed(0)}%, PF=${pfStr}, PnL=₹${h.totalPnl.toFixed(0)}`;
}
