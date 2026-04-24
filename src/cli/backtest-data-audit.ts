/**
 * Check MongoDB coverage for backtest-snapshots replays (ohlc_1m + watchlist_snapshots).
 *
 *   bun run backtest-data-audit -- --from 2026-04-01 --to 2026-04-30
 *   bun run backtest-data-audit --   (defaults: last 45 calendar days)
 */
import "dotenv/config";
import { DateTime } from "luxon";
import { ensureIndexes } from "../db/repositories.js";
import { collections, getDb } from "../db/mongo.js";
import type { WatchlistSnapshotDoc } from "../types/domain.js";
import { IST } from "../time/ist.js";
import { runCli } from "./runCli.js";

const MIN_BARS_IDEAL = 360;
const MIN_BARS_WARN = 200;

function parseArgs(): { from: string; to: string } {
  const argv = process.argv.slice(2);
  let from = "";
  let to = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--from" && argv[i + 1]) from = argv[++i]!;
    else if (argv[i] === "--to" && argv[i + 1]) to = argv[++i]!;
  }
  if (from && to) return { from, to };
  if (!from && !to) {
    const end = DateTime.now().setZone(IST).startOf("day");
    const start = end.minus({ days: 45 });
    return { from: start.toISODate()!, to: end.toISODate()! };
  }
  throw new Error("Usage: bun run backtest-data-audit -- --from YYYY-MM-DD --to YYYY-MM-DD (both required if either set)");
}

function toIstRange(from: string, to: string): { from: Date; to: Date } {
  const f = DateTime.fromISO(from, { zone: IST });
  const t = DateTime.fromISO(to, { zone: IST });
  if (!f.isValid || !t.isValid) {
    throw new Error(`Invalid --from/--to: ${from} .. ${to}`);
  }
  return {
    from: f.startOf("day").toJSDate(),
    to: t.endOf("day").toJSDate(),
  };
}

