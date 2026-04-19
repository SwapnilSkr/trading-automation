import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import {
  ensureIndexes,
  bulkInsertNewsArchive,
  getSessionWatchlist,
} from "../db/repositories.js";
import { runBacktestReplay } from "../backtest/BacktestOrchestrator.js";
import { parseHistoricalNewsFile } from "../services/historicalNewsFeed.js";
import type { NewsArchiveDoc } from "../types/domain.js";
import { runCli } from "./runCli.js";

function parseArgs(): Record<string, string | boolean> {
  const a = process.argv.slice(2);
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    if (k === "--skip-judge") {
      out["skip-judge"] = true;
      continue;
    }
    if (k === "--allow-broker-orders") {
      out["allow-broker-orders"] = true;
      continue;
    }
    if (k === "--no-persist") {
      out["no-persist"] = true;
      continue;
    }
    if (k === "--use-active-watchlist") {
      out["use-active-watchlist"] = true;
      continue;
    }
    if (k === "--watchlist-snapshots") {
      out["watchlist-snapshots"] = true;
      continue;
    }
    if (k?.startsWith("--")) {
      const key = k.slice(2);
      const val = a[i + 1];
      if (val && !val.startsWith("--")) {
        out[key] = val;
        i++;
      } else {
        out[key] = "true";
      }
    }
  }
  return out;
}

function parseWatchlistMode(
  args: Record<string, string | boolean>
): "static" | "snapshots" {
  const byLegacyFlag = args["watchlist-snapshots"] === true;
  const rawTickerSource = typeof args["ticker-source"] === "string"
    ? String(args["ticker-source"]).trim().toLowerCase()
    : undefined;
  const byTickerSource = rawTickerSource === "snapshots";
  if (rawTickerSource && rawTickerSource !== "snapshots" && rawTickerSource !== "static") {
    throw new Error("[backtest] --ticker-source must be one of: static, snapshots");
  }
  return byLegacyFlag || byTickerSource ? "snapshots" : "static";
}

async function importNews(path: string): Promise<void> {
  if (!existsSync(path)) {
    throw new Error(`File not found: ${path}`);
  }
  const text = readFileSync(path, "utf8");
  const parsed = parseHistoricalNewsFile(text);
  const rows: NewsArchiveDoc[] = parsed.map((p) => ({
    ts: p.ts,
    headlines: p.headlines,
    source: p.source,
  }));
  const n = await bulkInsertNewsArchive(rows);
  console.log(`[backtest] imported ${n} news_archive rows from ${path}`);
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args["import-news"] && typeof args["import-news"] === "string") {
    await ensureIndexes();
    await importNews(args["import-news"]);
    return;
  }

  const from = String(args.from ?? "");
  const to = String(args.to ?? "");
  if (!from || !to) {
    console.error(`Usage:
  bun run src/cli/backtest.ts -- --from YYYY-MM-DD --to YYYY-MM-DD [options]

Options:
  --tickers RELIANCE,TCS,INFY   (default: WATCHED_TICKERS from .env)
  --ticker-source static|snapshots
  --use-active-watchlist        use tickers from Mongo active_watchlist (single list; lookahead bias)
  --watchlist-snapshots         alias for --ticker-source snapshots
  --tickers-fallback A,B        with snapshot mode, used when a date has no snapshot
  --step 15                     minutes between simulated scans (default: 15)
  --judge-model <openrouter>    override JUDGE_MODEL_BACKTEST
  --skip-judge                  no LLM calls (technicals only path still evaluates)
  --no-persist                  do not write trades_backtest
  --allow-broker-orders         unsafe: call broker during replay (default: skip)

  --import-news <file.json>     load historical news into Mongo news_archive, then exit`);
    throw new Error("Missing required --from and --to (see usage above)");
  }

  await ensureIndexes();

  let tickers: string[];
  const watchlistMode = parseWatchlistMode(args);
  const snapshotMode = watchlistMode === "snapshots";
  if (args["use-active-watchlist"] === true && snapshotMode) {
    throw new Error(
      "[backtest] use only one of --use-active-watchlist or --watchlist-snapshots"
    );
  }
  if (args["use-active-watchlist"] === true) {
    const doc = await getSessionWatchlist();
    if (!doc?.tickers?.length) {
      throw new Error(
        "[backtest] --use-active-watchlist: no Mongo active_watchlist.current_session; run discovery-sync first"
      );
    }
    tickers = doc.tickers;
  } else if (args.tickers) {
    tickers = String(args.tickers)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (
    typeof args["tickers-fallback"] === "string" &&
    args["tickers-fallback"].length
  ) {
    tickers = String(args["tickers-fallback"])
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  } else {
    tickers = (process.env.WATCHED_TICKERS ?? "RELIANCE,TCS,INFY")
      .split(",")
      .map((s) => s.trim());
  }

  const stepMinutes = Math.max(1, parseInt(String(args.step ?? "15"), 10) || 15);

  console.log("[backtest] replay", {
    from,
    to,
    tickers,
    stepMinutes,
    watchlistMode,
  });

  const summary = await runBacktestReplay({
    from,
    to,
    tickers,
    stepMinutes,
    judgeModel:
      typeof args["judge-model"] === "string"
        ? args["judge-model"]
        : undefined,
    skipJudge: args["skip-judge"] === true,
    skipOrders: args["allow-broker-orders"] !== true,
    persistTrades: args["no-persist"] !== true,
    watchlistMode,
  });

  console.log("[backtest] done", summary);
  console.log(
    `[backtest] query Mongo: db.trades_backtest.find({ backtest_run_id: "${summary.runId}" })`
  );
}

runCli(main);
