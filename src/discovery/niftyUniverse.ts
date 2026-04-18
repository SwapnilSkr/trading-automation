import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const NSE_NIFTY100_CSV =
  "https://nsearchives.nseindia.com/content/indices/ind_nifty100list.csv";

/** Bundled copy (repo root `data/ind_nifty100list.csv`) */
export function nifty100CsvPath(): string {
  return join(__dirname, "../../data/ind_nifty100list.csv");
}

export function parseNifty100Csv(text: string): string[] {
  const lines = text.trim().split(/\r?\n/);
  const out: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    const parts = line.split(",");
    const sym = parts[2]?.trim();
    if (sym) out.push(sym);
  }
  return out;
}

export function loadNifty100FromDisk(): string[] {
  const p = nifty100CsvPath();
  const text = readFileSync(p, "utf8");
  return parseNifty100Csv(text);
}

/** Try NSE (fresh), then disk. Optional: write-through refresh to `data/`. */
export async function loadNifty100Symbols(options?: {
  refreshFromNse?: boolean;
}): Promise<string[]> {
  if (options?.refreshFromNse) {
    try {
      const res = await fetch(NSE_NIFTY100_CSV, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; trading-automation-discovery/1.0)",
        },
      });
      if (res.ok) {
        const text = await res.text();
        const syms = parseNifty100Csv(text);
        if (syms.length >= 90) {
          try {
            writeFileSync(nifty100CsvPath(), text, "utf8");
          } catch {
            /* ignore cache write */
          }
          return syms;
        }
      }
    } catch {
      /* fall through */
    }
  }

  return loadNifty100FromDisk();
}
