/**
 * Nifty 100 → score by 5-session % move × volume ratio → top N → Mongo + optional 1m OHLC sync.
 *
 * Rate limits: one ONE_DAY candle request per name + DISCOVERY_SYMBOL_DELAY_MS between names.
 *
 *   bun run discovery-sync --days 5 --top 10
 *   bun run discovery-sync --dry-run --top 15
 *   bun run discovery-sync --refresh-universe   # re-download Nifty 100 CSV from NSE
 */
import "dotenv/config";
import { createBroker } from "../broker/factory.js";
import { ensureIndexes } from "../db/repositories.js";
import { runDiscoverySync } from "../services/discoveryRun.js";

function parseArgs(): {
  days: number;
  top: number;
  refreshUniverse: boolean;
  skipOhlc: boolean;
  dryRun: boolean;
} {
  const argv = process.argv.slice(2);
  let days = 5;
  let top = 10;
  let refreshUniverse = false;
  let skipOhlc = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--days" && argv[i + 1]) {
      days = Number(argv[++i]);
      continue;
    }
    if (a === "--top" && argv[i + 1]) {
      top = Number(argv[++i]);
      continue;
    }
    if (a === "--refresh-universe") {
      refreshUniverse = true;
      continue;
    }
    if (a === "--skip-ohlc") {
      skipOhlc = true;
      continue;
    }
    if (a === "--dry-run") {
      dryRun = true;
      continue;
    }
  }

  if (!Number.isFinite(days) || days < 3) {
    throw new Error("--days must be at least 3");
  }
  if (!Number.isFinite(top) || top < 1) {
    throw new Error("--top must be at least 1");
  }

  return { days, top, refreshUniverse, skipOhlc, dryRun };
}

async function main(): Promise<void> {
  const opts = parseArgs();
  await ensureIndexes();
  const broker = createBroker();
  await broker.authenticate();

  console.log(
    `[discovery-sync] universe=Nifty100 scoring=${opts.days}d top=${opts.top} dryRun=${opts.dryRun} skipOhlc=${opts.skipOhlc}`
  );

  const result = await runDiscoverySync(broker, {
    days: opts.days,
    top: opts.top,
    refreshUniverseCsv: opts.refreshUniverse,
    skipOhlcSync: opts.skipOhlc,
    dryRun: opts.dryRun,
  });

  console.log(
    `[discovery-sync] scanned ${result.universeSize} names, scored ${result.scored}`
  );
  for (const p of result.performers) {
    console.log(
      `  ${p.ticker} score=${p.score.toFixed(2)} pct5d=${p.pct5d.toFixed(2)}% volRatio=${p.volRatio.toFixed(2)}`
    );
  }
  if (result.ohlc) {
    for (const r of result.ohlc) {
      console.log(`[discovery-sync] ohlc_1m ${r.ticker}: ${r.bars} bars`);
    }
  }
  if (!opts.dryRun) {
    console.log(
      "[discovery-sync] Mongo active_watchlist `current_session` updated. Set TRADING_TICKER_SOURCE=active_watchlist to trade this list."
    );
  }
  console.log("[discovery-sync] done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
