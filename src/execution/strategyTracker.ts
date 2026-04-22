import { DateTime } from "luxon";
import { env } from "../config/env.js";
import {
  fetchRecentTradesByStrategy,
  fetchStrategyGateStates,
  upsertStrategyGateState,
  type StrategyGateStateDoc,
} from "../db/repositories.js";
import { IST, nowIST } from "../time/ist.js";
import type { StrategyId, TradeLogDoc } from "../types/domain.js";

export interface StrategyHealth {
  strategy: StrategyId;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number;
  weightedWinRate: number;
  weightedProfitFactor: number;
  totalPnl: number;
  allowed: boolean;
  reason?: string;
  gate_status?: "ENABLED" | "DISABLED" | "REENABLED";
  disabled_at?: Date;
  reenabled_at?: Date;
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

interface PerfMetrics {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number;
  weightedWinRate: number;
  weightedProfitFactor: number;
  totalPnl: number;
}

interface GateDecision {
  allowed: boolean;
  gateStatus: "ENABLED" | "DISABLED" | "REENABLED";
  reason?: string;
  disabledAt?: Date;
  reenabledAt?: Date;
}

function pfFrom(sumWin: number, sumLossAbs: number): number {
  if (sumLossAbs > 0) return sumWin / sumLossAbs;
  return sumWin > 0 ? Infinity : 0;
}

export function computeStrategyMetrics(
  exitsNewestFirst: TradeLogDoc[],
  decayEnabled: boolean,
  decayHalfLifeTrades: number
): PerfMetrics {
  const exits = [...exitsNewestFirst].sort(
    (a, b) => a.entry_time.getTime() - b.entry_time.getTime()
  );

  let wins = 0;
  let losses = 0;
  let sumWin = 0;
  let sumLoss = 0;
  let totalPnl = 0;

  let weightedWins = 0;
  let weightedLosses = 0;
  let weightedWinPnl = 0;
  let weightedLossPnl = 0;

  const halfLife = Math.max(1, decayHalfLifeTrades);
  const n = exits.length;
  for (let i = 0; i < n; i++) {
    const t = exits[i]!;
    const outcome = t.result?.outcome;
    const pnl = t.result?.pnl ?? 0;
    totalPnl += pnl;

    const ageFromNewest = n - 1 - i;
    const w = decayEnabled ? Math.pow(0.5, ageFromNewest / halfLife) : 1;
    if (outcome === "WIN") {
      wins++;
      sumWin += pnl;
      weightedWins += w;
      weightedWinPnl += Math.max(0, pnl) * w;
    } else if (outcome === "LOSS") {
      losses++;
      sumLoss += Math.abs(pnl);
      weightedLosses += w;
      weightedLossPnl += Math.abs(pnl) * w;
    }
  }

  const tradeCount = wins + losses;
  const rawWinRate = tradeCount > 0 ? wins / tradeCount : 0;
  const rawPf = pfFrom(sumWin, sumLoss);
  const weightedCount = weightedWins + weightedLosses;
  const weightedWinRate = weightedCount > 0 ? weightedWins / weightedCount : 0;
  const weightedPf = pfFrom(weightedWinPnl, weightedLossPnl);

  return {
    trades: tradeCount,
    wins,
    losses,
    winRate: rawWinRate,
    profitFactor: rawPf,
    weightedWinRate,
    weightedProfitFactor: weightedPf,
    totalPnl,
  };
}

function daysSince(date: Date, at = nowIST()): number {
  const from = DateTime.fromJSDate(date, { zone: IST }).startOf("day");
  const to = at.startOf("day");
  return Math.max(0, Math.floor(to.diff(from, "days").days));
}

function recentImprovement(
  exitsNewestFirst: TradeLogDoc[],
  cooldownElapsed: boolean
): { ok: boolean; recentPf: number; recentWr: number; reasons: string[] } {
  const reasons: string[] = [];
  if (!cooldownElapsed) reasons.push("cooldown not elapsed");

  const recentN = Math.max(1, env.strategyReenableRecentTrades);
  const recent = exitsNewestFirst.slice(0, recentN);
  const m = computeStrategyMetrics(recent, false, 1);
  const pfOk = m.profitFactor >= env.strategyReenableMinPf;
  const wrOk = m.winRate >= env.strategyReenableMinWinRate;
  if (!pfOk) reasons.push(`recent PF ${m.profitFactor.toFixed(2)}<${env.strategyReenableMinPf}`);
  if (!wrOk) {
    reasons.push(
      `recent WR ${(m.winRate * 100).toFixed(0)}%<${(env.strategyReenableMinWinRate * 100).toFixed(0)}%`
    );
  }
  return {
    ok: cooldownElapsed && pfOk && wrOk,
    recentPf: m.profitFactor,
    recentWr: m.winRate,
    reasons,
  };
}

export function evaluateStrategyGateDecision(
  strategy: StrategyId,
  metrics: PerfMetrics,
  exitsNewestFirst: TradeLogDoc[],
  prevState: StrategyGateStateDoc | undefined
): GateDecision {
  const hasEnoughData = metrics.trades >= env.strategyGateMinTrades;
  const pfForGate = env.strategyGateDecayEnabled
    ? metrics.weightedProfitFactor
    : metrics.profitFactor;
  const wrForGate = env.strategyGateDecayEnabled
    ? metrics.weightedWinRate
    : metrics.winRate;
  const pfBad = hasEnoughData && pfForGate < env.strategyGateMinPf;
  const wrBad = hasEnoughData && wrForGate < env.strategyGateMinWinRate;
  const underperforming = pfBad || wrBad;

  const disabledAt = prevState?.disabled ? prevState.disabled_at : undefined;
  const isDisabled = prevState?.disabled === true;

  if (!env.strategyAutoGateEnabled) {
    return {
      allowed: true,
      gateStatus: "ENABLED",
      reason: undefined,
      disabledAt,
      reenabledAt: prevState?.reenabled_at,
    };
  }

  if (!isDisabled) {
    if (!underperforming) {
      return {
        allowed: true,
        gateStatus: "ENABLED",
        reason: undefined,
      };
    }
    const parts: string[] = [];
    if (pfBad) parts.push(`PF=${pfForGate.toFixed(2)}<${env.strategyGateMinPf}`);
    if (wrBad) {
      parts.push(
        `WR=${(wrForGate * 100).toFixed(0)}%<${(env.strategyGateMinWinRate * 100).toFixed(0)}%`
      );
    }
    return {
      allowed: false,
      gateStatus: "DISABLED",
      reason: parts.join(", "),
      disabledAt: nowIST().toJSDate(),
    };
  }

  if (!env.strategyReenableEnabled) {
    return {
      allowed: false,
      gateStatus: "DISABLED",
      reason: prevState?.reason ?? "disabled",
      disabledAt,
    };
  }

  const cooldownDays = Math.max(0, env.strategyReenableCooldownDays);
  const cooldownElapsed =
    disabledAt !== undefined ? daysSince(disabledAt) >= cooldownDays : true;
  const improvement = recentImprovement(exitsNewestFirst, cooldownElapsed);
  if (improvement.ok) {
    return {
      allowed: true,
      gateStatus: "REENABLED",
      reason: `reenabled after cooldown ${cooldownDays}d + recent PF=${improvement.recentPf.toFixed(2)} WR=${(improvement.recentWr * 100).toFixed(0)}%`,
      disabledAt,
      reenabledAt: nowIST().toJSDate(),
    };
  }
  return {
    allowed: false,
    gateStatus: "DISABLED",
    reason: `disabled: ${improvement.reasons.join("; ")}`,
    disabledAt,
  };
}

/**
 * Load rolling performance for all strategies from recent trades.
 * Returns a map of strategy → health status.
 */
export async function loadStrategyHealth(): Promise<Map<StrategyId, StrategyHealth>> {
  const window = Math.max(env.strategyGateWindow, env.strategyReenableRecentTrades);
  const [states, metricsRows] = await Promise.all([
    fetchStrategyGateStates(),
    Promise.all(
      ALL_STRATEGIES.map(async (strategy) => {
        const trades = await fetchRecentTradesByStrategy(
          strategy,
          window,
          env.executionEnv
        );
        const exits = trades.filter((t) => t.result?.outcome);
        return { strategy, exits };
      })
    ),
  ]);

  const now = nowIST().toJSDate();
  const rows: StrategyHealth[] = [];
  for (const row of metricsRows) {
    const metrics = computeStrategyMetrics(
      row.exits,
      env.strategyGateDecayEnabled,
      env.strategyGateDecayHalfLifeTrades
    );
    const prevState = states.get(row.strategy);
    const decision = evaluateStrategyGateDecision(
      row.strategy,
      metrics,
      row.exits,
      prevState
    );

    await upsertStrategyGateState(row.strategy, {
      disabled: !decision.allowed,
      disabled_at: decision.allowed ? undefined : decision.disabledAt,
      reenabled_at: decision.gateStatus === "REENABLED" ? decision.reenabledAt : undefined,
      reason: decision.reason,
      last_metrics: {
        trades: metrics.trades,
        weighted_pf: metrics.weightedProfitFactor,
        weighted_wr: metrics.weightedWinRate,
        recent_pf: computeStrategyMetrics(
          row.exits.slice(0, Math.max(1, env.strategyReenableRecentTrades)),
          false,
          1
        ).profitFactor,
        recent_wr: computeStrategyMetrics(
          row.exits.slice(0, Math.max(1, env.strategyReenableRecentTrades)),
          false,
          1
        ).winRate,
      },
      updated_at: now,
    });

    rows.push({
      strategy: row.strategy,
      trades: metrics.trades,
      wins: metrics.wins,
      losses: metrics.losses,
      winRate: metrics.winRate,
      profitFactor: metrics.profitFactor,
      weightedWinRate: metrics.weightedWinRate,
      weightedProfitFactor: metrics.weightedProfitFactor,
      totalPnl: metrics.totalPnl,
      allowed: decision.allowed,
      reason: decision.reason,
      gate_status: decision.gateStatus,
      disabled_at: decision.disabledAt,
      reenabled_at: decision.reenabledAt,
    });
  }

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
  const pfStr = Number.isFinite(h.weightedProfitFactor)
    ? h.weightedProfitFactor.toFixed(2)
    : "∞";
  return `Last ${h.trades} trades: WR=${(h.weightedWinRate * 100).toFixed(0)}%, PF=${pfStr}, PnL=₹${h.totalPnl.toFixed(0)}`;
}