function weekdayCountIst(from: string, to: string): number {
  let d = DateTime.fromISO(from, { zone: IST }).startOf("day");
  const end = DateTime.fromISO(to, { zone: IST }).startOf("day");
  let n = 0;
  while (d <= end) {
    const wd = d.weekday; // 1-7 Mon=1
    if (wd >= 1 && wd <= 5) n++;
    d = d.plus({ days: 1 });
  }
  return n;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const range = toIstRange(args.from, args.to);
  await ensureIndexes();
  const db = await getDb();
  const ohlc = db.collection(collections.ohlc1m);

  const [bounds] = await ohlc
    .aggregate<{ minTs: Date | null; maxTs: Date | null; total: number }>([
      {
        $group: {
          _id: null,
          minTs: { $min: "$ts" },
          maxTs: { $max: "$ts" },
          total: { $sum: 1 },
        },
      },
    ])
    .toArray();

  console.log("── Mongo: ohlc_1m (global) ──────────────────────────────────");
  if (!bounds || bounds.total === 0) {
    console.log("  No documents in ohlc_1m — backfill (sync) before any replay.\n");
  } else {
    console.log(
      `  docs:   ${bounds.total}
  ts min: ${bounds.minTs?.toISOString() ?? "n/a"}
  ts max: ${bounds.maxTs?.toISOString() ?? "n/a"}`
    );
  }

  const snaps = await db
    .collection<WatchlistSnapshotDoc>(collections.watchlistSnapshots)
    .find(
      { effective_date: { $gte: args.from, $lte: args.to } },
      { projection: { effective_date: 1, tickers: 1 } }
    )
    .sort({ effective_date: 1 })
    .toArray();

  const snapshotDates = new Set<string>();
  const tickerUniverse = new Set<string>();
  for (const s of snaps) {
    if (s.effective_date) snapshotDates.add(s.effective_date);
    for (const t of s.tickers ?? []) tickerUniverse.add(t);
  }
  const tickers = [...tickerUniverse].sort();

  console.log("\n── watchlist_snapshots in range ─────────────────────────────");
  console.log(
    `  ${args.from} .. ${args.to}  →  ${snaps.length} snapshot doc(s), ${tickers.length} unique ticker(s)`
  );
  if (snapshotDates.size) {
    const list = [...snapshotDates].sort();
    if (list.length <= 20) console.log(`  effective_date(s): ${list.join(", ")}`);
    else console.log(`  effective_date(s): ${list.length} days (first ${list[0]} … last ${list[list.length - 1]})`);
  } else {
    console.log("  (none) — backtest-snapshots will need --tickers-fallback A,B,…");
  }

  const expectWeekdays = weekdayCountIst(args.from, args.to);
  console.log(`\n  IST Mon–Fri days in range (inclusive): ${expectWeekdays}  (holidays not subtracted)`);

  if (tickers.length === 0) {
    console.log("\n── OHLC in range (no tickers from snapshots) ──────────────");
    console.log("  Pass tickers via env watched list or add watchlist_snapshots for this range.\n");
    return;
  }

  const coverageRows = await ohlc
    .aggregate<{
      _id: string;
      daysPresent: number;
      activeDays: string[];
    }>([
      {
        $match: {
          ticker: { $in: tickers },
          ts: { $gte: range.from, $lte: range.to },
        },
      },
      {
        $project: {
          ticker: 1,
          day: {
            $dateToString: { date: "$ts", format: "%Y-%m-%d", timezone: IST },
          },
        },
      },
      { $group: { _id: "$ticker", daysSet: { $addToSet: "$day" } } },
      { $project: { daysPresent: { $size: "$daysSet" }, activeDays: "$daysSet" } },
    ])
    .toArray();

  const byTicker = new Map<string, { daysPresent: number; activeDays: string[] }>();
  const allDays = new Set<string>();
  for (const r of coverageRows) {
    byTicker.set(r._id, { daysPresent: r.daysPresent, activeDays: r.activeDays });
    for (const d of r.activeDays) allDays.add(d);
  }
  const activeSessionDays = allDays.size;

  const needsSync: string[] = [];
  const covered: string[] = [];
  for (const t of tickers) {
    const days = byTicker.get(t)?.daysPresent ?? 0;
    if (activeSessionDays > 0 && days >= activeSessionDays) covered.push(t);
    else needsSync.push(t);
  }

  console.log("\n── ohlc_1m vs snapshot tickers (backtest-snapshots precheck) ─");
  console.log(
    `  unique IST days with any bar: ${activeSessionDays}  (of ${expectWeekdays} Mon–Fri calendar slots — sync may be partial on holidays)`
  );
  console.log(
    `  fully "covered" tickers (days ≥ ${activeSessionDays}): ${covered.length} / ${tickers.length}`
  );
  if (needsSync.length) {
    console.log(`  need sync (gap vs union of days): ${needsSync.join(", ")}`);
  }

  const thin: { ticker: string; day: string; bars: number }[] = [];
  const perDay = await ohlc
    .aggregate<{ _id: { ticker: string; day: string }; bars: number }>([
      {
        $match: {
          ticker: { $in: tickers },
          ts: { $gte: range.from, $lte: range.to },
        },
      },
      {
        $project: {
          ticker: 1,
          day: { $dateToString: { date: "$ts", format: "%Y-%m-%d", timezone: IST } },
        },
      },
      { $group: { _id: { ticker: "$ticker", day: "$day" }, bars: { $sum: 1 } } },
    ])
    .toArray();
  for (const r of perDay) {
    if (r.bars < MIN_BARS_WARN) {
      thin.push({ ticker: r._id.ticker, day: r._id.day, bars: r.bars });
    }
  }
  thin.sort((a, b) => a.day.localeCompare(b.day) || a.ticker.localeCompare(b.ticker));

  if (thin.length) {
    console.log(
      `\n  sessions with very few 1m bars (<${MIN_BARS_WARN} — may be half-day or bad sync):`
    );
    for (const row of thin.slice(0, 30)) {
      console.log(`    ${row.day} ${row.ticker}  ${row.bars} bars`);
    }
    if (thin.length > 30) console.log(`    … and ${thin.length - 30} more`);
  } else {
    console.log(
      `\n  per (ticker, day) bar counts: all ≥ ${MIN_BARS_WARN} in range (full session ~${MIN_BARS_IDEAL}+ 1m bars)`
    );
  }

  const oneDayOk = activeSessionDays >= 1 && covered.length === tickers.length && tickers.length > 0;
  const monthOk =
    oneDayOk &&
    activeSessionDays >= Math.min(15, expectWeekdays) &&
    !needsSync.length;

  console.log("\n── Verdict (heuristic) ────────────────────────────────────");
  if (tickers.length === 0) {
    console.log("  NO — add watchlist_snapshots or use --tickers-fallback for replay.\n");
  } else {
    console.log(
      `  Single-day style replay:  ${oneDayOk ? "likely OK" : "GAPS (sync or missing snapshots)"}`
    );
    console.log(
      `  Multi-day / month replay:  ${monthOk ? "likely OK" : "GAPS or thin history — run sync-history / discovery for range; expect ~1 IST session day per ticker per weekday"}\n`
    );
  }
}

runCli(main);
