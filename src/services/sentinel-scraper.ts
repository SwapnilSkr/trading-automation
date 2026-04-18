/**
 * Lightweight HTML scrape (Cheerio + fetch) for market headlines.
 * Respect site ToS; use reasonable delays; may break if markup changes.
 */
import { load } from "cheerio";
import { env } from "../config/env.js";

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Try several selectors — Moneycontrol layout changes over time. */
const MC_SELECTORS = [
  "#fleft .main_news_list li h2 a",
  ".main_news_list li h2 a",
  "li.clearfix h2 a",
  ".news_list li a",
  "h2 a[href*='/news/']",
];

export async function scrapeMoneycontrolHeadlines(): Promise<string[]> {
  const url = env.sentinelMoneycontrolUrl;
  const res = await fetch(url, {
    headers: {
      "User-Agent": BROWSER_UA,
      Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-IN,en;q=0.9",
    },
    signal: AbortSignal.timeout(env.sentinelTimeoutMs),
  });

  if (!res.ok) {
    throw new Error(`Moneycontrol HTTP ${res.status}`);
  }

  const html = await res.text();
  const $ = load(html);
  const seen = new Set<string>();
  const out: string[] = [];

  for (const sel of MC_SELECTORS) {
    $(sel).each((_i, el) => {
      const t = $(el).text().trim();
      if (t.length < 12 || t.length > 220) return;
      const k = t.toLowerCase();
      if (seen.has(k)) return;
      seen.add(k);
      out.push(t);
    });
    if (out.length >= 8) break;
  }

  return out.slice(0, 15);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const MARKET_RE =
  /nifty|sensex|bse|nse|rbi|stock|market|equity|fii|dii|ipo|bank|crude|oil|rupee|inflation|gdp|fed|rate\s|lending|rally|crash|sector|macro|trading|share|index|mutual\s*fund|bond|yield|q[1-4]\s|earnings|profit|loss|merger|acquisition|sebi/i;

/** Keep lines that look market/macro relevant (cheap filter before optional LLM). */
export function filterMarketHeadlines(headlines: string[]): string[] {
  return headlines.filter((h) => MARKET_RE.test(h));
}

/**
 * ET daily archive — HTML list of stories for one calendar day (IST context).
 * https://economictimes.indiatimes.com/archivelist/year-YYYY,month-M,day-D.cms
 */
export async function scrapeEtArchiveDay(
  year: number,
  month: number,
  day: number
): Promise<string[]> {
  const url = `https://economictimes.indiatimes.com/archivelist/year-${year},month-${month},day-${day}.cms`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": BROWSER_UA,
      Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
    },
    signal: AbortSignal.timeout(env.sentinelTimeoutMs),
  });

  if (!res.ok) {
    throw new Error(`ET archive HTTP ${res.status} ${url}`);
  }

  const html = await res.text();
  const $ = load(html);
  const seen = new Set<string>();
  const titles: string[] = [];

  $('a[href*="articleshow"]').each((_i, el) => {
    const t = $(el).text().trim();
    if (t.length < 15 || t.length > 240) return;
    const k = t.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    titles.push(t);
  });

  if (titles.length < 5) {
    $("a[href*='economictimes.indiatimes.com']").each((_i, el) => {
      const t = $(el).text().trim();
      if (t.length < 20 || t.length > 240) return;
      const k = t.toLowerCase();
      if (seen.has(k)) return;
      seen.add(k);
      titles.push(t);
    });
  }

  return titles.slice(0, 60);
}

export { sleep };
