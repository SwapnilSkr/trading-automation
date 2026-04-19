/**
 * Lightweight HTML scrape (Cheerio + fetch) for market headlines.
 * Respect site ToS; use reasonable delays; may break if markup changes.
 */
import { load, type CheerioAPI } from "cheerio";
import { DateTime } from "luxon";
import { env } from "../config/env.js";
import { IST } from "../time/ist.js";

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const HTML_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

/** ET `OldArchiveCal.getStartTime`: days since 30 Dec 1899 (IST calendar day). */
export function etArchiveStartTime(
  year: number,
  month: number,
  day: number
): number {
  const anchor = DateTime.fromObject(
    { year: 1899, month: 12, day: 30 },
    { zone: IST }
  ).startOf("day");
  const target = DateTime.fromObject(
    { year, month, day },
    { zone: IST }
  ).startOf("day");
  return Math.floor(target.diff(anchor, "days").days);
}

export interface FetchTextResult {
  ok: boolean;
  status: number;
  text: string;
}

/**
 * GET with retries on transient failures (5xx, 429, network/timeout).
 * Does not retry most 4xx (except 429).
 */
export async function fetchTextResilient(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<FetchTextResult> {
  const max = Math.max(1, env.sentinelMaxRetries);
  let lastStatus = 0;
  let lastText = "";

  for (let attempt = 0; attempt < max; attempt++) {
    try {
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "follow",
      });
      lastStatus = res.status;
      lastText = await res.text();

      if (res.ok) {
        return { ok: true, status: res.status, text: lastText };
      }

      const retryable =
        res.status === 429 || res.status === 408 || res.status >= 500;
      if (retryable && attempt < max - 1) {
        await sleep(
          env.sentinelRetryBaseMs * (attempt + 1) +
            Math.floor(Math.random() * 400)
        );
        continue;
      }

      return { ok: false, status: res.status, text: lastText };
    } catch {
      if (attempt < max - 1) {
        await sleep(
          env.sentinelRetryBaseMs * (attempt + 1) +
            Math.floor(Math.random() * 300)
        );
        continue;
      }
    }
  }

  return { ok: false, status: lastStatus, text: lastText };
}

function isLikelyEtSoft404($: CheerioAPI, html: string): boolean {
  const title = $("title").text().toLowerCase();
  if (title.includes("404") && title.includes("economic times")) return true;
  const h1 = $("h1").first().text().toLowerCase();
  if (h1.includes("404") && h1.includes("error")) return true;
  const compact = html.replace(/\s+/g, " ").toLowerCase();
  if (
    compact.includes("404 error") &&
    compact.includes("you are here:") &&
    compact.includes("404 page")
  ) {
    return true;
  }
  return false;
}

function extractEtHeadlinesFromHtml(html: string): string[] {
  const $ = load(html);
  if (isLikelyEtSoft404($, html)) {
    return [];
  }

  const seen = new Set<string>();
  const titles: string[] = [];

  const push = (raw: string) => {
    const t = raw.replace(/\s+/g, " ").trim();
    if (t.length < 15 || t.length > 280) return;
    const skip =
      /^(home|subscribe|sign in|read more|share|comment|next|prev|archives?)$/i.test(
        t
      );
    if (skip) return;
    const k = t.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    titles.push(t);
  };

  $('a[href*="articleshow"]').each((_i, el) => push($(el).text()));

  if (titles.length < 10) {
    $("a[href*='economictimes.indiatimes.com']").each((_i, el) => {
      const href = $(el).attr("href") ?? "";
      if (!/\/(articleshow|news)\//i.test(href)) return;
      push($(el).text());
    });
  }

  if (titles.length < 10) {
    $("ul.content li a, .content li a, #pageContent li a").each((_i, el) =>
      push($(el).text())
    );
  }

  if (titles.length < 10) {
    $("#pageContent a[href*='indiatimes.com']").each((_i, el) =>
      push($(el).text())
    );
  }

  return titles.slice(0, 60);
}

/** Try several selectors — Moneycontrol layout changes over time. */
const MC_SELECTORS = [
  "#fleft .main_news_list li h2 a",
  ".main_news_list li h2 a",
  "li.clearfix h2 a",
  ".news_list li a",
  "h2 a[href*='/news/']",
  ".news_listing li h2 a",
  "ul.news_list li a",
];

export async function scrapeMoneycontrolHeadlines(): Promise<string[]> {
  const url = env.sentinelMoneycontrolUrl;
  const { ok, status, text: html } = await fetchTextResilient(
    url,
    {
      "User-Agent": BROWSER_UA,
      Accept: HTML_ACCEPT,
      "Accept-Language": "en-IN,en;q=0.9",
    },
    env.sentinelTimeoutMs
  );

  if (!ok) {
    throw new Error(`Moneycontrol HTTP ${status} (${url.slice(0, 72)}…)`);
  }

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

  if (out.length === 0) {
    throw new Error(
      "Moneycontrol: no headlines matched known selectors (layout may have changed)"
    );
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
 * ET daily archive — uses `starttime-*` (same as site calendar), not `day-*`
 * (legacy `day-*` returns 404 on current ET).
 */
export async function scrapeEtArchiveDay(
  year: number,
  month: number,
  day: number
): Promise<string[]> {
  const starttime = etArchiveStartTime(year, month, day);
  const urls = [
    `https://economictimes.indiatimes.com/archivelist/year-${year},month-${month},starttime-${starttime}.cms`,
    `https://economictimes.indiatimes.com/archivelist/year-${year},month-${month},starttime-${starttime}.cms?from=mdr`,
    `https://economictimes.indiatimes.com/archivelist/year-${year},month-${month},day-${day}.cms`,
  ];

  let lastErr = "";

  for (const url of urls) {
    const { ok, status, text: html } = await fetchTextResilient(
      url,
      {
        "User-Agent": BROWSER_UA,
        Accept: HTML_ACCEPT,
        "Accept-Language": "en-IN,en;q=0.9",
        Referer: "https://economictimes.indiatimes.com/",
      },
      env.sentinelTimeoutMs
    );

    if (!ok) {
      lastErr = `HTTP ${status}`;
      continue;
    }

    const titles = extractEtHeadlinesFromHtml(html);
    if (titles.length > 0) {
      return titles;
    }
    lastErr = "empty parse or soft-404";
  }

  throw new Error(
    `ET archive: no headlines for ${year}-${month}-${day} (last: ${lastErr})`
  );
}

export { sleep };
