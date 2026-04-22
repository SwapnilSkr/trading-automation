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
import { ensureReplayNewsCoverage } from "../services/newsArchiveReplay.js";
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
import { currentRunMode } from "../scheduler/mode.js";
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
  missingDays: MissingDayStatus[];
}

interface MissingDayStatus {
  date: string;
  reasons: string[];
}

interface SentinelSuggestion {
  action:
    | "prepare"
    | "replay-day"
    | "replay-range"
    | "analyst"
    | "discovery"
    | "repair-missing-days"
    | "wait";
  reason: string;
}

type MainMenuAction =
  | "refresh"
  | "suggested"
  | "repair-missing-days"
  | "change-date"
  | "prepare"
  | "replay-day"
  | "replay-range"
  | "analyst"
  | "discovery"
  | "help"
  | "exit";

interface MenuEntry {
  action: MainMenuAction;
  label: string;
  aliases: string[];
}

const MAIN_MENU: MenuEntry[] = [
  {
    action: "refresh",
    label: "Refresh status",
    aliases: ["refresh", "r", "status", "s"],
  },
  {
    action: "suggested",
    label: "Run suggested action (sentinel)",
    aliases: ["next", "sentinel", "suggest", "auto"],
  },
  {
    action: "repair-missing-days",
    label: "Repair missing trading days (guided)",
    aliases: ["repair", "repair-missing", "repair-all"],
  },
  {
    action: "change-date",
    label: "Change date context",
    aliases: ["date", "d", "change"],
  },
  {
    action: "prepare",
    label: "Prepare/resume trading for selected date",
    aliases: ["prepare", "p", "resume"],
  },
  {
    action: "replay-day",
    label: "Replay/backtest selected date",
    aliases: ["replay", "backtest", "day"],
  },
  {
    action: "replay-range",
    label: "Replay/backtest a custom date range",
    aliases: ["range", "replay-range", "backtest-range"],
  },
  {
    action: "analyst",
    label: "Run analyst for selected date",
    aliases: ["analyst", "a", "lesson"],
  },
  {
    action: "discovery",
    label: "Run nightly discovery from selected date",
    aliases: ["discovery", "nightly", "n"],
  },
  {
    action: "help",
    label: "Help (quick command examples)",
    aliases: ["help", "h", "?"],
  },
  {
    action: "exit",
    label: "Exit",
    aliases: ["exit", "quit", "q"],
  },
];

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

function auditTradingDays(anchorDate: string, count: number): string[] {
  const out: string[] = [];
  let d = DateTime.fromISO(anchorDate, { zone: IST });
  if (anchorDate === istDateString()) d = d.minus({ days: 1 });
  while (out.length < count) {
    if (isIndianWeekday(d)) out.push(d.toFormat("yyyy-MM-dd"));
    d = d.minus({ days: 1 });
  }
  return out.reverse();
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
  const missingDays = await loadMissingTradingDays(date);
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
    missingDays,
  };
}

async function evaluateMissingDay(date: string): Promise<MissingDayStatus | null> {
  const db = await getDb();
  const reasons: string[] = [];
  const { from, to } = dayRange(date);
  const snapshot = await getWatchlistSnapshotForEffectiveDate(date);
  const tickers = snapshot?.tickers ?? [];

  if (tickers.length === 0) {
    reasons.push("watchlist_snapshot");
  }

  const archiveCount = await db.collection(collections.newsArchive).countDocuments({
    ts: { $gte: from, $lte: to },
  });
  if (archiveCount === 0) {
    reasons.push("news_archive");
  } else if (archiveCount < env.backtestNewsMinHeadlinesPerDay) {
    reasons.push(
      `news_archive_weak(${archiveCount}<${env.backtestNewsMinHeadlinesPerDay})`
    );
  }

  if (tickers.length > 0) {
    const coverage = await loadCoverage(tickers, date);
    const weak = coverage.filter((r) => r.bars < 30).length;
    if (weak > 0) reasons.push(`ohlc_coverage(${weak}/${coverage.length} weak)`);
  } else {
    reasons.push("ohlc_coverage(unchecked:no_snapshot)");
  }

  const backtestRows = await db.collection(collections.tradesBacktest).countDocuments({
    entry_time: { $gte: from, $lte: to },
  });
  if (backtestRows === 0) reasons.push("backtest_rows");

  const lesson = await fetchLessonForDate(date);
  if (!lesson) reasons.push("analyst_lesson");

  if (reasons.length === 0) return null;
  return { date, reasons };
}

