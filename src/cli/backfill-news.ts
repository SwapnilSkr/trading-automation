/**
 * Seed `news_context` with manual headlines for backtest / replay days
 * (RSS only carries recent items; historical sessions need explicit rows).
 *
 *   bun run backfill-news
 */
import "dotenv/config";
import { ensureIndexes, upsertNews } from "../db/repositories.js";
import { closeMongo } from "../db/mongo.js";

const manualHistory: { date: string; headlines: string[] }[] = [
  {
    date: "2026-04-13",
    headlines: [
      "Retail inflation cools to 3.4% - RBI on track",
      "Nifty nears all-time high",
    ],
  },
  {
    date: "2026-04-15",
    headlines: [
      "LIC surges 5% on institutional volume",
      "Market defies global oil spike",
    ],
  },
  {
    date: "2026-04-16",
    headlines: [
      "Crude oil $105: OMCs under pressure",
      "Tech stocks see profit booking",
    ],
  },
  {
    date: "2026-04-17",
    headlines: [
      "Reliance leads market recovery",
      "FIIs turn net buyers in cash market",
    ],
  },
];

async function main(): Promise<void> {
  await ensureIndexes();
  for (const entry of manualHistory) {
    await upsertNews({
      date: entry.date,
      headlines: entry.headlines,
      source: "manual-backfill",
      updated_at: new Date(),
    });
    console.log(`[backfill-news] ${entry.date}: ${entry.headlines.length} headlines`);
  }
  console.log("[backfill-news] done — news_context seeded");
  await closeMongo();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
