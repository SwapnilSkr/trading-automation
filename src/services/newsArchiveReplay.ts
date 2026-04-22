import { DateTime } from "luxon";
import { collections, getDb } from "../db/mongo.js";
import {
  ensureIndexes,
  getNewsForDate,
  upsertNews,
  upsertNewsArchiveDay,
} from "../db/repositories.js";
import { env } from "../config/env.js";
import { filterMarketHeadlines, scrapeEtArchiveDay, sleep } from "./sentinel-scraper.js";
import { IST, isIndianWeekday } from "../time/ist.js";

export interface ReplayNewsCoverageRow {
  date: string;
  docs: number;
  headlines: number;
}

export interface ReplayNewsCoverageReport {
  from: string;
  to: string;
  minHeadlinesPerDay: number;
  expectedWeekdays: string[];
  coveredDays: ReplayNewsCoverageRow[];
  missingDays: string[];
  weakDays: ReplayNewsCoverageRow[];
}

export interface EnsureReplayNewsOptions {
  from: string;
  to: string;
  minHeadlinesPerDay?: number;
  autoBackfill?: boolean;
  noFilter?: boolean;
  refreshAllDays?: boolean;
  logPrefix?: string;
}

function weekdayRange(from: string, to: string): string[] {
  const f = DateTime.fromISO(from, { zone: IST }).startOf("day");
  const t = DateTime.fromISO(to, { zone: IST }).startOf("day");
  if (!f.isValid || !t.isValid) {
    throw new Error(`Invalid replay date range for news coverage: ${from}..${to}`);
  }
  const out: string[] = [];
  let d = f;
  while (d <= t) {
    if (isIndianWeekday(d)) out.push(d.toFormat("yyyy-MM-dd"));
    d = d.plus({ days: 1 });
  }
  return out;
}

export async function getReplayNewsCoverage(
  from: string,
  to: string,
  minHeadlinesPerDay = env.backtestNewsMinHeadlinesPerDay
): Promise<ReplayNewsCoverageReport> {
  const db = await getDb();
  const fromTs = DateTime.fromISO(from, { zone: IST }).startOf("day").toJSDate();
  const toTs = DateTime.fromISO(to, { zone: IST }).endOf("day").toJSDate();
  const rows = await db
    .collection(collections.newsArchive)
    .aggregate<ReplayNewsCoverageRow>([
      {
        $match: {
          ts: { $gte: fromTs, $lte: toTs },
        },
      },
      {
        $project: {
          date: {
            $dateToString: {
              date: "$ts",
              format: "%Y-%m-%d",
              timezone: IST,
            },
          },
          headlineCount: { $size: { $ifNull: ["$headlines", []] } },
        },
      },
      {
        $group: {
          _id: "$date",
          docs: { $sum: 1 },
          headlines: { $sum: "$headlineCount" },
        },
      },
      {
        $project: {
          _id: 0,
          date: "$_id",
          docs: 1,
          headlines: 1,
        },
      },
      { $sort: { date: 1 } },
    ])
    .toArray();

  const expectedWeekdays = weekdayRange(from, to);
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const missingDays = expectedWeekdays.filter((d) => !byDate.has(d));
  const weakDays = expectedWeekdays
    .map((d) => byDate.get(d))
    .filter((r): r is ReplayNewsCoverageRow => {
      if (!r) return false;
      return r.headlines < Math.max(1, minHeadlinesPerDay);
    });

  return {
    from,
    to,
    minHeadlinesPerDay,
    expectedWeekdays,
    coveredDays: rows,
    missingDays,
    weakDays,
  };
}

async function backfillOneDay(
  istDate: string,
  noFilter: boolean,
  logPrefix: string
): Promise<number> {
  const d = DateTime.fromISO(istDate, { zone: IST }).startOf("day");
  const raw = await scrapeEtArchiveDay(d.year, d.month, d.day);
  const headlines = noFilter ? raw.slice(0, 40) : filterMarketHeadlines(raw);
  const unique = [...new Set(headlines.map((h) => h.trim()).filter(Boolean).map((h) => h.toLowerCase()))];
  const restoreCase = new Map<string, string>();
  for (const h of headlines.map((x) => x.trim()).filter(Boolean)) {
    const k = h.toLowerCase();
    if (!restoreCase.has(k)) restoreCase.set(k, h);
  }
  const top = unique.slice(0, 25).map((k) => restoreCase.get(k) ?? k);
  if (top.length === 0) {
    console.warn(`${logPrefix} ${istDate}: no headlines after filter`);
    return 0;
  }

  const existingLive = await getNewsForDate(istDate);
  const mergedLive: string[] = [];
  const seenLive = new Set<string>();
  for (const h of [...(existingLive?.headlines ?? []), ...top]) {
    const t = h.trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seenLive.has(k)) continue;
    seenLive.add(k);
    mergedLive.push(t);
    if (mergedLive.length >= 25) break;
  }
  await upsertNews({
    date: istDate,
    headlines: mergedLive,
    source: "ET-archive-scraper",
    updated_at: new Date(),
  });
  await upsertNewsArchiveDay(istDate, top, "ET-archive-scraper");
  console.log(`${logPrefix} ${istDate}: upserted ${top.length} headlines`);
  return top.length;
}

export async function ensureReplayNewsCoverage(
  opts: EnsureReplayNewsOptions
): Promise<ReplayNewsCoverageReport> {
  const minHeadlinesPerDay =
    opts.minHeadlinesPerDay ?? env.backtestNewsMinHeadlinesPerDay;
  const autoBackfill = opts.autoBackfill ?? env.backtestNewsAutoBackfill;
  const noFilter = opts.noFilter ?? env.backtestNewsAutoBackfillNoFilter;
  const refreshAllDays = opts.refreshAllDays ?? true;
  const logPrefix = opts.logPrefix ?? "[news-replay]";

  await ensureIndexes();
  let report = await getReplayNewsCoverage(
    opts.from,
    opts.to,
    minHeadlinesPerDay
  );
  const needsBackfill =
    report.missingDays.length > 0 || report.weakDays.length > 0;
  if (!needsBackfill || !autoBackfill) return report;

  const targets = refreshAllDays
    ? report.expectedWeekdays
    : [...report.missingDays, ...report.weakDays.map((r) => r.date)];
  const unique = [...new Set(targets)].sort();
  console.log(`${logPrefix} auto-fetch start: ${unique.length} day(s)`);
  for (const date of unique) {
    try {
      await backfillOneDay(date, noFilter, logPrefix);
    } catch (e) {
      console.warn(
        `${logPrefix} ${date}: backfill failed: ${
          e instanceof Error ? e.message : String(e)
        }`
      );
    }
    if (env.archiveScraperDelayMs > 0) {
      await sleep(env.archiveScraperDelayMs);
    }
  }

  report = await getReplayNewsCoverage(opts.from, opts.to, minHeadlinesPerDay);
  return report;
}
