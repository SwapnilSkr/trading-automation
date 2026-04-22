import { DateTime } from "luxon";
import { collections, getDb } from "../db/mongo.js";
import { fetchTradesInRange } from "../db/repositories.js";
import { env } from "../config/env.js";
import type { TradeLogDoc } from "../types/domain.js";
import { IST, nowIST } from "../time/ist.js";

export interface ValidationKpis {
  decisions: number;
  executed: number;
  executionRate: number;
  activeDays: number;
  losingDays: number;
  losingDayPct: number;
  worstDailyLoss: number;
  replayTrades: number;
  replayProfitFactor: number;
}

export interface ValidationTargets {
  execRateMin: number;
  execRateMax: number;
  losingDayPctMax: number;
  replayPfMin: number;
  maxDailyLoss: number;
}

export interface ValidationChecks {
  execRateOk: boolean;
  losingDayPctOk: boolean;
  replayPfOk: boolean;
  maxDailyLossOk: boolean;
}

export interface Phase8ValidationReport {
  from: Date;
  to: Date;
  lookbackDays: number;
  executionEnv: "PAPER" | "LIVE";
  backtestRunId?: string;
  kpis: ValidationKpis;
  targets: ValidationTargets;
  checks: ValidationChecks;
  pass: boolean;
}

function computeReplayPf(rows: TradeLogDoc[]): number {
  let sumWin = 0;
  let sumLoss = 0;
  for (const r of rows) {
    const outcome = r.result?.outcome;
    const pnl = r.result?.pnl ?? 0;
    if (outcome === "WIN") sumWin += Math.max(0, pnl);
    else if (outcome === "LOSS") sumLoss += Math.abs(pnl);
  }
  if (sumLoss > 0) return sumWin / sumLoss;
  return sumWin > 0 ? Infinity : 0;
}

function dayKey(ts: Date): string {
  return DateTime.fromJSDate(ts, { zone: IST }).toFormat("yyyy-MM-dd");
}

export async function buildPhase8ValidationReport(options?: {
  lookbackDays?: number;
  executionEnv?: "PAPER" | "LIVE";
  backtestRunId?: string;
  useLatestBacktestRun?: boolean;
}): Promise<Phase8ValidationReport> {
  const lookbackDays = Math.max(
    1,
    options?.lookbackDays ?? env.phase8ValidationLookbackDays
  );
  const executionEnv = options?.executionEnv ?? env.executionEnv;
  const to = nowIST().toJSDate();
  const from = nowIST().minus({ days: lookbackDays }).toJSDate();
  const trades = await fetchTradesInRange(from, to, executionEnv);

  const decisions = trades.length;
  const executedRows = trades.filter((t) => t.order_executed === true);
  const executed = executedRows.length;
  const executionRate = decisions > 0 ? executed / decisions : 0;

  const pnlByDay = new Map<string, number>();
  for (const t of executedRows) {
    if (!t.result || t.result.pnl === undefined) continue;
    const key = dayKey(t.entry_time);
    pnlByDay.set(key, (pnlByDay.get(key) ?? 0) + t.result.pnl);
  }
  const activeDays = pnlByDay.size;
  const dayPnls = [...pnlByDay.values()];
  const losingDays = dayPnls.filter((p) => p < 0).length;
  const losingDayPct = activeDays > 0 ? losingDays / activeDays : 0;
  const worstDailyLoss = dayPnls.length > 0 ? Math.abs(Math.min(...dayPnls, 0)) : 0;

  const db = await getDb();
  let backtestRunId = options?.backtestRunId;
  if (!backtestRunId && options?.useLatestBacktestRun !== false) {
    const latest = await db
      .collection<TradeLogDoc>(collections.tradesBacktest)
      .find({ backtest_run_id: { $exists: true } })
      .sort({ entry_time: -1 })
      .limit(1)
      .toArray();
    backtestRunId = latest[0]?.backtest_run_id;
  }
  const backtestFilter: Record<string, unknown> = backtestRunId
    ? { backtest_run_id: backtestRunId }
    : { entry_time: { $gte: from, $lte: to } };
  const replayRows = await db
    .collection<TradeLogDoc>(collections.tradesBacktest)
    .find(backtestFilter)
    .toArray();
  const replayTrades = replayRows.filter((r) => r.result?.outcome !== undefined).length;
  const replayProfitFactor = computeReplayPf(replayRows);

  const targets: ValidationTargets = {
    execRateMin: env.phase8TargetExecRateMin,
    execRateMax: env.phase8TargetExecRateMax,
    losingDayPctMax: env.phase8TargetLosingDayPctMax,
    replayPfMin: env.phase8TargetReplayPfMin,
    maxDailyLoss: env.phase8TargetMaxDailyLoss,
  };
  const checks: ValidationChecks = {
    execRateOk:
      executionRate >= targets.execRateMin && executionRate <= targets.execRateMax,
    losingDayPctOk: losingDayPct <= targets.losingDayPctMax,
    replayPfOk: replayTrades > 0 && replayProfitFactor >= targets.replayPfMin,
    maxDailyLossOk: worstDailyLoss <= targets.maxDailyLoss,
  };
  const pass =
    checks.execRateOk &&
    checks.losingDayPctOk &&
    checks.replayPfOk &&
    checks.maxDailyLossOk;

  return {
    from,
    to,
    lookbackDays,
    executionEnv,
    backtestRunId,
    kpis: {
      decisions,
      executed,
      executionRate,
      activeDays,
      losingDays,
      losingDayPct,
      worstDailyLoss,
      replayTrades,
      replayProfitFactor,
    },
    targets,
    checks,
    pass,
  };
}
