import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { env } from "../config/env.js";

export interface ScripMasterRow {
  token?: string;
  symbol?: string;
  name?: string;
  exch_seg?: string;
  instrumenttype?: string;
}

export type ScripResolution = { symboltoken: string; tradingsymbol: string };

/** `${EXCHANGE}:${BASE}` e.g. NSE:RELIANCE — BASE is uppercased without `-EQ` */
function indexKey(exchange: string, baseUpper: string): string {
  return `${exchange}:${baseUpper}`;
}

function buildEquityMap(rows: ScripMasterRow[]): Map<string, ScripResolution> {
  const map = new Map<string, ScripResolution>();
  for (const row of rows) {
    const exch = String(row.exch_seg ?? "").trim();
    const sym = String(row.symbol ?? "").trim();
    if (!exch || !sym) continue;
    if (!sym.toUpperCase().endsWith("-EQ")) continue;
    const tok = row.token;
    if (tok === undefined || tok === "") continue;
    const base = sym.replace(/-EQ$/i, "").toUpperCase();
    if (!base) continue;
    const key = indexKey(exch, base);
    map.set(key, { symboltoken: String(tok), tradingsymbol: sym });
  }
  return map;
}

function defaultCachePath(): string {
  const h = createHash("sha256")
    .update(env.angelScripMasterUrl)
    .digest("hex")
    .slice(0, 16);
  return path.join(tmpdir(), `trading-automation-scrip-master-${h}.json`);
}

async function readJsonArray(p: string): Promise<ScripMasterRow[]> {
  const raw = await readFile(p, "utf8");
  const j = JSON.parse(raw) as unknown;
  if (!Array.isArray(j)) {
    throw new Error(`scrip master: expected JSON array at ${p}`);
  }
  return j as ScripMasterRow[];
}

async function loadRows(): Promise<ScripMasterRow[]> {
  const fromEnv = env.angelScripMasterPath.trim();
  if (fromEnv) {
    return readJsonArray(fromEnv);
  }

  const cachePath =
    env.angelScripMasterCachePath.trim() || defaultCachePath();
  const maxAgeMs = env.angelScripMasterMaxAgeHours * 60 * 60 * 1000;
  const now = Date.now();

  try {
    const st = await stat(cachePath);
    if (now - st.mtimeMs <= maxAgeMs) {
      return readJsonArray(cachePath);
    }
  } catch {
    /* missing or unreadable cache — fetch */
  }

  const res = await fetch(env.angelScripMasterUrl);
  if (!res.ok) {
    throw new Error(
      `scrip master fetch failed ${res.status}: ${env.angelScripMasterUrl}`
    );
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(
      `scrip master: non-JSON from ${env.angelScripMasterUrl} (${text.slice(0, 120)})`
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error("scrip master: remote JSON is not an array");
  }

  try {
    await mkdir(path.dirname(cachePath), { recursive: true });
  } catch {
    /* tmpdir dirname is '.' — ignore */
  }
  await writeFile(cachePath, text, "utf8");

  return parsed as ScripMasterRow[];
}

let loadPromise: Promise<Map<string, ScripResolution>> | null = null;

/**
 * Lazy index from Angel OpenAPIScripMaster (EQ rows). Resolves symbols locally so
 * `searchScrip` is not called once per ticker (avoids SmartAPI rate 403).
 */
export function getEquityScripIndex(): Promise<Map<string, ScripResolution>> {
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const rows = await loadRows();
        return buildEquityMap(rows);
      } catch (e) {
        console.warn(
          "[Angel] scrip master load failed — falling back to searchScrip only:",
          e
        );
        return new Map();
      }
    })();
  }
  return loadPromise;
}

export async function lookupEquityFromScripMaster(
  exchange: string,
  baseNormUpper: string
): Promise<ScripResolution | undefined> {
  const idx = await getEquityScripIndex();
  return idx.get(indexKey(exchange, baseNormUpper));
}
