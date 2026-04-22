import { existsSync, readFileSync } from "node:fs";
import { DateTime } from "luxon";
import { env } from "../config/env.js";
import { IST } from "../time/ist.js";
import { fetchNewsArchiveHeadlinesBeforeOrAt } from "../db/repositories.js";

type RawEntry = { ts?: string; date?: string; headlines: string[] };

let fileEntries: Array<{ ts: Date; headlines: string[] }> | null = null;

function normalizeEntry(r: RawEntry): { ts: Date; headlines: string[] } | null {
  if (!Array.isArray(r.headlines) || r.headlines.length === 0) return null;
  if (r.ts) {
    const d = new Date(r.ts);
    if (Number.isNaN(d.getTime())) return null;
    return { ts: d, headlines: r.headlines };
  }
  if (r.date) {
    const dt = DateTime.fromISO(r.date, { zone: IST }).set({
      hour: 9,
      minute: 0,
      second: 0,
      millisecond: 0,
    });
    if (!dt.isValid) return null;
    return { ts: dt.toJSDate(), headlines: r.headlines };
  }
  return null;
}

function loadFileOnce(): void {
  if (fileEntries !== null) return;
  const p = env.historicalNewsPath;
  if (!existsSync(p)) {
    fileEntries = [];
    return;
  }
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
    const arr = Array.isArray(raw) ? raw : [];
    fileEntries = [];
    for (const item of arr) {
      const n = normalizeEntry(item as RawEntry);
      if (n) fileEntries.push(n);
    }
  } catch {
    fileEntries = [];
  }
}

/**
 * Headlines known at or before `sim` (Mongo `news_archive` + optional JSON file).
 */
export async function getHeadlinesForBacktest(sim: Date): Promise<string[]> {
  loadFileOnce();
  const fromMongo = await fetchNewsArchiveHeadlinesBeforeOrAt(sim, 40, true);
  const fromFile = (fileEntries ?? [])
    .filter((e) => e.ts.getTime() <= sim.getTime())
    .sort((a, b) => b.ts.getTime() - a.ts.getTime())
    .flatMap((e) => e.headlines);

  const merged = [...fromMongo, ...fromFile].map((h) => h.trim()).filter(Boolean);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const h of merged) {
    if (seen.has(h)) continue;
    seen.add(h);
    out.push(h);
    if (out.length >= 25) break;
  }
  return out;
}

export function parseHistoricalNewsFile(
  jsonText: string
): Array<{ ts: Date; headlines: string[]; source?: string }> {
  const raw = JSON.parse(jsonText) as unknown;
  const arr = Array.isArray(raw) ? raw : [];
  const out: Array<{ ts: Date; headlines: string[]; source?: string }> = [];
  for (const item of arr) {
    const n = normalizeEntry(item as RawEntry);
    if (n) out.push({ ...n, source: "file" });
  }
  return out;
}
