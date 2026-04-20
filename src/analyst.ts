/**
 * Evening post-mortem entrypoint (PM2 cron recommended).
 * Two focused judge calls: winners (incl. breakeven + open) vs losers.
 */
import "dotenv/config";
import { callJudgeModel } from "./ai/judge.js";
import {
  ensureIndexes,
  tradesForDay,
  upsertLesson,
} from "./db/repositories.js";
import type { TradeLogDoc } from "./types/domain.js";
import { istDateString, nowIST } from "./time/ist.js";
import { runCli } from "./cli/runCli.js";

function tradeLine(t: TradeLogDoc): string {
  const oc = t.result?.outcome ?? "OPEN";
  const pnl =
    t.result?.pnl !== undefined ? String(t.result.pnl) : "n/a";
  const pct =
    t.result?.pnl_percent !== undefined
      ? `${t.result.pnl_percent.toFixed(2)}%`
      : "n/a";
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
  const profitFactor = sumLossAbs > 0 ? sumWin / sumLossAbs : Number.POSITIVE_INFINITY;
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
  return rows
    .sort((a, b) => a.pnl - b.pnl)
    .slice(0, limit);
}

function formatMetricBlock(
  date: string,
  trades: TradeLogDoc[],
  overall: MetricSnapshot
): string {
  const worstStrategies = topByPnl(trades, "strategy", 5);
  const worstTickers = topByPnl(trades, "ticker", 5);
  const pfStr = Number.isFinite(overall.profitFactor)
    ? overall.profitFactor.toFixed(2)
    : "∞";
  const outcomeLabel = overall.totalPnl < 0 ? "LOSING_DAY" : overall.totalPnl > 0 ? "WINNING_DAY" : "FLAT_DAY";

  const ws = worstStrategies
    .map(
      (r) =>
        `${r.key}: pnl=${r.pnl.toFixed(0)} exits=${r.exits} wr=${r.winRate.toFixed(
          1
        )}% pf=${Number.isFinite(r.pf) ? r.pf.toFixed(2) : "∞"}`
    )
    .join(" | ");
  const wt = worstTickers
    .map(
      (r) =>
        `${r.key}: pnl=${r.pnl.toFixed(0)} exits=${r.exits} wr=${r.winRate.toFixed(
          1
        )}% pf=${Number.isFinite(r.pf) ? r.pf.toFixed(2) : "∞"}`
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

async function main(): Promise<void> {
  await ensureIndexes();
  const date = istDateString(nowIST().minus({ days: 0 }));
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

  console.log("[Analyst] Lesson saved for", date);
}

runCli(main);
