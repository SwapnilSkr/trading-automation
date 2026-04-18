import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import { ensureIndexes, bulkInsertNewsArchive } from "../db/repositories.js";
import { runBacktestReplay } from "../backtest/BacktestOrchestrator.js";
import { parseHistoricalNewsFile } from "../services/historicalNewsFeed.js";
import type { NewsArchiveDoc } from "../types/domain.js";
import { closeMongo } from "../db/mongo.js";

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

async function importNews(path: string): Promise<void> {
  if (!existsSync(path)) {
    console.error("File not found:", path);
    process.exit(1);
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
    await closeMongo();
    return;
  }

  const from = String(args.from ?? "");
  const to = String(args.to ?? "");
  if (!from || !to) {
    console.error(`Usage:
  bun run src/cli/backtest.ts -- --from YYYY-MM-DD --to YYYY-MM-DD [options]

Options:
  --tickers RELIANCE,TCS,INFY   (default: WATCHED_TICKERS from .env)
  --step 15                     minutes between simulated scans (default: 15)
  --judge-model <openrouter>    override JUDGE_MODEL_BACKTEST
  --skip-judge                  no LLM calls (technicals only path still evaluates)
  --no-persist                  do not write trades_backtest
  --allow-broker-orders         unsafe: call broker during replay (default: skip)

  --import-news <file.json>     load historical news into Mongo news_archive, then exit`);
    process.exit(1);
  }

  await ensureIndexes();

  const tickers = args.tickers
    ? String(args.tickers)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : (process.env.WATCHED_TICKERS ?? "RELIANCE,TCS,INFY")
        .split(",")
        .map((s) => s.trim());

  const stepMinutes = Math.max(1, parseInt(String(args.step ?? "15"), 10) || 15);

  console.log("[backtest] replay", { from, to, tickers, stepMinutes });

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
  });

  console.log("[backtest] done", summary);
  console.log(
    `[backtest] query Mongo: db.trades_backtest.find({ backtest_run_id: "${summary.runId}" })`
  );
  await closeMongo();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
