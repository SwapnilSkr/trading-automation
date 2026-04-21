/**
 * bun run shadow-eval-report [-- --date YYYY-MM-DD] [-- --days N] [-- --env PAPER|LIVE]
 *
 * Summarize shadow two-layer disagreement metrics from `trades.shadow_eval`.
 */
import "dotenv/config";
import { DateTime } from "luxon";
import { collections, getDb } from "../db/mongo.js";
import type { TradeLogDoc } from "../types/domain.js";
import { IST } from "../time/ist.js";
import { runCli } from "./runCli.js";

function parseArgs(): { date?: string; days: number; env?: "PAPER" | "LIVE" } {
  const args = process.argv.slice(2);
  let date: string | undefined;
  let days = 1;
  let envMode: "PAPER" | "LIVE" | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--date" && args[i + 1]) date = args[++i]!;
    else if (args[i] === "--days" && args[i + 1]) {
      const n = Number(args[++i]!);
      if (Number.isFinite(n) && n > 0) days = Math.floor(n);
    } else if (args[i] === "--env" && args[i + 1]) {
      const raw = String(args[++i]!).toUpperCase();
      if (raw === "PAPER" || raw === "LIVE") envMode = raw;
    }
  }
  return { date, days, env: envMode };
}

function pct(num: number, den: number): string {
  if (den <= 0) return "0.0%";
  return `${((num / den) * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const { date, days, env } = parseArgs();
  const anchor = date
    ? DateTime.fromISO(date, { zone: IST })
    : DateTime.now().setZone(IST);
  if (!anchor.isValid) throw new Error(`Invalid --date: ${date}`);

  const start = anchor.startOf("day").minus({ days: Math.max(0, days - 1) });
  const end = anchor.endOf("day");

  const filter: Record<string, unknown> = {
    entry_time: { $gte: start.toJSDate(), $lte: end.toJSDate() },
    shadow_eval: { $exists: true },
  };
  if (env) filter.env = env;

  const db = await getDb();
  const col = db.collection<TradeLogDoc>(collections.trades);
  const rows = await col.find(filter).sort({ entry_time: 1 }).toArray();

  console.log(
    `[shadow-eval] Window IST: ${start.toFormat("yyyy-MM-dd")} -> ${end.toFormat("yyyy-MM-dd")}`
  );
  console.log(`[shadow-eval] Env filter: ${env ?? "ALL"}`);
  console.log(`[shadow-eval] Rows: ${rows.length}`);

  if (rows.length === 0) {
    console.log("No shadow-eval rows found. Enable SHADOW_EVAL_ENABLED=true first.");
    return;
  }

  const l1Block = rows.filter((r) => r.shadow_eval?.layer1_decision === "BLOCK").length;
  const l1Pass = rows.length - l1Block;
  const l2Approve = rows.filter((r) => r.shadow_eval?.layer2_decision === "APPROVE").length;
  const disagreed = rows.filter((r) => r.shadow_eval?.disagreed === true).length;
  const finalApprove = rows.filter((r) => r.shadow_eval?.final_decision === "APPROVE").length;
  const cfApprove = rows.filter(
    (r) => r.shadow_eval?.counterfactual_two_layer_decision === "APPROVE"
  ).length;

  console.log("\nOverall");
  console.log(`  Layer1 PASS/BLOCK: ${l1Pass}/${l1Block} (${pct(l1Block, rows.length)} blocked)`);
  console.log(`  Layer2 APPROVE: ${l2Approve}/${rows.length} (${pct(l2Approve, rows.length)})`);
  console.log(`  Final APPROVE: ${finalApprove}/${rows.length} (${pct(finalApprove, rows.length)})`);
  console.log(`  Counterfactual APPROVE(two-layer): ${cfApprove}/${rows.length} (${pct(cfApprove, rows.length)})`);
  console.log(`  Disagreement rate: ${disagreed}/${rows.length} (${pct(disagreed, rows.length)})`);

  const executed = rows.filter((r) => r.order_executed !== false);
  const executedWithExit = executed.filter((r) => r.result?.pnl !== undefined);
  const totalPnl = executedWithExit.reduce((s, r) => s + (r.result?.pnl ?? 0), 0);
  console.log("\nExecuted Trades");
  console.log(`  Executed rows: ${executed.length}`);
  console.log(`  Executed with exits: ${executedWithExit.length}`);
  console.log(`  Realized PnL (executed subset): ₹${totalPnl.toFixed(0)}`);

  const byStrategy = new Map<string, { total: number; disagreed: number; blocked: number }>();
  for (const r of rows) {
    const key = r.strategy ?? "UNKNOWN";
    const cur = byStrategy.get(key) ?? { total: 0, disagreed: 0, blocked: 0 };
    cur.total += 1;
    if (r.shadow_eval?.disagreed) cur.disagreed += 1;
    if (r.shadow_eval?.layer1_decision === "BLOCK") cur.blocked += 1;
    byStrategy.set(key, cur);
  }

  const ordered = [...byStrategy.entries()].sort((a, b) => b[1].total - a[1].total);
  console.log("\nBy Strategy");
  console.log("  Strategy                          Rows  L1Block%  Disagree%");
  for (const [strategy, s] of ordered) {
    console.log(
      `  ${strategy.padEnd(32)} ${String(s.total).padEnd(5)} ${pct(s.blocked, s.total).padEnd(8)} ${pct(s.disagreed, s.total)}`
    );
  }

  console.log("\nTip");
  console.log("  Keep SHADOW_EVAL_ENFORCE_LAYER1=false until disagreement is low and quality is acceptable.");
}

runCli(main);
