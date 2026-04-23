import "dotenv/config";
import { spawn, spawnSync } from "node:child_process";
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
import { runFunnelOptimizer } from "../services/funnelOptimizer.js";
import { buildPhase8ValidationReport } from "../services/phase8Validation.js";
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
import {
  getCachedNifty50Heavyweights,
  NIFTY50_HEAVYWEIGHT_TICKERS,
  resolveNifty50HeavyweightsLive,
} from "../market/niftyHeavyweights.js";
import { runCli } from "./runCli.js";

interface ParsedArgs {
  date: string;
  statusOnly: boolean;
  prepare: boolean;
  replay: boolean;
}

interface ReplaySnapshotCommandOptions {
  from: string;
  to: string;
  step: number;
  skipJudge: boolean;
  judgeModelOverride?: string;
  failOnMissingNews: boolean;
  noClearTrades?: boolean;
  noSync?: boolean;
  envOverrides?: Record<string, string>;
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
  decisionFunnel: DecisionFunnel;
}

interface MissingDayStatus {
  date: string;
  reasons: string[];
}

interface DecisionFunnel {
  total: number;
  executed: number;
  riskVeto: number;
  cooldownJudge: number;
  cooldownRiskVeto: number;
  judgeDenyOrOther: number;
}

interface SentinelSuggestion {
  action:
    | "prepare"
    | "replay-day"
    | "replay-range"
    | "analyst"
    | "discovery"
    | "funnel-optimize"
    | "phase8-validate"
    | "repair-missing-days"
    | "wait";
  reason: string;
}

type MainMenuAction =
  | "refresh"
  | "suggested"
  | "judge-cooldown"
  | "daemon-control"
  | "repair-missing-days"
  | "change-date"
  | "prepare"
  | "replay-day"
  | "replay-range"
  | "analyst"
  | "discovery"
  | "funnel-optimize"
  | "phase8-validate"
  | "resolve-heavyweights"
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
    action: "judge-cooldown",
    label: "Judge cooldown status",
    aliases: ["cooldown", "judge-cooldown", "jc"],
  },
  {
    action: "daemon-control",
    label: "Daemon control (status / kill / start fresh)",
    aliases: ["daemon", "dctl", "restart-daemon"],
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
    action: "funnel-optimize",
    label: "Funnel optimizer (analyze / tune dominant blocker)",
    aliases: ["funnel", "tune", "optimize"],
  },
  {
    action: "phase8-validate",
    label: "Phase 8 validation (targets pass/fail)",
    aliases: ["phase8", "validate", "kpi"],
  },
  {
    action: "resolve-heavyweights",
    label: "Resolve Nifty-50 laggard heavyweights (NSE list + quotes)",
    aliases: [
      "heavyweights",
      "hw",
      "resolve-heavyweights",
      "laggard-hw",
      "laggard-weights",
    ],
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
  const decisionFunnel = computeDecisionFunnel(trades);
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
    decisionFunnel,
  };
}

