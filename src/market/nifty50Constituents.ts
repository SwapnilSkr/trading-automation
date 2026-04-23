import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../config/env.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * NSE public index membership (updated on rebalances). SmartAPI has **no** index constituent API
 * (see SmartAPI forum); same pattern as `ind_nifty100list.csv` in `niftyUniverse.ts`.
 * @see https://smartapi.angelone.in — official routes do not list Nifty-50 members.
 */
export const NSE_NIFTY50_LIST_CSV =
  "https://nsearchives.nseindia.com/content/indices/ind_nifty50list.csv";

const bundledPath = () =>
  join(__dirname, "../../data/ind_nifty50list.csv");

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let lastNseListFetchAtMs = 0;

/**
 * Parse NSE "ind_*list.csv" (Company, Industry, Symbol, Series, ISIN).
 */
export function parseNseIndexListCsv(text: string): string[] {
  const lines = text.trim().split(/\r?\n/);
  const out: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    const parts = line.split(",");
    const sym = parts[2]?.trim();
    if (sym) out.push(sym.toUpperCase());
  }
  return out;
}

export function loadNifty50ListFromDisk(): string[] {
  const text = readFileSync(bundledPath(), "utf8");
  return parseNseIndexListCsv(text);
}

/**
 * Fetches the live NSE Nifty-50 list. **Not** a SmartAPI call — uses a small inter-request gap
 * so we do not hammer NSE static hosts (separate from `scheduleSmartApiCall`).
 */
export async function fetchNifty50SymbolsFromNseArchives(
  options?: { minGapMs?: number; writeCache?: boolean }
): Promise<string[]> {
  const minGap = options?.minGapMs ?? Math.max(0, env.nseArchivesMinGapMs);
  const now = Date.now();
  const wait = lastNseListFetchAtMs + minGap - now;
  if (wait > 0) await sleep(wait);
  lastNseListFetchAtMs = Date.now();

  const res = await fetch(NSE_NIFTY50_LIST_CSV, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; trading-automation/1.0; +https://nsearchives.nseindia.com)",
    },
  });
  if (!res.ok) {
    throw new Error(
      `NSE ind_nifty50list fetch failed: ${res.status} ${res.statusText}`
    );
  }
  const text = await res.text();
  const syms = parseNseIndexListCsv(text);
  if (syms.length < 45) {
    throw new Error(`NSE ind_nifty50list: expected ~50 symbols, got ${syms.length}`);
  }
  if (options?.writeCache !== false) {
    try {
      writeFileSync(bundledPath(), text, "utf8");
    } catch {
      /* optional cache */
    }
  }
  return syms;
}

export async function loadNifty50Symbols(
  options?: { refreshFromNse?: boolean }
): Promise<string[]> {
  if (options?.refreshFromNse) {
    try {
      return await fetchNifty50SymbolsFromNseArchives();
    } catch {
      /* fall through */
    }
  }
  try {
    return loadNifty50ListFromDisk();
  } catch {
    return [];
  }
}
