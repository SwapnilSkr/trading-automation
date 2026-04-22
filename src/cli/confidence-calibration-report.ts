/**
 * bun run confidence-calibration-report -- [--source trades|backtest] [--days N] [--env PAPER|LIVE]
 *
 * Buckets AI confidence and compares it with realized outcomes.
 */
import "dotenv/config";
import { DateTime } from "luxon";
import { collections, getDb } from "../db/mongo.js";
import type { TradeLogDoc } from "../types/domain.js";
import { IST } from "../time/ist.js";
import { runCli } from "./runCli.js";

function parseArgs(): {
  source: "trades" | "backtest";
  days?: number;
  env?: "PAPER" | "LIVE";
  field: "raw" | "final";
} {
  const args = process.argv.slice(2);
  let source: "trades" | "backtest" = "trades";
  let days: number | undefined;
  let envMode: "PAPER" | "LIVE" | undefined;
  let field: "raw" | "final" = "raw";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--source" && args[i + 1]) {
      const v = args[++i]!;
      if (v === "backtest") source = "backtest";
      if (v === "trades") source = "trades";
    } else if (args[i] === "--days" && args[i + 1]) {
      days = Math.max(1, Number(args[++i]!));
    } else if (args[i] === "--env" && args[i + 1]) {
      const v = args[++i]!.toUpperCase();
      if (v === "PAPER" || v === "LIVE") envMode = v;
    } else if (args[i] === "--field" && args[i + 1]) {
      const v = args[++i]!.toLowerCase();
      if (v === "raw" || v === "final") field = v;
    }
  }
  return { source, days, env: envMode, field };
}

function bucket(confidence: number): string {
  const lo = Math.floor(Math.max(0, Math.min(0.999, confidence)) * 10) / 10;
  return `${lo.toFixed(1)}-${(lo + 0.1).toFixed(1)}`;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const db = await getDb();
  const collectionName =
    args.source === "backtest" ? collections.tradesBacktest : collections.trades;
  const filter: Record<string, unknown> = {
    order_executed: true,
    "result.outcome": { $exists: true },
  };
  if (args.env && args.source === "trades") filter.env = args.env;
  if (args.days) {
    const start = DateTime.now()
      .setZone(IST)
      .minus({ days: args.days - 1 })
      .startOf("day")
      .toJSDate();
    filter.entry_time = { $gte: start };
  }

  const rows = await db
    .collection<TradeLogDoc>(collectionName)
    .find(filter)
    .sort({ entry_time: 1 })
    .toArray();

  const byBucket = new Map<string, { total: number; wins: number; pnl: number }>();
  const byVia = new Map<string, { total: number; wins: number; pnl: number }>();
  for (const r of rows) {
    const conf =
      args.field === "raw"
        ? r.ai_confidence_raw ?? r.ai_confidence ?? 0
        : r.ai_confidence ?? 0;
    const b = bucket(conf);
    const cur = byBucket.get(b) ?? { total: 0, wins: 0, pnl: 0 };
    cur.total++;
    if (r.result?.outcome === "WIN") cur.wins++;
    cur.pnl += r.result?.pnl ?? 0;
    byBucket.set(b, cur);

    const via = r.shadow_eval?.layer2_via ?? "unknown";
    const viaRow = byVia.get(via) ?? { total: 0, wins: 0, pnl: 0 };
    viaRow.total++;
    if (r.result?.outcome === "WIN") viaRow.wins++;
    viaRow.pnl += r.result?.pnl ?? 0;
    byVia.set(via, viaRow);
  }

  console.log(`\n[confidence-calibration-report] source=${args.source}${args.env ? ` env=${args.env}` : ""} field=${args.field}`);
  console.log(`  Completed trades: ${rows.length}`);
  console.log("\n  Confidence bucket   Trades   WinRate   PnL");
  for (const [b, s] of [...byBucket.entries()].sort((a, b2) => a[0].localeCompare(b2[0]))) {
    const wr = s.total > 0 ? (s.wins / s.total) * 100 : 0;
    console.log(`  ${b.padEnd(18)} ${String(s.total).padStart(6)}   ${wr.toFixed(1).padStart(6)}%   ₹${s.pnl.toFixed(0)}`);
  }
  if (byVia.size > 0) {
    console.log("\n  Decision path        Trades   WinRate   PnL");
    for (const [via, s] of [...byVia.entries()].sort((a, b2) => b2[1].total - a[1].total)) {
      const wr = s.total > 0 ? (s.wins / s.total) * 100 : 0;
      console.log(`  ${via.padEnd(18)} ${String(s.total).padStart(6)}   ${wr.toFixed(1).padStart(6)}%   ₹${s.pnl.toFixed(0)}`);
    }
  }
  console.log("");
}

runCli(main);
