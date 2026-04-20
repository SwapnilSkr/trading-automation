/**
 * Reconcile unresolved PAPER trades for a date by assigning exit from the
 * latest available `ohlc_1m` close on that date.
 *
 * Usage:
 *   bun run reconcile-live-exits -- --date 2026-04-20
 *   bun run reconcile-live-exits -- --date 2026-04-20 --dry-run
 */
import "dotenv/config";
import { DateTime } from "luxon";
import type { ObjectId } from "mongodb";
import { collections, getDb } from "../db/mongo.js";
import type { Ohlc1m, TradeLogDoc, TradeOutcome } from "../types/domain.js";
import { IST } from "../time/ist.js";
import { runCli } from "./runCli.js";

function parseArgs(): { date?: string; dryRun: boolean } {
  const args = process.argv.slice(2);
  let date: string | undefined;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--date" && args[i + 1]) {
      date = args[++i];
      continue;
    }
    if (a === "--dry-run") {
      dryRun = true;
      continue;
    }
  }
  return { date, dryRun };
}

function inferOutcome(pnlPercent: number): TradeOutcome {
  if (pnlPercent > 0.1) return "WIN";
  if (pnlPercent < -0.1) return "LOSS";
  return "BREAKEVEN";
}

function computeResult(
  side: "BUY" | "SELL",
  entryPrice: number,
  exitPrice: number
): NonNullable<TradeLogDoc["result"]> {
  const pnlRaw =
    side === "BUY" ? exitPrice - entryPrice : entryPrice - exitPrice;
  const pnlPercent = (pnlRaw / Math.max(1e-9, entryPrice)) * 100;
  return {
    pnl: Number(pnlRaw.toFixed(2)),
    slippage: 0,
    outcome: inferOutcome(pnlPercent),
    pnl_percent: Number(pnlPercent.toFixed(3)),
  };
}

async function main(): Promise<void> {
  const { date, dryRun } = parseArgs();
  const day = date
    ? DateTime.fromISO(date, { zone: IST })
    : DateTime.now().setZone(IST);
  if (!day.isValid) throw new Error(`Invalid --date: ${date}`);
  const dayStr = day.toFormat("yyyy-MM-dd");

  const start = day.startOf("day").toJSDate();
  const end = day.endOf("day").toJSDate();

  const db = await getDb();
  const trades = db.collection<TradeLogDoc>(collections.trades);
  const ohlc = db.collection<Ohlc1m>(collections.ohlc1m);

  const unresolved = (await trades
    .find({
      entry_time: { $gte: start, $lte: end },
      env: "PAPER",
      order_executed: { $ne: false },
      result: { $exists: false },
      side: { $in: ["BUY", "SELL"] },
      entry_price: { $exists: true },
    })
    .sort({ entry_time: 1 })
    .toArray()) as Array<TradeLogDoc & { _id: ObjectId }>;

  if (unresolved.length === 0) {
    console.log(`[reconcile-live-exits] ${dayStr}: no unresolved PAPER trades`);
    return;
  }

  let updated = 0;
  let skippedNoBar = 0;
  for (const t of unresolved) {
    if ((t.side !== "BUY" && t.side !== "SELL") || typeof t.entry_price !== "number") {
      skippedNoBar++;
      continue;
    }
    const lastBar = await ohlc
      .find({
        ticker: t.ticker,
        ts: { $gte: t.entry_time, $lte: end },
      })
      .sort({ ts: -1 })
      .limit(1)
      .next();
    if (!lastBar) {
      skippedNoBar++;
      continue;
    }
    const result = computeResult(t.side, t.entry_price, lastBar.c);
    if (!dryRun) {
      await trades.updateOne(
        { _id: t._id },
        {
          $set: {
            exit_time: lastBar.ts,
            result,
          },
        }
      );
    }
    updated++;
  }

  console.log(
    `[reconcile-live-exits] ${dayStr}${dryRun ? " (dry-run)" : ""}`
  );
  console.log(`  unresolved considered: ${unresolved.length}`);
  console.log(`  updated exits: ${updated}`);
  console.log(`  skipped (no bar): ${skippedNoBar}`);
}

runCli(main);
