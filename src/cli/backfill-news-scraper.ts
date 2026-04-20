/**
 * Scrape Economic Times day archive pages into `news_context` (market-filtered titles).
 *
 *   bun run backfill-news-scraper --from 2026-04-13 --to 2026-04-17
 *   bun run backfill-news-scraper --from 2026-04-13 --to 2026-04-17 --no-filter
 *
 * Respect ET ToS / robots; for research; prefer manual backfill for production compliance.
 */
import "dotenv/config";
import { DateTime } from "luxon";
import { env } from "../config/env.js";
import { ensureIndexes, upsertNews, bulkInsertNewsArchive } from "../db/repositories.js";
import type { NewsArchiveDoc } from "../types/domain.js";
import { runCli } from "./runCli.js";
import {
  filterMarketHeadlines,
  scrapeEtArchiveDay,
  sleep,
} from "../services/sentinel-scraper.js";
import { IST, isIndianWeekday } from "../time/ist.js";

function parseArgs(): { from: string; to: string; filter: boolean; outputArchive: boolean } {
  const argv = process.argv.slice(2);
  let from = "";
  let to = "";
  let filter = true;
  let outputArchive = false;
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
    if (a === "--no-filter") {
      filter = false;
      continue;
    }
    if (a === "--output-archive") {
      outputArchive = true;
      continue;
    }
  }
  if (!from || !to) {
    console.error(
      "Usage: bun run backfill-news-scraper -- --from YYYY-MM-DD --to YYYY-MM-DD [--no-filter] [--output-archive]"
    );
    throw new Error("Missing --from / --to");
  }
  return { from, to, filter, outputArchive };
}

async function main(): Promise<void> {
  const { from, to, filter, outputArchive } = parseArgs();
  const start = DateTime.fromISO(from, { zone: IST }).startOf("day");
  const end = DateTime.fromISO(to, { zone: IST }).startOf("day");
  if (!start.isValid || !end.isValid) {
    throw new Error("Invalid --from / --to");
  }

  await ensureIndexes();
  const archiveRows: NewsArchiveDoc[] = [];
  let d = start;
  while (d <= end) {
    if (isIndianWeekday(d)) {
      const y = d.year;
      const m = d.month;
      const day = d.day;
      const dateStr = d.toFormat("yyyy-MM-dd");
      try {
        const raw = await scrapeEtArchiveDay(y, m, day);
        const headlines = filter
          ? filterMarketHeadlines(raw)
          : raw.slice(0, 40);
        const top = headlines.slice(0, 25);
        if (top.length) {
          await upsertNews({
            date: dateStr,
            headlines: top,
            source: "ET-archive-scraper",
            updated_at: new Date(),
          });

          if (outputArchive) {
            const ts = d.set({ hour: 9, minute: 30 }).toJSDate();
            archiveRows.push({
              ts,
              headlines: top,
              source: "ET-archive-scraper",
            });
          }

          console.log(`[archive] ${dateStr}: ${top.length} headlines`);
        } else {
          console.warn(`[archive] ${dateStr}: no headlines after filter`);
        }
      } catch (e) {
        console.error(`[archive] ${dateStr}:`, e);
      }
      if (env.archiveScraperDelayMs > 0) {
        await sleep(env.archiveScraperDelayMs);
      }
    }
    d = d.plus({ days: 1 });
  }

  if (outputArchive && archiveRows.length > 0) {
    const inserted = await bulkInsertNewsArchive(archiveRows);
    console.log(`[backfill-news-scraper] wrote ${inserted} rows to news_archive`);
  }

  console.log("[backfill-news-scraper] done");
}

runCli(main);