async function loadMissingTradingDays(anchorDate: string): Promise<MissingDayStatus[]> {
  const lookback = Math.max(1, Math.floor(env.opsMissingTradingDaysLookback));
  const days = auditTradingDays(anchorDate, lookback);
  const checks = await Promise.all(days.map((d) => evaluateMissingDay(d)));
  return checks.filter((c): c is MissingDayStatus => Boolean(c));
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

  if (s.missingDays.length > 0) {
    console.log(
      `  missing trading days (last ${env.opsMissingTradingDaysLookback}):`
    );
    for (const m of s.missingDays.slice(0, 6)) {
      console.log(`    ${m.date} -> ${m.reasons.join(", ")}`);
    }
    if (s.missingDays.length > 6) {
      console.log(`    ... and ${s.missingDays.length - 6} more`);
    }
  } else {
    console.log(
      `  missing trading days: none (last ${env.opsMissingTradingDaysLookback} checked)`
    );
  }

  const suggestion = suggestNextAction(s);
  const actionLabel =
    suggestion.action === "wait" ? "wait" : `${suggestion.action} (menu action)`;
  console.log(`  ops-sentinel:       ${actionLabel} — ${suggestion.reason}`);
}

function suggestNextAction(s: DailyStatus): SentinelSuggestion {
  const today = istDateString();
  const weakCoverage = s.coverage.filter((r) => r.bars < 30).length;
  const hasSnapshot = Boolean(s.snapshot?.tickers?.length);
  const hasNews = s.newsContextPresent;
  const hasLesson = s.lessonPresent;
  const hasBacktest = s.backtestTrades > 0;
  const activeOk = activeWatchlistStatus(s) === "OK";
  const mode = currentRunMode();
  const now = nowIST();

  if (s.date !== today) {
    if (!hasSnapshot) {
      return {
        action: "discovery",
        reason: "No watchlist snapshot for this date. Build snapshot first.",
      };
    }
    if (weakCoverage > 0) {
      return {
        action: "prepare",
        reason: `${weakCoverage} ticker(s) have weak OHLC coverage. Sync/repair first.`,
      };
    }
    if (!hasBacktest) {
      return {
        action: "replay-day",
        reason: "No replay rows for this date. Run replay/backtest.",
      };
    }
    if (!hasLesson) {
      return {
        action: "analyst",
        reason: "Replay exists but analyst lesson is missing.",
      };
    }
    return {
      action: "wait",
      reason: "Historical date looks complete (snapshot, coverage, replay, lesson).",
    };
  }

  if (s.missingDays.length > 0) {
    return {
      action: "repair-missing-days",
      reason: `${s.missingDays.length} recent trading day(s) have missing artifacts.`,
    };
  }

  if (!hasSnapshot || !hasNews || weakCoverage > 0 || !activeOk) {
    return {
      action: "prepare",
      reason: "Today is not fully prepared (snapshot/news/coverage/watchlist).",
    };
  }

  if (mode === "EXECUTION") {
    return {
      action: "wait",
      reason: "Execution window active. Keep daemon running and monitor health.",
    };
  }
  if (mode === "SYNC") {
    return {
      action: "wait",
      reason: "Sync window active. Daemon handles OHLC sync in-loop.",
    };
  }
  if (mode === "POST_MORTEM") {
    return {
      action: "wait",
      reason: "Post-mortem window active. Daemon handles discovery/evening jobs.",
    };
  }
  if (now.hour >= 15 && now.minute >= 50 && !hasLesson) {
    return {
      action: "analyst",
      reason: "Market is closed and lesson is missing; run analyst now.",
    };
  }
  return {
    action: "wait",
    reason: "No urgent repair needed right now.",
  };
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

function parseMenuInput(raw: string): MainMenuAction | undefined {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return "refresh";
  const numeric = Number(trimmed);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= MAIN_MENU.length) {
    return MAIN_MENU[numeric - 1]!.action;
  }
  for (const entry of MAIN_MENU) {
    if (entry.aliases.includes(trimmed)) return entry.action;
  }
  return undefined;
}

