/**
 * Backfill Mongo `ohlc_1m` from Angel SmartAPI for cold start / weekend bootstrap.
 *
 * Examples:
 *   bun run sync-history --ticker RELIANCE --days 5
 *   bun run sync-history --tickers RELIANCE,TCS --days 3
 *   bun run sync-history --from 2026-04-10 --to 2026-04-17 --ticker RELIANCE
 */
import "dotenv/config";
import { DateTime } from "luxon";
import { createBroker } from "../broker/factory.js";
import { env } from "../config/env.js";
import { ensureIndexes } from "../db/repositories.js";
import { syncOhlcForRange } from "../services/marketSync.js";
import { IST } from "../time/ist.js";

function parseArgs(): {
  tickers: string[];
  days: number;
  fromIso?: string;
  toIso?: string;
} {
  const argv = process.argv.slice(2);
  let ticker: string | undefined;
  let tickers: string[] = [];
  let days = 5;
  let fromIso: string | undefined;
  let toIso: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ticker" && argv[i + 1]) {
      ticker = argv[++i];
      continue;
    }
    if (a === "--tickers" && argv[i + 1]) {
      tickers = argv[++i]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      continue;
    }
    if (a === "--days" && argv[i + 1]) {
      days = Number(argv[++i]);
      continue;
    }
    if (a === "--from" && argv[i + 1]) {
      fromIso = argv[++i];
      continue;
    }
    if (a === "--to" && argv[i + 1]) {
      toIso = argv[++i];
      continue;
    }
  }

  const list =
    tickers.length > 0
      ? tickers
      : ticker        ? [ticker]
        : env.watchedTickers;

  if (!Number.isFinite(days) || days < 1) {
    throw new Error("--days must be a positive number");
  }

  return { tickers: list, days, fromIso, toIso };
}

function istRange(args: ReturnType<typeof parseArgs>): { from: Date; to: Date } {
  if (args.fromIso && args.toIso) {
    const from = DateTime.fromISO(args.fromIso, { zone: IST });
    const to = DateTime.fromISO(args.toIso, { zone: IST });
    if (!from.isValid || !to.isValid) {
      throw new Error(
        `Invalid --from/--to (use YYYY-MM-DD in IST context): ${args.fromIso} .. ${args.toIso}`
      );
    }
    return {
      from: from.startOf("day").toJSDate(),
      to: to.endOf("day").toJSDate(),
    };
  }

  const end = DateTime.now().setZone(IST).endOf("day");
  const start = end.minus({ days: args.days }).startOf("day");
  return { from: start.toJSDate(), to: end.toJSDate() };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const { from, to } = istRange(args);

  await ensureIndexes();
  const broker = createBroker();
  await broker.authenticate();

  console.log(
    `[sync-history] IST window ${from.toISOString()} .. ${to.toISOString()} tickers=${args.tickers.join(",")}`
  );

  const results = await syncOhlcForRange(broker, from, to, args.tickers);
  for (const r of results) {
    console.log(`[sync-history] ${r.ticker}: ${r.bars} bars`);
  }
  console.log("[sync-history] done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
