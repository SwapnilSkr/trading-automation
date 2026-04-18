import { XMLParser } from "fast-xml-parser";
import { env } from "../config/env.js";
import { getNewsForDate, upsertNews } from "../db/repositories.js";
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

/**
 * Pull ET markets/stocks RSS (or `NEWS_ET_RSS_URL`) and upsert `news_context` for `targetDate` (IST yyyy-MM-DD).
 */
export async function ingestRSSNews(targetDate?: string): Promise<string[]> {
  const date = targetDate ?? istDateString();
  const url = env.newsEtRssUrl;

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; trading-automation/1.0; +https://github.com/)",
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
    const headlines = rawItems
      .map((i) => itemTitle(i))
      .filter((h): h is string => Boolean(h));

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
 * Live daemon: refresh ET RSS into today's `news_context`, then return headlines.
 * Falls back to existing Mongo row or stub if RSS fails.
 */
export async function fetchTodayNewsContext(): Promise<string[]> {
  const date = istDateString();
  const fromRss = await ingestRSSNews(date);
  if (fromRss.length > 0) return fromRss;

  const existing = await getNewsForDate(date);
  if (existing?.headlines?.length) return existing.headlines;

  const headlines = [
    "Placeholder: wire real macro/sector headlines before live trading",
  ];
  await upsertNews({ date, headlines, source: "stub", updated_at: new Date() });
  return headlines;
}
