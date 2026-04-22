import "dotenv/config";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { DateTime } from "luxon";
import { createBroker } from "../broker/factory.js";
import { env } from "../config/env.js";
import { collections, getDb } from "../db/mongo.js";
import {
  ensureIndexes,
  fetchLessonForDate,
  getNewsForDate,
  getSessionWatchlist,
  getWatchlistSnapshotForEffectiveDate,
  tradesForDay,
  upsertSessionWatchlist,
} from "../db/repositories.js";
import { runBacktestReplay } from "../backtest/BacktestOrchestrator.js";
import { runDiscoverySync } from "../services/discoveryRun.js";
import { syncOhlcForRange } from "../services/marketSync.js";
import { fetchTodayNewsContext } from "../services/news.js";
import type {
  Ohlc1m,
  OperatorRunDoc,
  TradeLogDoc,
  WatchlistSnapshotDoc,
} from "../types/domain.js";
import {
  IST,
  isIndianWeekday,
  istDateString,
  nextIndianWeekdayAfter,
  nowIST,
} from "../time/ist.js";
import { runCli } from "./runCli.js";

interface ParsedArgs {
  date: string;
  statusOnly: boolean;
  prepare: boolean;
  replay: boolean;
}

interface CoverageRow {
  ticker: string;
  bars: number;
  first?: Date;
  last?: Date;
}

interface DailyStatus {
  date: string;
  snapshot: WatchlistSnapshotDoc | null;
  activeWatchlist: Awaited<ReturnType<typeof getSessionWatchlist>>;
  newsContextPresent: boolean;
  newsArchiveCount: number;
  lessonPresent: boolean;
  trades: TradeLogDoc[];
  backtestTrades: number;
  latestBacktestRun?: string;
  coverage: CoverageRow[];
  operatorRuns: OperatorRunDoc[];
}

function parseArgs(): ParsedArgs {
  const argv = process.argv.slice(2);
  let date = istDateString();
  let statusOnly = false;
  let prepare = false;
  let replay = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--date" && argv[i + 1]) {
      date = argv[++i]!;
      continue;
    }
    if (a === "--status") statusOnly = true;
    if (a === "--prepare") prepare = true;
    if (a === "--replay") replay = true;
  }
  validateDate(date);
  return { date, statusOnly, prepare, replay };
}

function validateDate(date: string): void {
  const d = DateTime.fromISO(date, { zone: IST });
  if (!d.isValid) throw new Error(`Invalid date: ${date} (use YYYY-MM-DD)`);
}

function dayRange(date: string): { from: Date; to: Date } {
  const d = DateTime.fromISO(date, { zone: IST });
  return {
    from: d.startOf("day").toJSDate(),
    to: d.endOf("day").toJSDate(),
  };
}

function sessionRange(date: string): { from: Date; to: Date } {
  const d = DateTime.fromISO(date, { zone: IST });
  const today = istDateString();
  const end =
    date === today
      ? nowIST()
      : d.set({ hour: 15, minute: 29, second: 59, millisecond: 999 });
  return {
    from: d.set({ hour: 9, minute: 15, second: 0, millisecond: 0 }).toJSDate(),
    to: end.toJSDate(),
  };
}

function previousIndianWeekdayBefore(date: string): string {
  let d = DateTime.fromISO(date, { zone: IST }).minus({ days: 1 });
  while (!isIndianWeekday(d)) d = d.minus({ days: 1 });
  return d.toFormat("yyyy-MM-dd");
}

function statusLabel(ok: boolean): string {
  return ok ? "OK" : "MISS";
}

function activeWatchlistStatus(s: DailyStatus): string {
  if (!s.activeWatchlist?.tickers?.length) return "MISS";
  const updatedDay = DateTime.fromJSDate(s.activeWatchlist.updated_at, {
    zone: IST,
  }).toFormat("yyyy-MM-dd");
  return updatedDay < s.date ? "STALE" : "OK";
}

function numberOrInf(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : "inf";
}

