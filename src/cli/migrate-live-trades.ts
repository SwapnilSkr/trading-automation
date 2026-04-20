/**
 * One-time migration for legacy live/paper rows that predate `order_executed`,
 * `side`, and `entry_price`.
 *
 * Strategy:
 * - For unresolved rows (`result` missing) where `order_executed` is missing:
 *   - Keep only the latest row per ticker as an open executed trade.
 *   - Mark older unresolved rows for that ticker as non-executed.
 * - Infer side from strategy + snapshot heuristics.
 * - Infer entry_price from nearest 1m bar around `entry_time`.
 *
 * Usage:
 *   bun run src/cli/migrate-live-trades.ts -- --date 2026-04-20
 *   bun run src/cli/migrate-live-trades.ts -- --date 2026-04-20 --dry-run
 */
import "dotenv/config";
import { DateTime } from "luxon";
import type { Collection, ObjectId } from "mongodb";
import { collections, getDb } from "../db/mongo.js";
import type { Ohlc1m, StrategyId, TradeLogDoc } from "../types/domain.js";
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

function inferSide(t: TradeLogDoc): "BUY" | "SELL" {
  const strat = t.strategy as StrategyId;
  if (strat === "MEAN_REV_Z") {
    const z = t.technical_snapshot?.z_score_vwap ?? 0;
    return z > 0 ? "SELL" : "BUY";
  }
  if (strat === "VWAP_RECLAIM_REJECT") {
    const sig = t.technical_snapshot?.vwap_signal ?? 1;
    return sig < 0 ? "SELL" : "BUY";
  }
  return "BUY";
}

async function inferEntryPrice(
  ohlc: Collection<Ohlc1m>,
  ticker: string,
  at: Date
): Promise<number | undefined> {
  const entry = DateTime.fromJSDate(at, { zone: IST });
  const before = entry.minus({ minutes: 180 }).toJSDate();
  const after = entry.plus({ minutes: 10 }).toJSDate();

  const prev = await ohlc
    .find({
      ticker,
      ts: { $lte: at, $gte: before },
    })
    .sort({ ts: -1 })
    .limit(1)
    .toArray();
  if (prev.length > 0) {
    return Number((prev[0] as Ohlc1m).c);
  }

  const next = await ohlc
    .find({
      ticker,
      ts: { $gte: at, $lte: after },
    })
    .sort({ ts: 1 })
    .limit(1)
    .toArray();
  if (next.length > 0) {
    return Number((next[0] as Ohlc1m).c);
  }

  return undefined;
}

function byEntryTimeDesc(a: TradeLogDoc, b: TradeLogDoc): number {
  return b.entry_time.getTime() - a.entry_time.getTime();
}

async function main(): Promise<void> {
  const { date, dryRun } = parseArgs();
  const day = date
    ? DateTime.fromISO(date, { zone: IST })
    : DateTime.now().setZone(IST);
  if (!day.isValid) throw new Error(`Invalid --date: ${date}`);

  const start = day.startOf("day").toJSDate();
  const end = day.endOf("day").toJSDate();
  const dayStr = day.toFormat("yyyy-MM-dd");

  const db = await getDb();
  const trades = db.collection<TradeLogDoc>(collections.trades);
  const ohlc = db.collection<Ohlc1m>(collections.ohlc1m);

  const legacy = (await trades
    .find({
      entry_time: { $gte: start, $lte: end },
      result: { $exists: false },
      order_executed: { $exists: false },
    })
    .sort({ ticker: 1, entry_time: -1 })
    .toArray()) as Array<TradeLogDoc & { _id: ObjectId }>;

  if (legacy.length === 0) {
    console.log(`[migrate-live-trades] ${dayStr}: no legacy rows to migrate`);
    return;
  }

  const byTicker = new Map<string, Array<TradeLogDoc & { _id: ObjectId }>>();
  for (const t of legacy) {
    if (!byTicker.has(t.ticker)) byTicker.set(t.ticker, []);
    byTicker.get(t.ticker)!.push(t);
  }
  for (const [, rows] of byTicker) rows.sort(byEntryTimeDesc);

  let markExecuted = 0;
  let markNonExecuted = 0;
  let entryPriceMissing = 0;

  for (const [ticker, rows] of byTicker) {
    for (let i = 0; i < rows.length; i++) {
      const t = rows[i]!;
      if (i === 0) {
        const side = inferSide(t);
        const px = await inferEntryPrice(ohlc, ticker, t.entry_time);
        if (px === undefined) entryPriceMissing++;
        if (!dryRun) {
          await trades.updateOne(
            { _id: t._id },
            {
              $set: {
                order_executed: true,
                side,
                ...(px !== undefined ? { entry_price: px } : {}),
              },
            }
          );
        }
        markExecuted++;
      } else {
        if (!dryRun) {
          await trades.updateOne(
            { _id: t._id },
            {
              $set: { order_executed: false },
            }
          );
        }
        markNonExecuted++;
      }
    }
  }

  console.log(
    `[migrate-live-trades] ${dayStr} ${dryRun ? "(dry-run)" : ""}`.trim()
  );
  console.log(`  Legacy unresolved rows: ${legacy.length}`);
  console.log(`  Marked executed: ${markExecuted}`);
  console.log(`  Marked non-executed: ${markNonExecuted}`);
  console.log(`  Executed rows missing inferred entry_price: ${entryPriceMissing}`);
}

runCli(main);
