/**
 * bun run risk-report -- [--date YYYY-MM-DD] [--days N] [--env PAPER|LIVE]
 *
 * Summarizes hard risk/market gate decisions from `trades.risk_eval` and
 * `trades.market_eval`.
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
    else if (args[i] === "--days" && args[i + 1]) days = Math.max(1, Number(args[++i]!));
    else if (args[i] === "--env" && args[i + 1]) {
      const v = args[++i]!.toUpperCase();
      if (v === "PAPER" || v === "LIVE") envMode = v;
    }
  }
  return { date, days, env: envMode };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const endDay = args.date
    ? DateTime.fromISO(args.date, { zone: IST })
    : DateTime.now().setZone(IST);
  if (!endDay.isValid) throw new Error(`Invalid --date: ${args.date}`);
  const start = endDay.minus({ days: args.days - 1 }).startOf("day").toJSDate();
  const end = endDay.endOf("day").toJSDate();

  const filter: Record<string, unknown> = {
    entry_time: { $gte: start, $lte: end },
    $or: [{ risk_eval: { $exists: true } }, { market_eval: { $exists: true } }],
  };
  if (args.env) filter.env = args.env;

  const db = await getDb();
  const rows = await db
    .collection<TradeLogDoc>(collections.trades)
    .find(filter)
    .sort({ entry_time: 1 })
    .toArray();

  const blocked = rows.filter(
    (r) => r.risk_eval?.allowed === false || r.market_eval?.allowed === false
  );
  const executed = rows.filter((r) => r.order_executed !== false);
  const reasons = new Map<string, number>();
  for (const r of blocked) {
    for (const reason of [
      ...(r.risk_eval?.reasons ?? []),
      ...(r.market_eval?.reasons ?? []),
    ]) {
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
  }

  console.log(`\n[risk-report] ${DateTime.fromJSDate(start, { zone: IST }).toFormat("yyyy-MM-dd")} -> ${endDay.toFormat("yyyy-MM-dd")} IST${args.env ? ` env=${args.env}` : ""}`);
  console.log(`  Decisions with risk fields: ${rows.length}`);
  console.log(`  Blocked by hard gates:      ${blocked.length}`);
  console.log(`  Executed after gates:       ${executed.length}`);

  if (reasons.size > 0) {
    console.log("\n  Top block reasons:");
    for (const [reason, count] of [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      console.log(`  ${String(count).padStart(4)}  ${reason}`);
    }
  }
  console.log("");
}

runCli(main);