function printMenu(currentDate: string): void {
  console.log(`\nOperator menu (date=${currentDate})`);
  for (let i = 0; i < MAIN_MENU.length; i++) {
    console.log(`  ${i + 1}. ${MAIN_MENU[i]!.label}`);
  }
  console.log("  Tip: press Enter to refresh, or type aliases like `sentinel`, `repair`, `date`, `replay`, `range`, `help`.");
}

function printHelp(): void {
  console.log("\n[ops] quick examples:");
  console.log("  1            # refresh status");
  console.log("  2            # run suggested action (sentinel)");
  console.log("  3            # repair missing days (guided)");
  console.log("  4            # change date context");
  console.log("  6            # replay selected date");
  console.log("  7            # replay custom range");
  console.log("  replay       # same as replay selected date");
  console.log("  range        # same as replay custom range");
  console.log("  repair       # same as repair missing days");
  console.log("  date         # same as change date");
  console.log("  sentinel     # same as option 2");
  console.log("  help");
}

async function repairMissingDays(
  rl: ReturnType<typeof createInterface>,
  anchorDate: string
): Promise<void> {
  const missing = await loadMissingTradingDays(anchorDate);
  if (missing.length === 0) {
    console.log(
      `[ops] no missing days found in last ${env.opsMissingTradingDaysLookback} trading days`
    );
    return;
  }
  console.log(
    `[ops] found ${missing.length} missing trading day(s); starting oldest -> newest repair`
  );
  for (const day of missing) {
    console.log(`\n[ops] ${day.date} missing: ${day.reasons.join(", ")}`);
    const mode = (
      await ask(rl, "Action [auto/prepare/replay/analyst/skip/quit]", "auto")
    )
      .trim()
      .toLowerCase();
    if (mode === "quit" || mode === "q") {
      console.log("[ops] repair flow stopped by operator");
      return;
    }
    if (mode === "skip") continue;
    if (mode === "prepare") {
      await prepareTradingDay(rl, day.date);
    } else if (mode === "replay") {
      await replayDay(rl, day.date);
    } else if (mode === "analyst") {
      await runAnalystForDate(day.date);
    } else {
      if (
        day.reasons.some((r) =>
          r.startsWith("watchlist_snapshot") ||
          r.startsWith("ohlc_coverage") ||
          r.startsWith("news_archive")
        )
      ) {
        await prepareTradingDay(rl, day.date);
      }
      const postPrepare = await evaluateMissingDay(day.date);
      if (postPrepare?.reasons.some((r) => r.startsWith("backtest_rows"))) {
        await replayDay(rl, day.date);
      }
      const postReplay = await evaluateMissingDay(day.date);
      if (postReplay?.reasons.some((r) => r.startsWith("analyst_lesson"))) {
        await runAnalystForDate(day.date);
      }
    }
    const after = await evaluateMissingDay(day.date);
    if (!after) {
      console.log(`[ops] ${day.date} repaired`);
    } else {
      console.log(
        `[ops] ${day.date} still missing: ${after.reasons.join(", ")}`
      );
    }
  }
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
    let judgeModelOverride = "";
    if (!skipJudge) {
      const report = await ensureReplayNewsCoverage({
        from: date,
        to: date,
        logPrefix: "[ops][news]",
      });
      console.log(
        `[ops] replay news coverage: ${report.coveredDays.length}/${report.expectedWeekdays.length} day(s), missing=${report.missingDays.length}, weak=${report.weakDays.length} (min=${report.minHeadlinesPerDay})`
      );
      judgeModelOverride = (
        await ask(rl, "Judge model override (Enter = env default)", "")
      ).trim();
    }
    const summary = await runBacktestReplay({
      from: date,
      to: date,
      tickers: env.watchedTickers,
      stepMinutes: Number.isFinite(step) && step > 0 ? Math.floor(step) : 15,
      judgeModel: judgeModelOverride || undefined,
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

async function replayRange(
  rl: ReturnType<typeof createInterface>,
  dateFallback: string
): Promise<void> {
  const from = await ask(rl, "From date (YYYY-MM-DD)", dateFallback);
  const to = await ask(rl, "To date (YYYY-MM-DD)", dateFallback);
  validateDate(from);
  validateDate(to);
  await recordOperation("replay-range", from, async () => {
    const step = Number(await ask(rl, "Replay scan interval minutes", "15"));
    const skipJudge = await confirm(rl, "Skip LLM judge for replay?", true);
    let judgeModelOverride = "";
    if (!skipJudge) {
      const report = await ensureReplayNewsCoverage({
        from,
        to,
        logPrefix: "[ops][news]",
      });
      console.log(
        `[ops] replay news coverage: ${report.coveredDays.length}/${report.expectedWeekdays.length} day(s), missing=${report.missingDays.length}, weak=${report.weakDays.length} (min=${report.minHeadlinesPerDay})`
      );
      judgeModelOverride = (
        await ask(rl, "Judge model override (Enter = env default)", "")
      ).trim();
    }
    const failOnMissingNews =
      !skipJudge &&
      (await confirm(
        rl,
        "Abort replay if historical news coverage is missing/weak?",
        false
      ));
    const args = [
      "run",
      "src/cli/backtest-snapshots.ts",
      "--",
      "--from",
      from,
      "--to",
      to,
      "--step",
      String(Number.isFinite(step) && step > 0 ? Math.floor(step) : 15),
      ...(skipJudge ? ["--skip-judge"] : []),
      ...(judgeModelOverride ? ["--judge-model", judgeModelOverride] : []),
      ...(failOnMissingNews ? ["--fail-on-missing-news"] : []),
    ];
    const r = spawnSync("bun", args, { stdio: "inherit" });
    if ((r.status ?? 1) !== 0) {
      throw new Error(`backtest-snapshots failed with status ${r.status}`);
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

async function runSuggestedAction(
  rl: ReturnType<typeof createInterface>,
  date: string,
  status: DailyStatus
): Promise<void> {
  const suggestion = suggestNextAction(status);
  if (suggestion.action === "wait") {
    console.log(`[ops] sentinel: no action needed — ${suggestion.reason}`);
    return;
  }
  console.log(
    `[ops] sentinel: running ${suggestion.action} — ${suggestion.reason}`
  );
  if (suggestion.action === "prepare") {
    await prepareTradingDay(rl, date);
    return;
  }
  if (suggestion.action === "replay-day") {
    await replayDay(rl, date);
    return;
  }
  if (suggestion.action === "replay-range") {
    await replayRange(rl, date);
    return;
  }
  if (suggestion.action === "analyst") {
    await runAnalystForDate(date);
    return;
  }
  if (suggestion.action === "discovery") {
    await runNightlyDiscoveryForDate(rl, date);
    return;
  }
  if (suggestion.action === "repair-missing-days") {
    await repairMissingDays(rl, date);
  }
}

async function interactive(date: string): Promise<void> {
  const rl = createInterface({ input, output });
  try {
    let currentDate = date;
    while (true) {
      const status = await loadDailyStatus(currentDate);
      printStatus(status);
      printMenu(currentDate);
      let raw = "";
      try {
        raw = await rl.question("Select: ");
      } catch (e) {
        const code = (e as { code?: string })?.code;
        if (code === "ERR_USE_AFTER_CLOSE") break;
        throw e;
      }
      const action = parseMenuInput(raw);
      if (!action) {
        console.log("[ops] invalid selection. Type `help` for examples.");
        continue;
      }
      if (action === "refresh") continue;
      if (action === "suggested") {
        await runSuggestedAction(rl, currentDate, status);
        continue;
      }
      if (action === "change-date") {
        currentDate = await ask(rl, "Date", currentDate);
        validateDate(currentDate);
        const next = await rl.question(
          "Next action for this date? [replay/prepare/analyst/none]: "
        );
        const n = next.trim().toLowerCase();
        if (n === "replay") {
          await replayDay(rl, currentDate);
        } else if (n === "prepare") {
          await prepareTradingDay(rl, currentDate);
        } else if (n === "analyst") {
          await runAnalystForDate(currentDate);
        }
        continue;
      }
      if (action === "repair-missing-days") {
        await repairMissingDays(rl, currentDate);
        continue;
      }
      if (action === "prepare") {
        await prepareTradingDay(rl, currentDate);
        continue;
      }
      if (action === "replay-day") {
        await replayDay(rl, currentDate);
        continue;
      }
      if (action === "replay-range") {
        await replayRange(rl, currentDate);
        continue;
      }
      if (action === "analyst") {
        await runAnalystForDate(currentDate);
        continue;
      }
      if (action === "discovery") {
        await runNightlyDiscoveryForDate(rl, currentDate);
        continue;
      }
      if (action === "help") {
        printHelp();
        continue;
      }
      if (action === "exit") break;
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
