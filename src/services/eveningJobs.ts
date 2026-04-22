import { DateTime } from "luxon";
import { callJudgeModel } from "../ai/judge.js";
import { collections, getDb } from "../db/mongo.js";
import { ensureIndexes, tradesForDay, upsertLesson } from "../db/repositories.js";
import type { TradeLogDoc, TradeOutcome } from "../types/domain.js";
import { IST } from "../time/ist.js";

type LogFn = (line: string) => void;

interface LiveStats {
  totalWithResult: number;
  wins: number;
  losses: number;
  breakeven: number;
  totalPnl: number;
  sumWin: number;
  sumLoss: number;
  pnls: number[];
}

function computeLiveStats(trades: TradeLogDoc[]): LiveStats {
  const withResult = trades.filter((t) => t.result !== undefined);
  const stats: LiveStats = {
    totalWithResult: withResult.length,
    wins: 0,
    losses: 0,
    breakeven: 0,
    totalPnl: 0,
    sumWin: 0,
    sumLoss: 0,
    pnls: [],
  };
  for (const t of withResult) {
    const pnl = t.result!.pnl;
    const outcome = t.result!.outcome as TradeOutcome;
    stats.totalPnl += pnl;
    stats.pnls.push(pnl);
    if (outcome === "WIN") {
      stats.wins++;
      stats.sumWin += pnl;
    } else if (outcome === "LOSS") {
      stats.losses++;
      stats.sumLoss += Math.abs(pnl);
    } else {
      stats.breakeven++;
    }
  }
  return stats;
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

function printLiveStats(label: string, trades: TradeLogDoc[], log: LogFn): void {
  const s = computeLiveStats(trades);
  const wr = s.totalWithResult > 0 ? (s.wins / s.totalWithResult) * 100 : 0;
  const avgWin = s.wins > 0 ? s.sumWin / s.wins : 0;
  const avgLoss = s.losses > 0 ? s.sumLoss / s.losses : 0;
  const pf = s.sumLoss > 0 ? s.sumWin / s.sumLoss : s.sumWin > 0 ? Infinity : 0;
  log(``);
  log(`── ${label} ─────────────────────────────────`);
  log(`  Trades (entries):      ${trades.length}`);
  log(
    `  Trades (with exits):   ${s.totalWithResult}  |  Wins: ${s.wins}  Losses: ${s.losses}  BE: ${s.breakeven}`
  );
  log(`  Win Rate:              ${wr.toFixed(1)}%`);
  log(`  Total PnL:             ₹${s.totalPnl.toFixed(0)}`);
  log(`  Avg Win / Avg Loss:    ₹${avgWin.toFixed(0)} / ₹${avgLoss.toFixed(0)}`);
  log(`  Profit Factor:         ${Number.isFinite(pf) ? pf.toFixed(2) : "∞"}`);
  log(`  Max Drawdown:          ₹${maxDrawdown(s.pnls).toFixed(0)}`);
  log(`  Sharpe (est):          ${sharpeEstimate(s.pnls).toFixed(2)}`);
}

export async function runLiveAnalyzeForDate(date: string, log: LogFn = console.log): Promise<void> {
  const day = DateTime.fromISO(date, { zone: IST });
  if (!day.isValid) throw new Error(`Invalid date: ${date}`);
  const start = day.startOf("day").toJSDate();
  const end = day.endOf("day").toJSDate();

  const db = await getDb();
  const col = db.collection<TradeLogDoc>(collections.trades);
  const trades = await col
    .find({ entry_time: { $gte: start, $lte: end } })
    .sort({ entry_time: 1 })
    .toArray();
  const executed = trades.filter((t) => t.order_executed !== false);

  log(``);
  log(`[live-analyze] Date: ${date} (IST)`);
  log("  Counts below: executed entries only (order_executed !== false); judge-rejected rows excluded.");
  if (executed.length === 0) {
    log("  No executed live/paper trades for this date.");
    const nonEntries = trades.filter((t) => t.order_executed === false).length;
    if (nonEntries > 0) {
      log(`  Note: ${nonEntries} decision-only row(s) in DB (order_executed: false) — not in stats.`);
    }
    return;
  }

  printLiveStats("OVERALL", executed, log);
  const unresolved = executed.filter((t) => !t.result).length;
  if (unresolved > 0) {
    log(``);
    log(`  ⚠ ${unresolved} entries have no exit/result yet (open or untracked close).`);
  }

  const byStrategy = new Map<string, TradeLogDoc[]>();
  for (const t of executed) {
    const key = t.strategy ?? "UNKNOWN";
    if (!byStrategy.has(key)) byStrategy.set(key, []);
    byStrategy.get(key)!.push(t);
  }
  for (const [strategy, rows] of byStrategy) {
    printLiveStats(strategy, rows, log);
  }
}

function tradeLine(t: TradeLogDoc): string {
  const oc = t.result?.outcome ?? "OPEN";
  const pnl = t.result?.pnl !== undefined ? String(t.result.pnl) : "n/a";
  const pct =
    t.result?.pnl_percent !== undefined ? `${t.result.pnl_percent.toFixed(2)}%` : "n/a";
  return `${t.ticker} ${t.strategy} outcome=${oc} pnl=${pnl} (${pct}) conf=${t.ai_confidence.toFixed(2)} — ${t.ai_reasoning.slice(0, 100)}`;
}

function partitionTrades(trades: TradeLogDoc[]): {
  winners: TradeLogDoc[];
  losers: TradeLogDoc[];
} {
  const winners: TradeLogDoc[] = [];
  const losers: TradeLogDoc[] = [];
  for (const t of trades) {
    const o = t.result?.outcome;
    if (o === "LOSS") losers.push(t);
    else winners.push(t);
  }
  return { winners, losers };
}

interface MetricSnapshot {
  entries: number;
  exits: number;
  wins: number;
  losses: number;
  breakeven: number;
  unresolved: number;
  totalPnl: number;
  sumWin: number;
  sumLossAbs: number;
  profitFactor: number;
  winRate: number;
}

function computeMetrics(trades: TradeLogDoc[]): MetricSnapshot {
  let wins = 0;
  let losses = 0;
  let breakeven = 0;
  let unresolved = 0;
  let totalPnl = 0;
  let sumWin = 0;
  let sumLossAbs = 0;

  for (const t of trades) {
    if (!t.result) {
      unresolved++;
      continue;
    }
    totalPnl += t.result.pnl;
    if (t.result.outcome === "WIN") {
      wins++;
      sumWin += t.result.pnl;
    } else if (t.result.outcome === "LOSS") {
      losses++;
      sumLossAbs += Math.abs(t.result.pnl);
    } else {
      breakeven++;
    }
  }

  const exits = wins + losses + breakeven;
  const profitFactor =
    sumLossAbs > 0 ? sumWin / sumLossAbs : sumWin > 0 ? Number.POSITIVE_INFINITY : 0;
  const winRate = exits > 0 ? (wins / exits) * 100 : 0;

  return {
    entries: trades.length,
    exits,
    wins,
    losses,
    breakeven,
    unresolved,
    totalPnl,
    sumWin,
    sumLossAbs,
    profitFactor,
    winRate,
  };
}

function topByPnl(
  trades: TradeLogDoc[],
  key: "strategy" | "ticker",
  limit = 5
): Array<{ key: string; pnl: number; exits: number; winRate: number; pf: number }> {
  const m = new Map<string, TradeLogDoc[]>();
  for (const t of trades) {
    const k = String((t as Record<string, unknown>)[key] ?? "UNKNOWN");
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(t);
  }
  const rows = [...m.entries()].map(([k, list]) => {
    const s = computeMetrics(list);
    return {
      key: k,
      pnl: s.totalPnl,
      exits: s.exits,
      winRate: s.winRate,
      pf: s.profitFactor,
    };
  });
  return rows.sort((a, b) => a.pnl - b.pnl).slice(0, limit);
}

function formatMetricBlock(
  date: string,
  trades: TradeLogDoc[],
  overall: MetricSnapshot
): string {
  const worstStrategies = topByPnl(trades, "strategy", 5);
  const worstTickers = topByPnl(trades, "ticker", 5);
  const pfStr = Number.isFinite(overall.profitFactor) ? overall.profitFactor.toFixed(2) : "∞";
  const outcomeLabel =
    overall.totalPnl < 0 ? "LOSING_DAY" : overall.totalPnl > 0 ? "WINNING_DAY" : "FLAT_DAY";

  const ws = worstStrategies
    .map(
      (r) =>
        `${r.key}: pnl=${r.pnl.toFixed(0)} exits=${r.exits} wr=${r.winRate.toFixed(1)}% pf=${Number.isFinite(r.pf) ? r.pf.toFixed(2) : "∞"}`
    )
    .join(" | ");
  const wt = worstTickers
    .map(
      (r) =>
        `${r.key}: pnl=${r.pnl.toFixed(0)} exits=${r.exits} wr=${r.winRate.toFixed(1)}% pf=${Number.isFinite(r.pf) ? r.pf.toFixed(2) : "∞"}`
    )
    .join(" | ");

  return [
    `[METRICS]`,
    `date=${date}`,
    `headline=${outcomeLabel}`,
    `entries=${overall.entries} exits=${overall.exits} unresolved=${overall.unresolved}`,
    `wins=${overall.wins} losses=${overall.losses} be=${overall.breakeven} win_rate=${overall.winRate.toFixed(1)}%`,
    `net_pnl=₹${overall.totalPnl.toFixed(0)} profit_factor=${pfStr}`,
    `worst_strategies=${ws || "n/a"}`,
    `worst_tickers=${wt || "n/a"}`,
  ].join("\n");
}

export async function runAnalystForDate(date: string, log: LogFn = console.log): Promise<void> {
  await ensureIndexes();
  const all = await tradesForDay(date);
  const trades = all.filter((t) => t.order_executed !== false);
  const metrics = computeMetrics(trades);
  const { winners, losers } = partitionTrades(trades);

  const parts: string[] = [];
  parts.push(formatMetricBlock(date, trades, metrics));

  if (winners.length) {
    const judgeW = await callJudgeModel({
      strategy: "POST_MORTEM_ACTIONS",
      ticker: "PORTFOLIO",
      triggerHint:
        `Use the METRICS block as source of truth. ` +
        `Give 3 concrete keep-doing actions for tomorrow with thresholds.\n\n` +
        `${formatMetricBlock(date, trades, metrics)}\n\n` +
        `Sample winning/non-loss rows:\n${winners.slice(0, 25).map(tradeLine).join("\n")}`,
    });
    parts.push(`[ACTIONS_KEEP]\n${judgeW.reasoning}`);
  }

  if (losers.length) {
    const judgeL = await callJudgeModel({
      strategy: "POST_MORTEM_FIXES",
      ticker: "PORTFOLIO",
      triggerHint:
        `Use the METRICS block as source of truth. ` +
        `Give 5 concrete fixes ranked by expected impact; include exact gating/risk knobs to change.\n\n` +
        `${formatMetricBlock(date, trades, metrics)}\n\n` +
        `Sample losing rows:\n${losers.slice(0, 40).map(tradeLine).join("\n")}`,
    });
    parts.push(`[ACTIONS_FIX]\n${judgeL.reasoning}`);
  }

  const summary =
    parts.length > 0
      ? parts.join("\n\n").slice(0, 4000)
      : `${formatMetricBlock(date, trades, metrics)}\n\nNo executed trades logged for this session.`;

  await upsertLesson({
    date,
    summary,
    metrics: {
      entries: metrics.entries,
      exits: metrics.exits,
      unresolved: metrics.unresolved,
      wins: metrics.wins,
      losses: metrics.losses,
      breakeven: metrics.breakeven,
      total_pnl: Number(metrics.totalPnl.toFixed(2)),
      win_rate: Number(metrics.winRate.toFixed(2)),
      profit_factor: Number.isFinite(metrics.profitFactor)
        ? Number(metrics.profitFactor.toFixed(4))
        : Number.POSITIVE_INFINITY,
    },
    detail: JSON.stringify(
      trades.map((t) => ({
        ticker: t.ticker,
        strategy: t.strategy,
        conf: t.ai_confidence,
        outcome: t.result?.outcome ?? "OPEN",
      })),
      null,
      0
    ),
  });

  log(`[Analyst] Lesson saved for ${date}`);
}
