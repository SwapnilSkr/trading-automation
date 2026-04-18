import { XMLParser } from "fast-xml-parser";
import { env } from "../config/env.js";
import { getNewsForDate, upsertNews } from "../db/repositories.js";
import {
  scrapeMoneycontrolHeadlines,
} from "./sentinel-scraper.js";
import { istDateString } from "../time/ist.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  trimValues: true,
});

function rssItemsFromParsed(result: unknown): unknown[] {
  if (result === null || typeof result !== "object") return [];
  const rss = (result as Record<string, unknown>).rss;
  if (rss === null || typeof rss !== "object") return [];
  const channel = (rss as Record<string, unknown>).channel;
  if (channel === null || typeof channel !== "object") return [];
  const item = (channel as Record<string, unknown>).item;
  if (item === undefined || item === null) return [];
  return Array.isArray(item) ? item : [item];
}

function itemTitle(item: unknown): string | null {
  if (item === null || typeof item !== "object") return null;
  const t = (item as Record<string, unknown>).title;
  if (typeof t === "string") return t.trim() || null;
  if (t !== null && typeof t === "object" && "#text" in (t as object)) {
    const x = String((t as Record<string, unknown>)["#text"]).trim();
    return x || null;
  }
  return null;
}

/** RSS titles only (no Mongo write). */
export async function pullRssHeadlines(): Promise<string[]> {
  const url = env.newsEtRssUrl;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept: "application/rss+xml, application/xml, text/xml, */*",
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) {
    throw new Error(`RSS HTTP ${res.status}`);
  }
  const xml = await res.text();
  const parsed = parser.parse(xml);
  const rawItems = rssItemsFromParsed(parsed);
  return rawItems
    .map((i) => itemTitle(i))
    .filter((h): h is string => Boolean(h))
    .slice(0, 15);
}

function dedupeMerge(a: string[], b: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of [...a, ...b]) {
    const k = h.trim();
    if (!k) continue;
    const low = k.toLowerCase();
    if (seen.has(low)) continue;
    seen.add(low);
    out.push(k);
  }
  return out;
}

/**
 * Pull ET RSS and upsert `news_context` for `targetDate` (no Sentinel).
 */
export async function ingestRSSNews(targetDate?: string): Promise<string[]> {
  const date = targetDate ?? istDateString();
  try {
    const headlines = await pullRssHeadlines();
    const top = headlines.slice(0, 15);
    await upsertNews({
      date,
      headlines: top.length ? top : ["(empty RSS parse)"],
      source: "ET-RSS",
      updated_at: new Date(),
    });
    return top;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[News] RSS ingestion failed:", msg);
    return [];
  }
}

/**
 * Hybrid: RSS + optional Moneycontrol Sentinel scrape → one `news_context` row for today (IST).
 */
export async function fetchTodayNewsContext(): Promise<string[]> {
  const date = istDateString();
  let rss: string[] = [];
  try {
    rss = await pullRssHeadlines();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[News] RSS pull failed:", msg);
  }

  let scraped: string[] = [];
  if (env.newsSentinelEnabled) {
    try {
      scraped = await scrapeMoneycontrolHeadlines();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[News] Sentinel scrape failed:", msg);
    }
  }

  const merged = dedupeMerge(rss, scraped).slice(0, 25);

  if (merged.length > 0) {
    const source =
      scraped.length > 0 ? "ET-RSS+Sentinel" : "ET-RSS";
    await upsertNews({
      date,
      headlines: merged,
      source,
      updated_at: new Date(),
    });
    return merged;
  }

  const existing = await getNewsForDate(date);
  if (existing?.headlines?.length) return existing.headlines;

  const headlines = [
    "Placeholder: wire real macro/sector headlines before live trading",
  ];
  await upsertNews({
    date,
    headlines,
    source: "stub",
    updated_at: new Date(),
  });
  return headlines;
}