async function recordOperation<T>(
  operation: string,
  date: string,
  fn: () => Promise<T>
): Promise<T> {
  const db = await getDb();
  const startedAt = new Date();
  try {
    const result = await fn();
    await db.collection<OperatorRunDoc>(collections.operatorRuns).insertOne({
      operation,
      date,
      status: "SUCCESS",
      started_at: startedAt,
      ended_at: new Date(),
    });
    return result;
  } catch (e) {
    await db.collection<OperatorRunDoc>(collections.operatorRuns).insertOne({
      operation,
      date,
      status: "FAILED",
      started_at: startedAt,
      ended_at: new Date(),
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
}

async function loadCoverage(
  tickers: string[],
  date: string
): Promise<CoverageRow[]> {
  if (tickers.length === 0) return [];
  const db = await getDb();
  const { from, to } = sessionRange(date);
  const rows = await db
    .collection<Ohlc1m>(collections.ohlc1m)
    .aggregate<{
      _id: string;
      bars: number;
      first: Date;
      last: Date;
    }>([
      {
        $match: {
          ticker: { $in: tickers },
          ts: { $gte: from, $lte: to },
        },
      },
      {
        $group: {
          _id: "$ticker",
          bars: { $sum: 1 },
          first: { $min: "$ts" },
          last: { $max: "$ts" },
        },
      },
    ])
    .toArray();
  const byTicker = new Map(rows.map((r) => [r._id, r]));
  return tickers.map((ticker) => {
    const r = byTicker.get(ticker);
    return {
      ticker,
      bars: r?.bars ?? 0,
      first: r?.first,
      last: r?.last,
    };
  });
}

async function loadDailyStatus(date: string): Promise<DailyStatus> {
  const db = await getDb();
  const { from, to } = dayRange(date);
  const snapshot = await getWatchlistSnapshotForEffectiveDate(date);
  const activeWatchlist = await getSessionWatchlist();
  const news = await getNewsForDate(date);
  const newsArchiveCount = await db.collection(collections.newsArchive).countDocuments({
    ts: { $gte: from, $lte: to },
  });
  const lesson = await fetchLessonForDate(date);
  const trades = await tradesForDay(date);
  const backtestAgg = await db
    .collection<TradeLogDoc>(collections.tradesBacktest)
    .aggregate<{ _id: string | null; n: number; latest: Date }>([
      { $match: { entry_time: { $gte: from, $lte: to } } },
      {
        $group: {
          _id: "$backtest_run_id",
          n: { $sum: 1 },
          latest: { $max: "$entry_time" },
        },
      },
      { $sort: { latest: -1 } },
    ])
    .toArray();
  const tickers =
    snapshot?.tickers?.length
      ? snapshot.tickers
      : activeWatchlist?.tickers?.length
        ? activeWatchlist.tickers
        : env.watchedTickers;
  const operatorRuns = await db
    .collection<OperatorRunDoc>(collections.operatorRuns)
    .find({ date })
    .sort({ started_at: -1 })
    .limit(10)
    .toArray();
  return {
    date,
    snapshot,
    activeWatchlist,
    newsContextPresent: Boolean(news),
    newsArchiveCount,
    lessonPresent: Boolean(lesson),
    trades,
    backtestTrades: backtestAgg.reduce((s, r) => s + r.n, 0),
    latestBacktestRun: backtestAgg[0]?._id ?? undefined,
    coverage: await loadCoverage(tickers, date),
    operatorRuns,
  };
}

function printStatus(s: DailyStatus): void {
  const executed = s.trades.filter((t) => t.order_executed !== false);
  const exited = executed.filter((t) => t.result).length;
  const pnl = executed.reduce((sum, t) => sum + (t.result?.pnl ?? 0), 0);
  const covered = s.coverage.filter((r) => r.bars >= 30).length;
  const totalBars = s.coverage.reduce((sum, r) => sum + r.bars, 0);
  const activeDate = s.activeWatchlist
    ? DateTime.fromJSDate(s.activeWatchlist.updated_at, { zone: IST }).toFormat(
        "yyyy-MM-dd HH:mm"
      )
    : "n/a";
  const activeStatus = activeWatchlistStatus(s);

  console.log(`\n[ops] Daily status ${s.date}`);
  console.log(`  watchlist_snapshot: ${statusLabel(Boolean(s.snapshot))} (${s.snapshot?.tickers.length ?? 0} tickers)`);
  console.log(`  active_watchlist:   ${activeStatus} (${s.activeWatchlist?.tickers.length ?? 0} tickers, updated ${activeDate})`);
  console.log(`  news_context:       ${statusLabel(s.newsContextPresent)}`);
  console.log(`  news_archive:       ${statusLabel(s.newsArchiveCount > 0)} (${s.newsArchiveCount} docs)`);
  console.log(`  ohlc_1m coverage:   ${covered}/${s.coverage.length} tickers >=30 bars, total bars=${totalBars}`);
  console.log(`  live trades:        entries=${executed.length} exits=${exited} pnl=${pnl.toFixed(2)}`);
  console.log(`  analyst lesson:     ${statusLabel(s.lessonPresent)}`);
  console.log(`  backtest rows:      ${s.backtestTrades}${s.latestBacktestRun ? ` latest=${s.latestBacktestRun}` : ""}`);

  if (s.coverage.length > 0) {
    const weak = s.coverage.filter((r) => r.bars < 30).slice(0, 8);
    if (weak.length > 0) {
      console.log(`  weak coverage:      ${weak.map((r) => `${r.ticker}:${r.bars}`).join(", ")}`);
    }
  }

  if (s.operatorRuns.length > 0) {
    console.log("  recent operator runs:");
    for (const r of s.operatorRuns.slice(0, 5)) {
      const at = DateTime.fromJSDate(r.started_at, { zone: IST }).toFormat("HH:mm");
      console.log(`    ${at} ${r.operation} ${r.status}${r.error ? ` (${r.error})` : ""}`);
    }
  }
}

async function choose(
  rl: ReturnType<typeof createInterface>,
  question: string,
  options: string[]
): Promise<number> {
  console.log(`\n${question}`);
  options.forEach((o, i) => console.log(`  ${i + 1}. ${o}`));
  const raw = await rl.question("Select: ");
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 1 && n <= options.length ? n - 1 : -1;
}

async function ask(
  rl: ReturnType<typeof createInterface>,
  question: string,
  fallback: string
): Promise<string> {
  const raw = await rl.question(`${question} [${fallback}]: `);
  return raw.trim() || fallback;
}

async function confirm(
  rl: ReturnType<typeof createInterface>,
  question: string,
  fallback = true
): Promise<boolean> {
  const suffix = fallback ? "Y/n" : "y/N";
  const raw = (await rl.question(`${question} (${suffix}): `)).trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "y" || raw === "yes";
}

async function createSnapshotForDate(
  date: string,
  opts: { updateCurrentSession: boolean; days: number; top: number }
): Promise<void> {
  const broker = createBroker();
  await broker.authenticate();
  const asOf = previousIndianWeekdayBefore(date);
  console.log(
    `[ops] creating watchlist snapshot effective=${date} using discovery asOf=${asOf}`
  );
  const result = await runDiscoverySync(broker, {
    days: opts.days,
    top: opts.top,
    refreshUniverseCsv: false,
    skipOhlcSync: true,
    dryRun: false,
    asOfDate: asOf,
    effectiveForDate: date,
    updateCurrentSession: opts.updateCurrentSession,
    writeSnapshot: true,
    snapshotSource: "operator_repair",
  });
  console.log(
    `[ops] snapshot ready: ${result.performers.map((p) => p.ticker).join(",")}`
  );
}

async function recoverActiveWatchlistFromSnapshot(date: string): Promise<string[]> {
  const snap = await getWatchlistSnapshotForEffectiveDate(date);
  if (!snap?.tickers?.length) return [];
  await upsertSessionWatchlist({
    _id: "current_session",
    tickers: snap.tickers,
    updated_at: new Date(),
    source: `operator_recovered_from_snapshot:${date}`,
    performers: snap.performers,
  });
  return snap.tickers;
}

async function syncDayBars(date: string, tickers: string[]): Promise<void> {
  if (tickers.length === 0) {
    console.log("[ops] no tickers to sync");
    return;
  }
  const broker = createBroker();
  await broker.authenticate();
  const range = sessionRange(date);
  console.log(
    `[ops] syncing ${tickers.length} tickers ${range.from.toISOString()} .. ${range.to.toISOString()}`
  );
  const rows = await syncOhlcForRange(broker, range.from, range.to, tickers);
  for (const r of rows) console.log(`  ${r.ticker}: ${r.bars} bars`);
}

async function prepareTradingDay(
  rl: ReturnType<typeof createInterface>,
  date: string
): Promise<void> {
  await recordOperation("prepare-trading-day", date, async () => {
    if (date === istDateString()) {
      const headlines = await fetchTodayNewsContext();
      console.log(`[ops] refreshed live news_context (${headlines.length} headlines)`);
    }

    let snap = await getWatchlistSnapshotForEffectiveDate(date);
    if (!snap?.tickers?.length) {
      const shouldCreate = await confirm(rl, "No snapshot exists. Run discovery repair now?", true);
      if (!shouldCreate) throw new Error("snapshot missing");
      const days = Number(await ask(rl, "Discovery lookback days", "5"));
      const top = Number(await ask(rl, "Top tickers", "10"));
      await createSnapshotForDate(date, {
        updateCurrentSession: date === istDateString(),
        days: Number.isFinite(days) ? days : 5,
        top: Number.isFinite(top) ? top : 10,
      });
      snap = await getWatchlistSnapshotForEffectiveDate(date);
    }

    const tickers =
      date === istDateString()
        ? await recoverActiveWatchlistFromSnapshot(date)
        : snap?.tickers ?? [];
    await syncDayBars(date, tickers.length > 0 ? tickers : snap?.tickers ?? []);
  });
}

async function replayDay(
  rl: ReturnType<typeof createInterface>,
  date: string
): Promise<void> {
  await recordOperation("replay-day", date, async () => {
    let snap = await getWatchlistSnapshotForEffectiveDate(date);
    if (!snap?.tickers?.length) {
      const shouldCreate = await confirm(rl, "No snapshot exists. Create it before replay?", true);
      if (!shouldCreate) throw new Error("snapshot missing");
      await createSnapshotForDate(date, {
        updateCurrentSession: false,
        days: 5,
        top: 10,
      });
      snap = await getWatchlistSnapshotForEffectiveDate(date);
    }
    if (!snap?.tickers?.length) throw new Error("snapshot repair did not produce tickers");

    const coverage = await loadCoverage(snap.tickers, date);
    const weak = coverage.filter((r) => r.bars < 30);
    if (weak.length > 0) {
      const shouldSync = await confirm(
        rl,
        `${weak.length}/${coverage.length} tickers have weak OHLC coverage. Sync now?`,
        true
      );
      if (shouldSync) await syncDayBars(date, snap.tickers);
    }

    const step = Number(await ask(rl, "Replay scan interval minutes", "15"));
    const skipJudge = await confirm(rl, "Skip LLM judge for replay?", true);
    const summary = await runBacktestReplay({
      from: date,
      to: date,
      tickers: env.watchedTickers,
      stepMinutes: Number.isFinite(step) && step > 0 ? Math.floor(step) : 15,
      skipJudge,
      skipOrders: true,
      persistTrades: true,
      watchlistMode: "snapshots",
    });
    console.log("[ops] replay done", summary);
    const analyze = await confirm(rl, "Run backtest analyzer for this replay?", true);
    if (analyze) {
      const r = spawnSync(
        "bun",
        ["run", "src/cli/backtest-analyze.ts", "--", "--run-id", summary.runId],
        { stdio: "inherit" }
      );
      if ((r.status ?? 1) !== 0) {
        throw new Error(`backtest-analyze failed with status ${r.status}`);
      }
    }
  });
}

async function runAnalystForDate(date: string): Promise<void> {
  await recordOperation("analyst", date, async () => {
    const r = spawnSync("bun", ["run", "src/analyst.ts", "--", "--date", date], {
      stdio: "inherit",
    });
    if ((r.status ?? 1) !== 0) {
      throw new Error(`analyst failed with status ${r.status}`);
    }
  });
}

async function runNightlyDiscoveryForDate(
  rl: ReturnType<typeof createInterface>,
  date: string
): Promise<void> {
  await recordOperation("nightly-discovery", date, async () => {
    const asOf = date;
    const effectiveFor = nextIndianWeekdayAfter(
      DateTime.fromISO(date, { zone: IST })
    ).toFormat("yyyy-MM-dd");
    const days = Number(await ask(rl, "Discovery lookback days", "5"));
    const top = Number(await ask(rl, "Top tickers", "10"));
    const broker = createBroker();
    await broker.authenticate();
    const result = await runDiscoverySync(broker, {
      days: Number.isFinite(days) ? days : 5,
      top: Number.isFinite(top) ? top : 10,
      refreshUniverseCsv: false,
      skipOhlcSync: false,
      dryRun: false,
      asOfDate: asOf,
      effectiveForDate: effectiveFor,
      updateCurrentSession: true,
      writeSnapshot: true,
      snapshotSource: "operator_nightly_discovery",
    });
    console.log(
      `[ops] nightly discovery complete effective=${result.effectiveFor}: ${result.performers.map((p) => p.ticker).join(",")}`
    );
  });
}

async function interactive(date: string): Promise<void> {
  const rl = createInterface({ input, output });
  try {
    let currentDate = date;
    while (true) {
      const status = await loadDailyStatus(currentDate);
      printStatus(status);
      const choice = await choose(rl, "Operator menu", [
        "Refresh status",
        "Change date",
        "Prepare/resume trading day",
        "Replay/backtest this day",
        "Run analyst for this day",
        "Run nightly discovery from this day",
        "Exit",
      ]);
      if (choice === 0) continue;
      if (choice === 1) {
        currentDate = await ask(rl, "Date", currentDate);
        validateDate(currentDate);
        continue;
      }
      if (choice === 2) {
        await prepareTradingDay(rl, currentDate);
        continue;
      }
      if (choice === 3) {
        await replayDay(rl, currentDate);
        continue;
      }
      if (choice === 4) {
        await runAnalystForDate(currentDate);
        continue;
      }
      if (choice === 5) {
        await runNightlyDiscoveryForDate(rl, currentDate);
        continue;
      }
      if (choice === 6) break;
      console.log("[ops] invalid selection");
    }
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  await ensureIndexes();
  if (args.statusOnly) {
    printStatus(await loadDailyStatus(args.date));
    return;
  }
  const rl = createInterface({ input, output });
  try {
    if (args.prepare) {
      await prepareTradingDay(rl, args.date);
      return;
    }
    if (args.replay) {
      await replayDay(rl, args.date);
      return;
    }
  } finally {
    rl.close();
  }
  await interactive(args.date);
}

runCli(main);
