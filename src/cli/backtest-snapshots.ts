import "dotenv/config";
import { spawnSync } from "node:child_process";
import { DateTime } from "luxon";
import { createBroker } from "../broker/factory.js";
import { runBacktestReplay } from "../backtest/BacktestOrchestrator.js";
import { env } from "../config/env.js";
import { ensureIndexes } from "../db/repositories.js";
import { collections, getDb } from "../db/mongo.js";
import type { WatchlistSnapshotDoc } from "../types/domain.js";
import { IST } from "../time/ist.js";
import { syncOhlcForRange } from "../services/marketSync.js";
import { ensureReplayNewsCoverage } from "../services/newsArchiveReplay.js";
import { runCli } from "./runCli.js";

interface Args {
  from: string;
  to: string;
  step: number;
  skipJudge: boolean;
  judgeModel?: string;
  clearTrades: boolean;
  noSync: boolean;
  noAnalyze: boolean;
  noPersist: boolean;
  forceSyncAll: boolean;
  tickersFallback: string[];
  failOnMissingNews: boolean;
  autoBackfillNews: boolean;
  newsMinHeadlinesPerDay?: number;
  newsBackfillNoFilter: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let from = "";
  let to = "";
  let step = 15;
  let skipJudge = false;
  let judgeModel: string | undefined;
  let clearTrades = true;
  let noSync = false;
  let noAnalyze = false;
  let noPersist = false;
  let forceSyncAll = false;
  let tickersFallback: string[] = [];
  let failOnMissingNews = false;
  let autoBackfillNews = env.backtestNewsAutoBackfill;
  let newsMinHeadlinesPerDay: number | undefined;
  let newsBackfillNoFilter = env.backtestNewsAutoBackfillNoFilter;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from" && argv[i + 1]) {
      from = argv[++i]!;
      continue;
    }
    if (a === "--to" && argv[i + 1]) {
      to = argv[++i]!;
      continue;
    }
    if (a === "--step" && argv[i + 1]) {
      step = Number(argv[++i]);
      continue;
    }
    if (a === "--skip-judge") {
      skipJudge = true;
      continue;
    }
    if (a === "--judge-model" && argv[i + 1]) {
      judgeModel = argv[++i]!;
      continue;
    }
    if (a === "--no-clear-trades") {
      clearTrades = false;
      continue;
    }
    if (a === "--no-sync") {
      noSync = true;
      continue;
    }
    if (a === "--no-analyze") {
      noAnalyze = true;
      continue;
    }
    if (a === "--no-persist") {
      noPersist = true;
      continue;
    }
    if (a === "--force-sync-all") {
      forceSyncAll = true;
      continue;
    }
    if (a === "--tickers-fallback" && argv[i + 1]) {
      tickersFallback = argv[++i]!
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      continue;
    }
    if (a === "--fail-on-missing-news") {
      failOnMissingNews = true;
      continue;
    }
    if (a === "--no-auto-backfill-news") {
      autoBackfillNews = false;
      continue;
    }
    if (a === "--news-min-headlines" && argv[i + 1]) {
      newsMinHeadlinesPerDay = Number(argv[++i]);
      continue;
    }
    if (a === "--news-backfill-no-filter") {
      newsBackfillNoFilter = true;
      continue;
    }
  }

  if (!from || !to) {
    throw new Error(`Usage:
  bun run backtest-snapshots -- --from YYYY-MM-DD --to YYYY-MM-DD [options]

Options:
  --step 15                       scan interval minutes (default: 15)
  --skip-judge                    technical-only deterministic mode
  --judge-model <openrouter>      override backtest judge model
  --no-clear-trades               keep existing trades_backtest rows
  --no-sync                       skip OHLC sync for snapshot tickers
  --no-analyze                    skip post-run analyzer
  --no-persist                    do not write trades_backtest
  --force-sync-all                disable coverage precheck and sync every ticker
  --tickers-fallback A,B          fallback if no snapshots in range
  --fail-on-missing-news          abort when replay news coverage is missing/weak
  --no-auto-backfill-news         don't auto-fetch replay weekday news before run
  --news-min-headlines N          minimum headline count per weekday for replay coverage
  --news-backfill-no-filter       auto-backfill keeps raw ET archive titles (no market keyword filter)
`);
  }

  return {
    from,
    to,
    step: Number.isFinite(step) && step > 0 ? Math.floor(step) : 15,
    skipJudge,
    judgeModel,
    clearTrades,
    noSync,
    noAnalyze,
    noPersist,
    forceSyncAll,
    tickersFallback,
    failOnMissingNews,
    autoBackfillNews,
    newsMinHeadlinesPerDay:
      Number.isFinite(newsMinHeadlinesPerDay) && (newsMinHeadlinesPerDay ?? 0) > 0
        ? Math.floor(newsMinHeadlinesPerDay!)
        : undefined,
    newsBackfillNoFilter,
  };
}

