/**
 * bun run backtest-analyze [-- --run-id bt-123] [-- --last]
 *
 * Queries `trades_backtest`, computes and prints:
 *   - Win rate, total trades, P&L
 *   - Profit factor, avg win / avg loss
 *   - Max drawdown (peak-to-trough on cumulative PnL curve)
 *   - Sharpe ratio estimate (daily PnL / stddev)
 *   - Breakdown by strategy
 */
import "dotenv/config";
import { getDb, collections } from "../db/mongo.js";
import { runCli } from "./runCli.js";
import type { TradeLogDoc, TradeOutcome } from "../types/domain.js";

function parseArgs(): { runId?: string; last: boolean } {
  const args = process.argv.slice(2);
  let runId: string | undefined;
  let last = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--run-id" && args[i + 1]) runId = args[++i]!;
    if (args[i] === "--last") last = true;
  }
  return { runId, last };
}

interface Stats {
  total: number;
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
    total: withResult.length,
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
    if (outcome === "WIN") { stats.wins++; stats.sumWin += pnl; }
    else if (outcome === "LOSS") { stats.losses++; stats.sumLoss += Math.abs(pnl); }
    else stats.breakeven++;
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
  // Annualize: ~252 trading days, each "trade" is roughly intraday
  return (mean / std) * Math.sqrt(252);
}

function printStats(label: string, stats: Stats): void {
  const winRate = stats.total > 0 ? (stats.wins / stats.total) * 100 : 0;
  const avgWin = stats.wins > 0 ? stats.sumWin / stats.wins : 0;
  const avgLoss = stats.losses > 0 ? stats.sumLoss / stats.losses : 0;
  const profitFactor = stats.sumLoss > 0 ? stats.sumWin / stats.sumLoss : Infinity;
  const dd = maxDrawdown(stats.pnls);
  const sharpe = sharpeEstimate(stats.pnls);

  console.log(`\n── ${label} ─────────────────────────────────`);
  console.log(`  Trades (with exits):  ${stats.total}  |  Wins: ${stats.wins}  Losses: ${stats.losses}  BE: ${stats.breakeven}`);
  console.log(`  Win Rate:             ${winRate.toFixed(1)}%`);
  console.log(`  Total PnL:            ₹${stats.totalPnl.toFixed(0)}`);
  console.log(`  Avg Win / Avg Loss:   ₹${avgWin.toFixed(0)} / ₹${avgLoss.toFixed(0)}`);
  console.log(`  Profit Factor:        ${Number.isFinite(profitFactor) ? profitFactor.toFixed(2) : "∞"}`);
  console.log(`  Max Drawdown:         ₹${dd.toFixed(0)}`);
  console.log(`  Sharpe (est):         ${sharpe.toFixed(2)}`);
}

async function main(): Promise<void> {
  const { runId, last } = parseArgs();

  const db = await getDb();
  const col = db.collection<TradeLogDoc>(collections.tradesBacktest);

  let filter: Record<string, unknown> = {};

  if (runId) {
    filter = { backtest_run_id: runId };
    console.log(`\n[backtest-analyze] Run: ${runId}`);
  } else if (last) {
    // Find the most recent run_id
    const latest = await col
      .find({ backtest_run_id: { $exists: true } })
      .sort({ entry_time: -1 })
      .limit(1)
      .toArray();
    if (!latest[0]?.backtest_run_id) {
      throw new Error(
        "[backtest-analyze] No backtest runs found in trades_backtest."
      );
    }
    filter = { backtest_run_id: latest[0].backtest_run_id };
    console.log(`\n[backtest-analyze] Latest run: ${latest[0].backtest_run_id}`);
  } else {
    // All backtest trades
    console.log(`\n[backtest-analyze] All backtest trades`);
  }

  const all = await col.find(filter).sort({ entry_time: 1 }).toArray();
  console.log(`  Total records:        ${all.length}  (${all.filter(t => t.result).length} with exit/PnL)`);
  const modelCounts = new Map<string, number>();
  for (const t of all) {
    const m = (t.ai_model ?? "unknown").trim() || "unknown";
    modelCounts.set(m, (modelCounts.get(m) ?? 0) + 1);
  }
  if (modelCounts.size > 0) {
    const models = [...modelCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([m, n]) => `${m} (${n})`)
      .join(", ");
    console.log(`  Judge models:         ${models}`);
  }

  if (all.length === 0) {
    console.log("  No trades found. Run backtest first.");
    return;
  }

  const overall = computeStats(all);
  printStats("OVERALL", overall);

  // Breakdown by strategy
  const byStrategy = new Map<string, TradeLogDoc[]>();
  for (const t of all) {
    const s = t.strategy ?? "UNKNOWN";
    if (!byStrategy.has(s)) byStrategy.set(s, []);
    byStrategy.get(s)!.push(t);
  }
  for (const [strat, trades] of byStrategy) {
    printStats(strat, computeStats(trades));
  }

  // Breakdown by ticker (top 10 by trade count)
  const byTicker = new Map<string, TradeLogDoc[]>();
  for (const t of all) {
    if (!byTicker.has(t.ticker)) byTicker.set(t.ticker, []);
    byTicker.get(t.ticker)!.push(t);
  }
  const topTickers = [...byTicker.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 10);

  if (topTickers.length > 0) {
    console.log("\n── TOP TICKERS BY TRADE COUNT ───────────────────");
    console.log("  Ticker         Trades  WinRate  TotalPnL  ProfitFactor");
    for (const [ticker, trades] of topTickers) {
      const s = computeStats(trades);
      const wr = s.total > 0 ? (s.wins / s.total) * 100 : 0;
      const pf = s.sumLoss > 0 ? s.sumWin / s.sumLoss : Infinity;
      console.log(
        `  ${ticker.padEnd(14)} ${String(s.total).padEnd(7)} ${wr.toFixed(1).padEnd(8)}% ₹${String(s.totalPnl.toFixed(0)).padEnd(9)} ${Number.isFinite(pf) ? pf.toFixed(2) : "∞"}`
      );
    }
  }

  console.log("\n── INTERPRETATION ───────────────────────────────");
  const pf = overall.sumLoss > 0 ? overall.sumWin / overall.sumLoss : Infinity;
  if (overall.total === 0 || overall.total < overall.wins + overall.losses) {
    console.log("  ⚠  Many trades lack exit data — run backtest with the latest code for full PnL.");
  } else if (pf < 1.0) {
    console.log("  ✗ Profit factor < 1.0 — strategy loses money. Needs signal improvement or tighter stops.");
  } else if (pf < 1.5) {
    console.log("  ⚠ Profit factor 1.0–1.5 — marginal edge. Optimize entry filters or RR ratio.");
  } else if (pf < 2.0) {
    console.log("  ✓ Profit factor 1.5–2.0 — decent edge. Focus on reducing max drawdown.");
  } else {
    console.log("  ✓✓ Profit factor > 2.0 — strong edge. Validate on unseen out-of-sample data.");
  }
  console.log("");
}

runCli(main);
