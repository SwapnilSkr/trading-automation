/**
 * bun run walk-forward-backtest -- --from YYYY-MM-DD --to YYYY-MM-DD
 *
 * Runs sequential out-of-sample replay windows after a rolling train window.
 * This does not optimize parameters yet; it forces evaluation discipline by
 * separating warm-up/train history from each test slice.
 */
import "dotenv/config";
import { DateTime } from "luxon";
import { env } from "../config/env.js";
import { runBacktestReplay } from "../backtest/BacktestOrchestrator.js";
import { collections, getDb } from "../db/mongo.js";
import type { TradeLogDoc } from "../types/domain.js";
import { IST } from "../time/ist.js";
import { runCli } from "./runCli.js";

interface Args {
  from: string;
  to: string;
  tickers: string[];
  trainDays: number;
  testDays: number;
  step: number;
  skipJudge: boolean;
  persist: boolean;
  watchlistMode?: "static" | "snapshots";
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let from = "";
  let to = "";
  let tickers = env.watchedTickers;
  let trainDays = 30;
  let testDays = 10;
  let step = 15;
  let skipJudge = false;
  let persist = true;
  let watchlistMode: "static" | "snapshots" | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--from" && args[i + 1]) from = args[++i]!;
    else if (args[i] === "--to" && args[i + 1]) to = args[++i]!;
    else if (args[i] === "--tickers" && args[i + 1]) {
      tickers = args[++i]!.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (args[i] === "--train-days" && args[i + 1]) {
      trainDays = Math.max(1, Number(args[++i]!));
    } else if (args[i] === "--test-days" && args[i + 1]) {
      testDays = Math.max(1, Number(args[++i]!));
    } else if (args[i] === "--step" && args[i + 1]) {
      step = Math.max(1, Number(args[++i]!));
    } else if (args[i] === "--skip-judge") skipJudge = true;
    else if (args[i] === "--no-persist") persist = false;
    else if (args[i] === "--watchlist-snapshots" || args[i] === "--ticker-source") {
      if (args[i] === "--ticker-source" && args[i + 1] === "snapshots") i++;
      watchlistMode = "snapshots";
    }
  }
  if (!from || !to) throw new Error("Use --from YYYY-MM-DD --to YYYY-MM-DD");
  return { from, to, tickers, trainDays, testDays, step, skipJudge, persist, watchlistMode };
}

function summarize(rows: TradeLogDoc[]): { trades: number; pnl: number; winRate: number; pf: number } {
  const done = rows.filter((r) => r.result);
  let wins = 0;
  let sumWin = 0;
  let sumLoss = 0;
  let pnl = 0;
  for (const r of done) {
    const p = r.result!.pnl;
    pnl += p;
    if (r.result!.outcome === "WIN") {
      wins++;
      sumWin += p;
    } else if (r.result!.outcome === "LOSS") {
      sumLoss += Math.abs(p);
    }
  }
  return {
    trades: done.length,
    pnl,
    winRate: done.length > 0 ? wins / done.length : 0,
    pf: sumLoss > 0 ? sumWin / sumLoss : sumWin > 0 ? Infinity : 0,
  };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const from = DateTime.fromISO(args.from, { zone: IST }).startOf("day");
  const to = DateTime.fromISO(args.to, { zone: IST }).startOf("day");
  if (!from.isValid || !to.isValid || from >= to) throw new Error("Invalid date range.");

  const db = await getDb();
  let cursor = from.plus({ days: args.trainDays });
  const runs: string[] = [];
  console.log(`\n[walk-forward-backtest] ${args.from} -> ${args.to} train=${args.trainDays}d test=${args.testDays}d`);
  while (cursor <= to) {
    const testStart = cursor;
    const testEnd = DateTime.min(cursor.plus({ days: args.testDays - 1 }), to);
    const summary = await runBacktestReplay({
      from: testStart.toFormat("yyyy-MM-dd"),
      to: testEnd.toFormat("yyyy-MM-dd"),
      tickers: args.tickers,
      stepMinutes: args.step,
      skipJudge: args.skipJudge,
      skipOrders: true,
      persistTrades: args.persist,
      watchlistMode: args.watchlistMode,
    });
    runs.push(summary.runId);
    const rows = args.persist
      ? await db
          .collection<TradeLogDoc>(collections.tradesBacktest)
          .find({ backtest_run_id: summary.runId })
          .toArray()
      : [];
    const s = summarize(rows);
    console.log(
      `  ${testStart.toFormat("yyyy-MM-dd")} -> ${testEnd.toFormat("yyyy-MM-dd")} run=${summary.runId} trades=${s.trades} WR=${(s.winRate * 100).toFixed(1)}% PF=${Number.isFinite(s.pf) ? s.pf.toFixed(2) : "∞"} PnL=₹${s.pnl.toFixed(0)}`
    );
    cursor = testEnd.plus({ days: 1 });
  }
  console.log(`\n  Runs: ${runs.join(", ")}`);
  console.log("");
}

runCli(main);
