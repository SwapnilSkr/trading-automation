import { Pinecone } from "@pinecone-database/pinecone";
import { env } from "../config/env.js";
import type { PatternMeta } from "../types/domain.js";
import {
  evictOldestPineconeRecords,
  notePineconeError,
  notePineconeUsage,
  pineconeReadsAllowed,
  pineconeWritesAllowed,
} from "./quotaGovernor.js";

function client(): Pinecone | null {
  const key = env.pineconeApiKey();
  if (!key) return null;
  return new Pinecone({ apiKey: key });
}

function flatMeta(m: PatternMeta): Record<string, string | number | boolean> {
  return {
    outcome: String(m.outcome),
    pnl_percent: Number(m.pnl_percent),
    date: String(m.date),
    ...(m.ticker !== undefined ? { ticker: String(m.ticker) } : {}),
    ...(m.strategy !== undefined ? { strategy: String(m.strategy) } : {}),
    ...(m.sector !== undefined ? { sector: String(m.sector) } : {}),
    ...(m.vol_regime !== undefined ? { vol_regime: String(m.vol_regime) } : {}),
  };
}

/**
 * Returns the subset of `ids` that already exist in the Pinecone namespace.
 * Chunked to respect fetch limits. Missing API key → empty set (caller treats all as missing).
 */
export async function fetchExistingPatternIds(
  ids: string[]
): Promise<Set<string>> {
  const pc = client();
  if (!pc || ids.length === 0) return new Set();
  if (!(await pineconeReadsAllowed())) return new Set();
  const index = pc.index(env.pineconeIndex);
  const ns = index.namespace(env.pineconeNamespace);
  const existing = new Set<string>();
  const chunk = Math.max(1, env.weekendOptimizeFetchBatch);
  for (let i = 0; i < ids.length; i += chunk) {
    const slice = ids.slice(i, i + chunk);
    let res;
    try {
      res = await ns.fetch({ ids: slice });
    } catch (e) {
      await notePineconeError(e);
      return existing;
    }
    await notePineconeUsage((res as { usage?: unknown }).usage);
    const records = res.records ?? {};
    for (const id of Object.keys(records)) existing.add(id);
  }
  return existing;
}

export async function upsertPatternVector(
  id: string,
  vector: number[],
  meta: PatternMeta
): Promise<void> {
  const pc = client();
  if (!pc) {
    console.warn("[Pinecone] PINECONE_API_KEY missing — skip upsert");
    return;
  }
  if (!(await pineconeWritesAllowed())) return;
  const index = pc.index(env.pineconeIndex);
  const payload = {
    records: [{ id, values: vector, metadata: flatMeta(meta) }],
  };
  for (let attempt = 0; attempt <= env.pineconeStorageMaxEvictionRetries; attempt++) {
    try {
      await index.namespace(env.pineconeNamespace).upsert(payload);
      return;
    } catch (e) {
      const errKind = await notePineconeError(e);
      if (
        errKind !== "STORAGE_FULL" ||
        !env.pineconeAutoEvictOnStorageFull ||
        attempt >= env.pineconeStorageMaxEvictionRetries
      ) {
        throw e;
      }
      const deleted = await evictOldestPineconeRecords(index);
      console.warn(
        `[Pinecone] storage full; evicted ${deleted} oldest records, retry ${attempt + 1}/${env.pineconeStorageMaxEvictionRetries}`
      );
      if (deleted <= 0) throw e;
    }
  }
}

export interface SimilarPattern {
  id: string;
  score: number;
  meta: PatternMeta;
}

export async function querySimilarPatterns(
  vector: number[],
  topK: number
): Promise<SimilarPattern[]> {
  const pc = client();
  if (!pc) return [];
  if (!(await pineconeReadsAllowed())) return [];
  const index = pc.index(env.pineconeIndex);
  let res;
  try {
    res = await index.namespace(env.pineconeNamespace).query({
      vector,
      topK,
      includeMetadata: true,
    });
  } catch (e) {
    await notePineconeError(e);
    return [];
  }
  await notePineconeUsage((res as { usage?: unknown }).usage);
  const matches = res.matches ?? [];
  return matches.map((m) => {
    const md = (m.metadata ?? {}) as Record<string, unknown>;
    return {
      id: m.id,
      score: m.score ?? 0,
      meta: {
        outcome: String(md.outcome ?? "UNKNOWN"),
        pnl_percent: Number(md.pnl_percent ?? 0),
        date: String(md.date ?? ""),
        ticker: md.ticker !== undefined ? String(md.ticker) : undefined,
        strategy: md.strategy !== undefined ? String(md.strategy) : undefined,
        sector: md.sector !== undefined ? String(md.sector) : undefined,
        vol_regime: md.vol_regime !== undefined ? String(md.vol_regime) : undefined,
      },
    };
  });
}

/** Rough probability of favorable outcome from nearest neighbors */
export function scoreFromNeighbors(
  neighbors: SimilarPattern[],
  minSimilarity = 0.72
): { useMemory: boolean; pWin: number; sample?: SimilarPattern } {
  const strong = neighbors.filter((n) => n.score >= minSimilarity);
  if (strong.length === 0) {
    return { useMemory: false, pWin: 0.5 };
  }
  const wins = strong.filter((n) => n.meta.outcome === "WIN").length;
  const pWin = wins / strong.length;
  return { useMemory: true, pWin, sample: strong[0] };
}
