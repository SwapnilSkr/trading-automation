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

async function main(): Promise<void> {
  await ensureIndexes();
  const date = istDateString(nowIST().minus({ days: 0 }));
  const all = await tradesForDay(date);
  const trades = all.filter((t) => t.order_executed !== false);
  const { winners, losers } = partitionTrades(trades);

  const parts: string[] = [];

  if (winners.length) {
    const judgeW = await callJudgeModel({
      strategy: "POST_MORTEM_WINNERS",
      ticker: "PORTFOLIO",
      triggerHint: `Winners / breakeven / still-open (${winners.length}):\n${winners.map(tradeLine).join("\n")}\n\nWhat went right? What to repeat?`,
    });
    parts.push(`[WINNERS]\n${judgeW.reasoning}`);
  }

  if (losers.length) {
    const judgeL = await callJudgeModel({
      strategy: "POST_MORTEM_LOSERS",
      ticker: "PORTFOLIO",
      triggerHint: `Losers (${losers.length}):\n${losers.map(tradeLine).join("\n")}\n\nWhat went wrong? What to fix in entry or risk?`,
    });
    parts.push(`[LOSERS]\n${judgeL.reasoning}`);
  }

  const summary =
    parts.length > 0
      ? parts.join("\n\n").slice(0, 4000)
      : "No executed trades logged for this session.";

  await upsertLesson({
    date,
    summary,
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
