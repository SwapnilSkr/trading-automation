/**
 * bun run monte-carlo-report -- [--run-id bt-123] [--last] [--iters 1000]
 *
 * Randomizes completed backtest trade order to estimate drawdown distribution.
 */
import "dotenv/config";
import { collections, getDb } from "../db/mongo.js";
import type { TradeLogDoc } from "../types/domain.js";
import { runCli } from "./runCli.js";

function parseArgs(): { runId?: string; last: boolean; iters: number } {
  const args = process.argv.slice(2);
  let runId: string | undefined;
  let last = false;
  let iters = 1000;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--run-id" && args[i + 1]) runId = args[++i]!;
    else if (args[i] === "--last") last = true;
    else if (args[i] === "--iters" && args[i + 1]) iters = Math.max(1, Number(args[++i]!));
  }
  return { runId, last, iters };
}

function maxDrawdown(pnls: number[]): number {
  let peak = 0;
  let cum = 0;
  let dd = 0;
  for (const p of pnls) {
    cum += p;
    peak = Math.max(peak, cum);
    dd = Math.max(dd, peak - cum);
  }
  return dd;
}

function shuffle(xs: number[]): number[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const db = await getDb();
  const col = db.collection<TradeLogDoc>(collections.tradesBacktest);
  let filter: Record<string, unknown> = {};
  let label = "all backtest trades";

  if (args.runId) {
    filter = { backtest_run_id: args.runId };
    label = args.runId;
  } else if (args.last) {
    const latest = await col
      .find({ backtest_run_id: { $exists: true } })
      .sort({ entry_time: -1 })
      .limit(1)
      .toArray();
    if (!latest[0]?.backtest_run_id) throw new Error("No backtest run found.");
    filter = { backtest_run_id: latest[0].backtest_run_id };
    label = latest[0].backtest_run_id;
  }

  const rows = await col.find(filter).sort({ entry_time: 1 }).toArray();
  const pnls = rows.map((r) => r.result?.pnl).filter((p): p is number => p !== undefined);
  if (pnls.length === 0) {
    console.log("[monte-carlo-report] No completed trades found.");
    return;
  }

  const dds: number[] = [];
  for (let i = 0; i < args.iters; i++) dds.push(maxDrawdown(shuffle(pnls)));
  const total = pnls.reduce((s, p) => s + p, 0);
  console.log(`\n[monte-carlo-report] ${label}`);
  console.log(`  Trades:              ${pnls.length}`);
  console.log(`  Total PnL:           ₹${total.toFixed(0)}`);
  console.log(`  Actual max DD:       ₹${maxDrawdown(pnls).toFixed(0)}`);
  console.log(`  MC p50 max DD:       ₹${percentile(dds, 50).toFixed(0)}`);
  console.log(`  MC p90 max DD:       ₹${percentile(dds, 90).toFixed(0)}`);
  console.log(`  MC p95 max DD:       ₹${percentile(dds, 95).toFixed(0)}`);
  console.log(`  MC p99 max DD:       ₹${percentile(dds, 99).toFixed(0)}`);
  console.log("");
}

runCli(main);
