/**
 * bun run live-analyze [-- --date YYYY-MM-DD]
 *
 * Analyze live/paper `trades` for an IST date (default: today IST).
 */
import "dotenv/config";
import { DateTime } from "luxon";
import { collections, getDb } from "../db/mongo.js";
import type { TradeLogDoc, TradeOutcome } from "../types/domain.js";
import { IST } from "../time/ist.js";
import { runCli } from "./runCli.js";

function parseArgs(): { date?: string } {
  const args = process.argv.slice(2);
  let date: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--date" && args[i + 1]) date = args[++i]!;
  }
  return { date };
}

interface Stats {
  totalWithResult: number;
  wins: number;
  losses: number;
  breakeven: number;
  totalPnl: number;
  sumWin: number;
  sumLoss: number;
  pnls: number[];
}

function computeStats(trades: TradeLogDoc[]): Stats {
  const withResult = trades.filter((t) => t.result !== undefined);
  const stats: Stats = {
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

function printStats(label: string, trades: TradeLogDoc[]): void {
  const s = computeStats(trades);
  const wr = s.totalWithResult > 0 ? (s.wins / s.totalWithResult) * 100 : 0;
  const avgWin = s.wins > 0 ? s.sumWin / s.wins : 0;
  const avgLoss = s.losses > 0 ? s.sumLoss / s.losses : 0;
  const pf = s.sumLoss > 0 ? s.sumWin / s.sumLoss : Infinity;

  console.log(`\n── ${label} ─────────────────────────────────`);
  console.log(`  Trades (entries):      ${trades.length}`);
  console.log(`  Trades (with exits):   ${s.totalWithResult}  |  Wins: ${s.wins}  Losses: ${s.losses}  BE: ${s.breakeven}`);
  console.log(`  Win Rate:              ${wr.toFixed(1)}%`);
  console.log(`  Total PnL:             ₹${s.totalPnl.toFixed(0)}`);
  console.log(`  Avg Win / Avg Loss:    ₹${avgWin.toFixed(0)} / ₹${avgLoss.toFixed(0)}`);
  console.log(`  Profit Factor:         ${Number.isFinite(pf) ? pf.toFixed(2) : "∞"}`);
  console.log(`  Max Drawdown:          ₹${maxDrawdown(s.pnls).toFixed(0)}`);
  console.log(`  Sharpe (est):          ${sharpeEstimate(s.pnls).toFixed(2)}`);
}

async function main(): Promise<void> {
  const { date } = parseArgs();
  const day = date
    ? DateTime.fromISO(date, { zone: IST })
    : DateTime.now().setZone(IST);
  if (!day.isValid) throw new Error(`Invalid --date: ${date}`);

  const start = day.startOf("day").toJSDate();
  const end = day.endOf("day").toJSDate();
  const dayStr = day.toFormat("yyyy-MM-dd");

  const db = await getDb();
  const col = db.collection<TradeLogDoc>(collections.trades);
  const trades = await col
    .find({ entry_time: { $gte: start, $lte: end } })
    .sort({ entry_time: 1 })
    .toArray();
  const executed = trades.filter((t) => t.order_executed !== false);

  console.log(`\n[live-analyze] Date: ${dayStr} (IST)`);
  if (executed.length === 0) {
    console.log("  No live/paper trades for this date.");
    const nonEntries = trades.filter((t) => t.order_executed === false).length;
    if (nonEntries > 0) {
      console.log(`  Note: ${nonEntries} non-entry decision logs found.`);
    }
    return;
  }

  printStats("OVERALL", executed);

  const unresolved = executed.filter((t) => !t.result).length;
  if (unresolved > 0) {
    console.log(`\n  ⚠ ${unresolved} entries have no exit/result yet (open or untracked close).`);
  }

  const byStrategy = new Map<string, TradeLogDoc[]>();
  for (const t of executed) {
    const key = t.strategy ?? "UNKNOWN";
    if (!byStrategy.has(key)) byStrategy.set(key, []);
    byStrategy.get(key)!.push(t);
  }
  for (const [strategy, rows] of byStrategy) {
    printStats(strategy, rows);
  }

  const byTicker = new Map<string, TradeLogDoc[]>();
  for (const t of executed) {
    if (!byTicker.has(t.ticker)) byTicker.set(t.ticker, []);
    byTicker.get(t.ticker)!.push(t);
  }
  const top = [...byTicker.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 10);

  if (top.length > 0) {
    console.log("\n── TOP TICKERS BY TRADE COUNT ───────────────────");
    console.log("  Ticker         Entries  Exits  WinRate  TotalPnL  ProfitFactor");
    for (const [ticker, rows] of top) {
      const s = computeStats(rows);
      const wr = s.totalWithResult > 0 ? (s.wins / s.totalWithResult) * 100 : 0;
      const pf = s.sumLoss > 0 ? s.sumWin / s.sumLoss : Infinity;
      console.log(
        `  ${ticker.padEnd(14)} ${String(rows.length).padEnd(7)} ${String(s.totalWithResult).padEnd(5)} ${wr.toFixed(1).padEnd(8)}% ₹${String(s.totalPnl.toFixed(0)).padEnd(9)} ${Number.isFinite(pf) ? pf.toFixed(2) : "∞"}`
      );
    }
  }
}

runCli(main);
