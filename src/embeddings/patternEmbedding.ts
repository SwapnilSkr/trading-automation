import { env } from "../config/env.js";
import type { Ohlc1m } from "../types/domain.js";

const DIM = 1536;

/** Last N log returns as a compact string for embedding models */
export function candlesToEmbeddingText(candles: Ohlc1m[], lastN = 50): string {
  const slice = candles.slice(-lastN);
  if (slice.length < 2) return "flat";
  const parts: string[] = [];
  for (let i = 1; i < slice.length; i++) {
    const prev = slice[i - 1]!.c;
    const r = prev !== 0 ? Math.log(slice[i]!.c / prev) : 0;
    parts.push(r.toFixed(5));
  }
  return parts.join(",");
}

/** Seeded deterministic vector for offline backtests when no API key */
export function deterministicVector(seed: string): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const out = new Array<number>(DIM);
  for (let i = 0; i < DIM; i++) {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    out[i] = (h % 2000) / 1000 - 1;
  }
  const norm = Math.sqrt(out.reduce((s, x) => s + x * x, 0)) || 1;
  return out.map((x) => x / norm);
}

async function openAiCompatibleEmbed(text: string): Promise<number[]> {
  const key = env.embeddingApiKey();
  if (!key) throw new Error("No embedding API key");

  const res = await fetch(`${env.embeddingBaseUrl}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: env.embeddingModel,
      input: text,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Embedding HTTP ${res.status}: ${err}`);
  }
  const data = (await res.json()) as {
    data: Array<{ embedding: number[] }>;
  };
  const emb = data.data[0]?.embedding;
  if (!emb || emb.length !== DIM) {
    throw new Error(`Expected ${DIM}-dim embedding, got ${emb?.length}`);
  }
  return emb;
}

export async function embedCandlePattern(candles: Ohlc1m[]): Promise<number[]> {
  const text = candlesToEmbeddingText(candles, 50);
  if (!env.embeddingApiKey()) {
    return deterministicVector(text);
  }
  return openAiCompatibleEmbed(text);
}