function toIstRange(from: string, to: string): { from: Date; to: Date } {
  const f = DateTime.fromISO(from, { zone: IST });
  const t = DateTime.fromISO(to, { zone: IST });
  if (!f.isValid || !t.isValid) {
    throw new Error(`Invalid --from/--to (use YYYY-MM-DD IST): ${from} .. ${to}`);
  }
  return {
    from: f.startOf("day").toJSDate(),
    to: t.endOf("day").toJSDate(),
  };
}

async function loadSnapshotTickers(from: string, to: string): Promise<string[]> {
  const db = await getDb();
  const snaps = await db
    .collection<WatchlistSnapshotDoc>(collections.watchlistSnapshots)
    .find(
      { effective_date: { $gte: from, $lte: to } },
      { projection: { tickers: 1 } }
    )
    .toArray();
  const uniq = new Set<string>();
  for (const s of snaps) {
    for (const t of s.tickers ?? []) uniq.add(t);
  }
  return [...uniq].sort();
}

async function maybeClearTradesBacktest(enabled: boolean): Promise<void> {
  if (!enabled) return;
  const db = await getDb();
  const r = await db.collection(collections.tradesBacktest).deleteMany({});
  console.log(`[backtest-snapshots] cleared trades_backtest rows: ${r.deletedCount}`);
}

async function tickersNeedingSync(
  tickers: string[],
  from: Date,
  to: Date
): Promise<{
  needsSync: string[];
  covered: string[];
  activeSessionDays: number;
}> {
  if (tickers.length === 0) {
    return { needsSync: [], covered: [], activeSessionDays: 0 };
  }
  const db = await getDb();
  const c = db.collection(collections.ohlc1m);
  const rows = await c
    .aggregate<{
      _id: string;
      daysPresent: number;
      activeDays: string[];
    }>([
      {
        $match: {
          ticker: { $in: tickers },
          ts: { $gte: from, $lte: to },
        },
      },
      {
        $project: {
          ticker: 1,
          day: {
            $dateToString: {
              date: "$ts",
              format: "%Y-%m-%d",
              timezone: IST,
            },
          },
        },
      },
      {
        $group: {
          _id: "$ticker",
          daysSet: { $addToSet: "$day" },
        },
      },
      {
        $project: {
          daysPresent: { $size: "$daysSet" },
          activeDays: "$daysSet",
        },
      },
    ])
    .toArray();

  const byTicker = new Map<string, number>();
  const allDays = new Set<string>();
  for (const r of rows) {
    byTicker.set(r._id, r.daysPresent);
    for (const d of r.activeDays) allDays.add(d);
  }
  const activeSessionDays = allDays.size;
  if (activeSessionDays === 0) {
    return { needsSync: [...tickers], covered: [], activeSessionDays: 0 };
  }

  const covered: string[] = [];
  const needsSync: string[] = [];
  for (const t of tickers) {
    const days = byTicker.get(t) ?? 0;
    if (days >= activeSessionDays) covered.push(t);
    else needsSync.push(t);
  }
  return { needsSync, covered, activeSessionDays };
}