function computeDecisionFunnel(trades: TradeLogDoc[]): DecisionFunnel {
  let executed = 0;
  let riskVeto = 0;
  let cooldownJudge = 0;
  let cooldownRiskVeto = 0;
  let judgeDenyOrOther = 0;

  for (const t of trades) {
    if (t.order_executed === true) {
      executed += 1;
      continue;
    }
    const reason = t.ai_reasoning ?? "";
    if (reason.startsWith("RISK_VETO:")) {
      riskVeto += 1;
      continue;
    }
    if (reason.startsWith("COOLDOWN_JUDGE:")) {
      cooldownJudge += 1;
      continue;
    }
    if (reason.startsWith("COOLDOWN_RISK_VETO:")) {
      cooldownRiskVeto += 1;
      continue;
    }
    judgeDenyOrOther += 1;
  }
  return {
    total: trades.length,
    executed,
    riskVeto,
    cooldownJudge,
    cooldownRiskVeto,
    judgeDenyOrOther,
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
  console.log(
    `  decision funnel:    total=${s.decisionFunnel.total} exec=${s.decisionFunnel.executed} risk_veto=${s.decisionFunnel.riskVeto} cooldown(j/r)=${s.decisionFunnel.cooldownJudge}/${s.decisionFunnel.cooldownRiskVeto} deny_other=${s.decisionFunnel.judgeDenyOrOther}`
  );
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

  const execRate =
    s.decisionFunnel.total > 0
      ? s.decisionFunnel.executed / s.decisionFunnel.total
      : 0;
  const dominantBlock =
    s.decisionFunnel.cooldownJudge >= s.decisionFunnel.riskVeto &&
    s.decisionFunnel.cooldownJudge >= s.decisionFunnel.judgeDenyOrOther
      ? "cooldown"
      : s.decisionFunnel.riskVeto >= s.decisionFunnel.judgeDenyOrOther
        ? "risk_veto"
        : "deny_other";
  if (s.decisionFunnel.total >= env.funnelOptimizerMinDecisions && execRate < 0.02) {
    return {
      action: "funnel-optimize",
      reason: `Low execution rate ${(execRate * 100).toFixed(2)}% with dominant ${dominantBlock} blocker.`,
    };
  }
  if (now.hour >= 15 && now.minute >= 45) {
    return {
      action: "phase8-validate",
      reason: "End-of-day window: run target KPI validation.",
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
  console.log("  Tip: press Enter to refresh, or type aliases like `sentinel`, `cooldown`, `daemon`, `repair`, `funnel`, `phase8`, `heavyweights`, `date`, `replay`, `range`, `help`.");
}

function printHelp(): void {
  console.log("\n[ops] quick examples:");
  console.log("  1            # refresh status");
  console.log("  2            # run suggested action (sentinel)");
  console.log("  3            # judge cooldown status");
  console.log("  4            # daemon control");
  console.log("  5            # repair missing days (guided)");
  console.log("  6            # change date context");
  console.log("  8            # replay selected date");
  console.log("  9            # replay custom range");
  console.log("  12           # funnel optimizer (analyze/tune)");
  console.log("  13           # phase8 validation (target checks)");
  console.log("  14           # resolve Nifty-50 laggard heavyweights (dynamic) / show static list");
  console.log("  replay       # same as replay selected date");
  console.log("  range        # same as replay custom range");
  console.log("  repair       # same as repair missing days");
  console.log("  cooldown     # same as judge cooldown status");
  console.log("  daemon       # same as daemon control");
  console.log("  funnel       # same as funnel optimizer");
  console.log("  phase8       # same as phase8 validation");
  console.log("  heavyweights / hw  # NSE + Angel quotes (or static list if MODE=static)");
  console.log("  date         # same as change date");
  console.log("  sentinel     # same as option 2");
  console.log("  help");
}

interface DaemonProc {
  pid: number;
  command: string;
}

function listDaemonProcesses(): DaemonProc[] {
  const out = spawnSync("ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
  });
  if ((out.status ?? 1) !== 0) return [];
  const lines = (out.stdout ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const procs: DaemonProc[] = [];
  for (const line of lines) {
    const firstSpace = line.indexOf(" ");
    if (firstSpace <= 0) continue;
    const pidRaw = line.slice(0, firstSpace).trim();
    const command = line.slice(firstSpace + 1).trim();
    const pid = Number(pidRaw);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    const isDaemon =
      command.includes("bun run src/index.ts") || command.includes("bun run start");
    const isOps = command.includes("src/cli/ops.ts");
    if (!isDaemon || isOps) continue;
    procs.push({ pid, command });
  }
  return procs;
}

function killDaemonProcesses(procs: DaemonProc[]): void {
  if (procs.length === 0) return;
  for (const p of procs) {
    try {
      process.kill(p.pid, "SIGTERM");
    } catch {
      // ignore dead pid
    }
  }
  spawnSync("sleep", ["1"]);
  const still = new Set(listDaemonProcesses().map((p) => p.pid));
  for (const p of procs) {
    if (!still.has(p.pid)) continue;
    try {
      process.kill(p.pid, "SIGKILL");
    } catch {
      // ignore dead pid
    }
  }
}

function startDaemonFresh(): void {
  const child = spawn("bun", ["run", "start"], {
    cwd: process.cwd(),
    env: process.env,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function daemonControl(
  rl: ReturnType<typeof createInterface>
): Promise<void> {
  const procs = listDaemonProcesses();
  console.log(`\n[ops] daemon processes found: ${procs.length}`);
  for (const p of procs.slice(0, 20)) {
    console.log(`  pid=${p.pid} cmd=${p.command}`);
  }
  if (procs.length > 20) {
    console.log(`  ... and ${procs.length - 20} more`);
  }
  const action = (
    await ask(rl, "Action [status/kill/start-fresh/back]", "status")
  )
    .trim()
    .toLowerCase();
  if (action === "back" || action === "b") return;
  if (action === "kill") {
    killDaemonProcesses(procs);
    console.log(
      `[ops] kill complete. remaining daemon processes: ${listDaemonProcesses().length}`
    );
    return;
  }
  if (action === "start-fresh" || action === "start" || action === "restart") {
    killDaemonProcesses(procs);
    startDaemonFresh();
    console.log("[ops] started fresh daemon via `bun run start` in background");
    return;
  }
  console.log("[ops] status only");
}

async function printJudgeCooldownStatus(): Promise<void> {
  const db = await getDb();
  const nowMs = Date.now();
  const cooldownMs = Math.max(0, Math.floor(env.judgeCooldownMs));
  if (cooldownMs <= 0) {
    console.log("[ops] judge cooldown disabled (JUDGE_COOLDOWN_MS <= 0)");
    return;
  }
  const from = new Date(nowMs - cooldownMs);
  const rows = await db
    .collection<TradeLogDoc>(collections.trades)
    .find(
      { entry_time: { $gte: from } },
      { projection: { ticker: 1, strategy: 1, entry_time: 1, order_executed: 1 } }
    )
    .sort({ entry_time: -1 })
    .toArray();

  const latestByKey = new Map<string, Date>();
  for (const r of rows) {
    const ticker = r.ticker ?? "UNKNOWN";
    const strategy = r.strategy ?? "UNKNOWN";
    const key = `${strategy}:${ticker}`;
    if (!latestByKey.has(key)) latestByKey.set(key, r.entry_time);
  }

  const active = [...latestByKey.entries()]
    .map(([key, ts]) => {
      const ageMs = nowMs - ts.getTime();
      const remainingMs = Math.max(0, cooldownMs - ageMs);
      return { key, ts, remainingMs };
    })
    .filter((r) => r.remainingMs > 0)
    .sort((a, b) => b.remainingMs - a.remainingMs);

  console.log(
    `\n[ops] judge cooldown window=${Math.floor(cooldownMs / 1000)}s, active_keys=${active.length}`
  );
  if (active.length === 0) {
    console.log("  none active");
    return;
  }
  for (const row of active.slice(0, 20)) {
    const remainingSec = Math.ceil(row.remainingMs / 1000);
    console.log(
      `  ${row.key} remaining=${remainingSec}s last=${DateTime.fromJSDate(
        row.ts,
        { zone: IST }
      ).toFormat("HH:mm:ss")}`
    );
  }
  if (active.length > 20) {
    console.log(`  ... and ${active.length - 20} more`);
  }
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
    const compareProfiles = await confirm(
      rl,
      "Run side-by-side realism comparison (baseline + research profile)?",
      false
    );
    const replayStep =
      Number.isFinite(step) && step > 0 ? Math.floor(step) : 15;

    await runBacktestSnapshotsCommand({
      from,
      to,
      step: replayStep,
      skipJudge,
      judgeModelOverride: judgeModelOverride || undefined,
      failOnMissingNews,
    });

    if (compareProfiles) {
      console.log(
        "[ops] running comparison profile: research (same engine, softer microstructure assumptions)"
      );
      console.log(
        "[ops] research overrides: ENTRY_LATENCY_BARS=0, PESSIMISTIC_INTRABAR=false, SPREAD_BPS=1.0, BASE_SLIPPAGE_BPS=0.5, IMPACT_BPS_PER_1PCT_PARTICIPATION=0.10, VOLATILITY_SLIPPAGE_COEFF=0.03"
      );
      await runBacktestSnapshotsCommand({
        from,
        to,
        step: replayStep,
        skipJudge,
        judgeModelOverride: judgeModelOverride || undefined,
        failOnMissingNews,
        noClearTrades: true,
        noSync: true,
        envOverrides: {
          BACKTEST_ENTRY_LATENCY_BARS: "0",
          BACKTEST_PESSIMISTIC_INTRABAR: "false",
          BACKTEST_SPREAD_BPS: "1.0",
          BACKTEST_BASE_SLIPPAGE_BPS: "0.5",
          BACKTEST_IMPACT_BPS_PER_1PCT_PARTICIPATION: "0.10",
          BACKTEST_VOLATILITY_SLIPPAGE_COEFF: "0.03",
        },
      });
      console.log(
        "[ops] comparison complete: review both run IDs printed above in backtest-analyze output."
      );
    }
  });
}

async function runBacktestSnapshotsCommand(
  options: ReplaySnapshotCommandOptions
): Promise<void> {
  const args = [
    "run",
    "src/cli/backtest-snapshots.ts",
    "--",
    "--from",
    options.from,
    "--to",
    options.to,
    "--step",
    String(options.step),
    ...(options.skipJudge ? ["--skip-judge"] : []),
    ...(options.judgeModelOverride
      ? ["--judge-model", options.judgeModelOverride]
      : []),
    ...(options.failOnMissingNews ? ["--fail-on-missing-news"] : []),
    ...(options.noClearTrades ? ["--no-clear-trades"] : []),
    ...(options.noSync ? ["--no-sync"] : []),
  ];
  const childEnv = options.envOverrides
    ? { ...process.env, ...options.envOverrides }
    : process.env;
  const r = spawnSync("bun", args, { stdio: "inherit", env: childEnv });
  if ((r.status ?? 1) !== 0) {
    throw new Error(`backtest-snapshots failed with status ${r.status}`);
  }
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

async function runFunnelOptimizeInteractive(
  rl: ReturnType<typeof createInterface>,
  date: string
): Promise<void> {
  const lookbackRaw = await ask(
    rl,
    "Funnel optimizer lookback days",
    String(env.funnelOptimizerLookbackDays)
  );
  const lookback = Math.max(1, Math.floor(Number(lookbackRaw) || env.funnelOptimizerLookbackDays));
  const r = await runFunnelOptimizer({
    lookbackDays: lookback,
    executionEnv: env.executionEnv,
    apply: false,
  });

  console.log(
    `[ops][funnel] decisions=${r.summary.total} executed=${r.summary.executed} exec_rate=${(r.summary.executionRate * 100).toFixed(2)}%`
  );
  console.log(
    `[ops][funnel] blockers risk_veto=${r.summary.riskVeto} cooldown_judge=${r.summary.cooldownJudge} cooldown_risk=${r.summary.cooldownRiskVeto} deny_other=${r.summary.judgeDenyOrOther}`
  );
  if (r.summary.dominantBlocker) {
    console.log(
      `[ops][funnel] dominant=${r.summary.dominantBlocker} share=${(r.summary.dominantBlockerShare * 100).toFixed(1)}%`
    );
  }
  if (!r.recommendation) {
    console.log("[ops][funnel] recommendation: none (insufficient sample/dominance)");
    return;
  }
  console.log(`[ops][funnel] recommendation: ${r.recommendation.reason}`);
  for (const c of r.recommendation.changes) {
    console.log(`  - ${c.key}: ${c.from} -> ${c.to} (${c.reason})`);
  }
  const apply = await confirm(
    rl,
    "Apply these changes to local .env now? (daemon restart required)",
    false
  );
  if (!apply) return;

  const applied = await runFunnelOptimizer({
    lookbackDays: lookback,
    executionEnv: env.executionEnv,
    apply: true,
  });
  console.log(
    `[ops][funnel] apply=${applied.applied ? "YES" : "NO"} (${applied.applyReason ?? "n/a"})`
  );
}

async function runPhase8ValidationInteractive(
  rl: ReturnType<typeof createInterface>
): Promise<void> {
  const lookbackRaw = await ask(
    rl,
    "Phase 8 lookback days",
    String(env.phase8ValidationLookbackDays)
  );
  const lookback = Math.max(
    1,
    Math.floor(Number(lookbackRaw) || env.phase8ValidationLookbackDays)
  );
  const useLatestRun = await confirm(rl, "Use latest backtest run for replay PF?", true);
  const r = await buildPhase8ValidationReport({
    lookbackDays: lookback,
    executionEnv: env.executionEnv,
    useLatestBacktestRun: useLatestRun,
  });
  const k = r.kpis;
  const t = r.targets;
  const c = r.checks;
  console.log(
    `[ops][phase8] decisions=${k.decisions} executed=${k.executed} exec_rate=${(k.executionRate * 100).toFixed(2)}% target=${(t.execRateMin * 100).toFixed(1)}..${(t.execRateMax * 100).toFixed(1)}% ${c.execRateOk ? "PASS" : "FAIL"}`
  );
  console.log(
    `[ops][phase8] losing_day_pct=${(k.losingDayPct * 100).toFixed(2)}% target<=${(t.losingDayPctMax * 100).toFixed(1)}% ${c.losingDayPctOk ? "PASS" : "FAIL"}`
  );
  console.log(
    `[ops][phase8] worst_daily_loss=₹${k.worstDailyLoss.toFixed(0)} target<=₹${t.maxDailyLoss.toFixed(0)} ${c.maxDailyLossOk ? "PASS" : "FAIL"}`
  );
  console.log(
    `[ops][phase8] replay_pf=${Number.isFinite(k.replayProfitFactor) ? k.replayProfitFactor.toFixed(2) : "∞"} target>=${t.replayPfMin.toFixed(2)} ${c.replayPfOk ? "PASS" : "FAIL"}`
  );
  console.log(`[ops][phase8] OVERALL ${r.pass ? "PASS" : "FAIL"}`);
}

async function runResolveHeavyweightsFromOps(): Promise<void> {
  if (env.niftyHeavyweightsMode === "static") {
    console.log(
      `[ops] NIFTY_HEAVYWEIGHTS_MODE=static — baked-in: ${NIFTY50_HEAVYWEIGHT_TICKERS.join(", ")}`
    );
    console.log(
      "[ops] Set NIFTY_HEAVYWEIGHTS_MODE=dynamic to resolve from NSE ind_nifty50list + Angel marketQuote."
    );
    return;
  }
  const broker = createBroker();
  await broker.authenticate();
  const tickers = await resolveNifty50HeavyweightsLive(broker);
  const meta = getCachedNifty50Heavyweights();
  console.log(`[ops] heavyweights source=${meta?.source ?? "n/a"} count=${tickers.length}`);
  console.log(tickers.join(", "));
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
  if (suggestion.action === "funnel-optimize") {
    await runFunnelOptimizeInteractive(rl, date);
    return;
  }
  if (suggestion.action === "phase8-validate") {
    await runPhase8ValidationInteractive(rl);
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
      if (action === "judge-cooldown") {
        await printJudgeCooldownStatus();
        continue;
      }
      if (action === "daemon-control") {
        await daemonControl(rl);
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
      if (action === "funnel-optimize") {
        await runFunnelOptimizeInteractive(rl, currentDate);
        continue;
      }
      if (action === "phase8-validate") {
        await runPhase8ValidationInteractive(rl);
        continue;
      }
      if (action === "resolve-heavyweights") {
        await runResolveHeavyweightsFromOps();
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
