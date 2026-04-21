import { existsSync, readFileSync } from "node:fs";

export interface TickerMetadata {
  ticker: string;
  sector: string;
  beta: number;
}

type MetadataOverrides = Record<string, Partial<Omit<TickerMetadata, "ticker">>>;

const UNKNOWN: TickerMetadata = {
  ticker: "UNKNOWN",
  sector: "UNKNOWN",
  beta: 1,
};

let cache: Map<string, TickerMetadata> | undefined;

function norm(ticker: string): string {
  return ticker.trim().toUpperCase().replace(/-EQ$/i, "");
}

function loadOverrides(): MetadataOverrides {
  const url = new URL("../../data/ticker_metadata.json", import.meta.url);
  if (!existsSync(url)) return {};
  const raw = readFileSync(url, "utf8");
  const parsed = JSON.parse(raw) as MetadataOverrides;
  const out: MetadataOverrides = {};
  for (const [ticker, meta] of Object.entries(parsed)) {
    out[norm(ticker)] = meta;
  }
  return out;
}

function loadNiftyCsv(): Map<string, TickerMetadata> {
  const rows = new Map<string, TickerMetadata>();
  const url = new URL("../../data/ind_nifty100list.csv", import.meta.url);
  if (!existsSync(url)) return rows;

  const lines = readFileSync(url, "utf8").split(/\r?\n/).filter(Boolean);
  for (const line of lines.slice(1)) {
    const cols = line.split(",");
    const sector = cols[1]?.trim();
    const symbol = cols[2]?.trim();
    if (!symbol) continue;
    rows.set(norm(symbol), {
      ticker: norm(symbol),
      sector: sector || "UNKNOWN",
      beta: 1,
    });
  }
  return rows;
}

function load(): Map<string, TickerMetadata> {
  if (cache) return cache;
  const rows = loadNiftyCsv();
  const overrides = loadOverrides();
  for (const [ticker, patch] of Object.entries(overrides)) {
    const base = rows.get(ticker) ?? { ...UNKNOWN, ticker };
    rows.set(ticker, {
      ticker,
      sector: patch.sector ?? base.sector,
      beta: Number.isFinite(patch.beta) ? Number(patch.beta) : base.beta,
    });
  }
  cache = rows;
  return rows;
}

export function getTickerMetadata(ticker: string): TickerMetadata {
  const key = norm(ticker);
  return load().get(key) ?? { ...UNKNOWN, ticker: key };
}

export function getTickerSector(ticker: string): string {
  return getTickerMetadata(ticker).sector;
}

export function getTickerBeta(ticker: string): number {
  return getTickerMetadata(ticker).beta;
}