function runAnalyzerFor(runId: string): void {
  const r = spawnSync(
    "bun",
    ["run", "src/cli/backtest-analyze.ts", "--", "--run-id", runId],
    { stdio: "inherit" }
  );
  if ((r.status ?? 1) !== 0) {
    throw new Error(`[backtest-snapshots] analyzer failed with status ${r.status}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  const range = toIstRange(args.from, args.to);
  await ensureIndexes();

  let tickers = await loadSnapshotTickers(args.from, args.to);
  if (tickers.length === 0) {
    if (args.tickersFallback.length === 0) {
      throw new Error(
        "[backtest-snapshots] no watchlist_snapshots in range; pass --tickers-fallback A,B"
      );
    }
    tickers = args.tickersFallback;
    console.warn(
      `[backtest-snapshots] no snapshots found in range; using fallback tickers (${tickers.length})`
    );
  }

  console.log(
    `[backtest-snapshots] range=${args.from}..${args.to} snapshotTickers=${tickers.length}`
  );
  const effectiveJudgeModel = args.judgeModel ?? env.judgeModelBacktest;
  console.log(
    `[backtest-snapshots] replay config: step=${args.step}m skipJudge=${args.skipJudge} judgeModel=${effectiveJudgeModel}`
  );

  if (!args.skipJudge) {
    const report = await ensureReplayNewsCoverage({
      from: args.from,
      to: args.to,
      minHeadlinesPerDay: args.newsMinHeadlinesPerDay,
      autoBackfill: args.autoBackfillNews,
      noFilter: args.newsBackfillNoFilter,
      logPrefix: "[backtest-snapshots][news]",
    });
    const missing = report.missingDays.length;
    const weak = report.weakDays.length;
    const covered = report.coveredDays.length;
    const expected = report.expectedWeekdays.length;
    const summary = `coverage=${covered}/${expected} missing=${missing} weak=${weak} min_headlines=${report.minHeadlinesPerDay}`;
    if (missing > 0 || weak > 0) {
      const detail = [
        missing > 0 ? `missing=[${report.missingDays.join(",")}]` : "",
        weak > 0
          ? `weak=[${report.weakDays
              .map((d) => `${d.date}:${d.headlines}`)
              .join(",")}]`
          : "",
      ]
        .filter(Boolean)
        .join(" ");
      const msg =
        `[backtest-snapshots] WARNING: replay news coverage incomplete after auto-backfill (${summary}) ${detail}`.trim();
      if (args.failOnMissingNews) {
        throw new Error(
          `${msg}. Run backfill-news-scraper for the range (or lower BACKTEST_NEWS_MIN_HEADLINES_PER_DAY) and retry.`
        );
      }
      console.warn(msg);
    } else {
      console.log(`[backtest-snapshots] news context: ${summary}`);
    }
  }

  if (!args.noSync) {
    const toSync = args.forceSyncAll
      ? {
          needsSync: tickers,
          covered: [] as string[],
          activeSessionDays: 0,
        }
      : await tickersNeedingSync(tickers, range.from, range.to);

    if (!args.forceSyncAll) {
      console.log(
        `[backtest-snapshots] coverage precheck: covered=${toSync.covered.length} missing=${toSync.needsSync.length} activeDays=${toSync.activeSessionDays}`
      );
    }

    if (toSync.needsSync.length === 0) {
      console.log("[backtest-snapshots] sync skipped: all snapshot tickers already covered");
    } else {
      const broker = createBroker();
      await broker.authenticate();
      console.log(
        `[backtest-snapshots] syncing 1m OHLC for ${toSync.needsSync.length} tickers...`
      );
      const synced = await syncOhlcForRange(
        broker,
        range.from,
        range.to,
        toSync.needsSync
      );
      const withBars = synced.filter((x) => x.bars > 0).length;
      const totalBars = synced.reduce((s, x) => s + x.bars, 0);
      console.log(
        `[backtest-snapshots] sync done: ${withBars}/${synced.length} tickers returned bars, total bars=${totalBars}`
      );
    }
  } else {
    console.log("[backtest-snapshots] --no-sync enabled (skipping OHLC backfill)");
  }

  await maybeClearTradesBacktest(args.clearTrades && !args.noPersist);

  const summary = await runBacktestReplay({
    from: args.from,
    to: args.to,
    tickers,
    stepMinutes: args.step,
    judgeModel: args.judgeModel,
    skipJudge: args.skipJudge,
    skipOrders: true,
    persistTrades: !args.noPersist,
    watchlistMode: "snapshots",
  });

  console.log("[backtest-snapshots] done", summary);
  console.log(
    `[backtest-snapshots] query Mongo: db.trades_backtest.find({ backtest_run_id: "${summary.runId}" })`
  );

  if (!args.noAnalyze && !args.noPersist) {
    runAnalyzerFor(summary.runId);
  } else if (args.noPersist) {
    console.log("[backtest-snapshots] --no-persist set; skipping analyzer");
  }
}

runCli(main);
