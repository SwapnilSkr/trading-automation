import type { Index, ListResponse } from "@pinecone-database/pinecone";
import { DateTime } from "luxon";
import { env } from "../config/env.js";
import { collections, getDb } from "../db/mongo.js";

interface GovernorDoc {
  _id: "state";
  period: string; // yyyy-MM
  ru_used: number;
  wu_used: number;
  read_disabled_until?: Date;
  write_disabled_until?: Date;
  storage_blocked_until?: Date;
  last_reason?: string;
  updated_at: Date;
}

interface GovernorState {
  period: string;
  ruUsed: number;
  wuUsed: number;
  readDisabledUntil?: Date;
  writeDisabledUntil?: Date;
  storageBlockedUntil?: Date;
  lastReason?: string;
  lastLogAtMs: number;
}

function nowPeriod(): string {
  return DateTime.now().toFormat("yyyy-MM");
}

function endOfCurrentMonth(): Date {
  return DateTime.now().endOf("month").toJSDate();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseIsoTimeFromId(id: string): number | undefined {
  const m = id.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)/);
  if (!m?.[1]) return undefined;
  const t = Date.parse(m[1]);
  return Number.isFinite(t) ? t : undefined;
}

function asNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function classifyPineconeError(err: unknown):
  | "RU_EXHAUST"
  | "WU_EXHAUST"
  | "STORAGE_FULL"
  | "OTHER" {
  const text = String((err as { message?: unknown })?.message ?? err).toLowerCase();
  const hasLimit =
    text.includes("quota") ||
    text.includes("rate limit") ||
    text.includes("exceed") ||
    text.includes("limit");
  if (
    hasLimit &&
    (text.includes("read unit") || text.includes("readunits") || text.includes("ru"))
  ) {
    return "RU_EXHAUST";
  }
  if (
    hasLimit &&
    (text.includes("write unit") || text.includes("writeunits") || text.includes("wu"))
  ) {
    return "WU_EXHAUST";
  }
  if (
    text.includes("storage") ||
    text.includes("capacity") ||
    text.includes("no space") ||
    text.includes("insufficient space")
  ) {
    return "STORAGE_FULL";
  }
  return "OTHER";
}

class PineconeQuotaGovernor {
  private state: GovernorState = {
    period: nowPeriod(),
    ruUsed: 0,
    wuUsed: 0,
    lastLogAtMs: 0,
  };
  private loaded = false;

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const db = await getDb();
      const doc = await db
        .collection<GovernorDoc>(collections.pineconeGovernorState)
        .findOne({ _id: "state" });
      if (!doc) return;
      this.state = {
        period: doc.period,
        ruUsed: asNum(doc.ru_used),
        wuUsed: asNum(doc.wu_used),
        readDisabledUntil: doc.read_disabled_until,
        writeDisabledUntil: doc.write_disabled_until,
        storageBlockedUntil: doc.storage_blocked_until,
        lastReason: doc.last_reason,
        lastLogAtMs: 0,
      };
      this.rollPeriodIfNeeded();
    } catch (e) {
      console.warn("[PineconeGovernor] load failed", e);
    }
  }

  private async persist(): Promise<void> {
    try {
      const db = await getDb();
      await db.collection<GovernorDoc>(collections.pineconeGovernorState).updateOne(
        { _id: "state" },
        {
          $set: {
            period: this.state.period,
            ru_used: this.state.ruUsed,
            wu_used: this.state.wuUsed,
            read_disabled_until: this.state.readDisabledUntil,
            write_disabled_until: this.state.writeDisabledUntil,
            storage_blocked_until: this.state.storageBlockedUntil,
            last_reason: this.state.lastReason,
            updated_at: new Date(),
          },
        },
        { upsert: true }
      );
    } catch (e) {
      console.warn("[PineconeGovernor] persist failed", e);
    }
  }

  private rollPeriodIfNeeded(): void {
    const p = nowPeriod();
    if (this.state.period === p) return;
    this.state = {
      period: p,
      ruUsed: 0,
      wuUsed: 0,
      lastLogAtMs: this.state.lastLogAtMs,
    };
  }

  private maybeLog(msg: string): void {
    const now = Date.now();
    if (now - this.state.lastLogAtMs < env.pineconeGovernorLogCooldownMs) return;
    this.state.lastLogAtMs = now;
    console.warn(msg);
  }

  async canRead(): Promise<boolean> {
    await this.load();
    this.rollPeriodIfNeeded();
    if (
      this.state.readDisabledUntil &&
      this.state.readDisabledUntil.getTime() > Date.now()
    ) {
      this.maybeLog(
        `[PineconeGovernor] reads paused until ${this.state.readDisabledUntil.toISOString()} (${this.state.lastReason ?? "quota"})`
      );
      return false;
    }
    if (
      env.pineconeRuSoftLimit > 0 &&
      this.state.ruUsed >= env.pineconeRuSoftLimit
    ) {
      if (env.pineconeAutoDisableReadsOnRuExhaust) {
        this.state.readDisabledUntil = endOfCurrentMonth();
        this.state.lastReason = `RU soft limit ${env.pineconeRuSoftLimit} reached`;
        await this.persist();
      }
      this.maybeLog(
        `[PineconeGovernor] reads disabled by RU soft limit (${this.state.ruUsed}/${env.pineconeRuSoftLimit})`
      );
      return false;
    }
    return true;
  }

  async canWrite(): Promise<boolean> {
    await this.load();
    this.rollPeriodIfNeeded();
    if (
      this.state.writeDisabledUntil &&
      this.state.writeDisabledUntil.getTime() > Date.now()
    ) {
      this.maybeLog(
        `[PineconeGovernor] writes paused until ${this.state.writeDisabledUntil.toISOString()} (${this.state.lastReason ?? "quota"})`
      );
      return false;
    }
    if (
      env.pineconeWuSoftLimit > 0 &&
      this.state.wuUsed >= env.pineconeWuSoftLimit
    ) {
      if (env.pineconeAutoDisableWritesOnWuExhaust) {
        this.state.writeDisabledUntil = endOfCurrentMonth();
        this.state.lastReason = `WU soft limit ${env.pineconeWuSoftLimit} reached`;
        await this.persist();
      }
      this.maybeLog(
        `[PineconeGovernor] writes disabled by WU soft limit (${this.state.wuUsed}/${env.pineconeWuSoftLimit})`
      );
      return false;
    }
    if (
      this.state.storageBlockedUntil &&
      this.state.storageBlockedUntil.getTime() > Date.now()
    ) {
      this.maybeLog(
        `[PineconeGovernor] writes waiting storage reallocation until ${this.state.storageBlockedUntil.toISOString()}`
      );
      return false;
    }
    return true;
  }

  async noteUsage(usage: unknown): Promise<void> {
    await this.load();
    this.rollPeriodIfNeeded();
    const u = usage as Record<string, unknown> | undefined;
    if (!u) return;
    const ru = asNum(u.readUnits ?? u.read_units ?? u.ru);
    const wu = asNum(u.writeUnits ?? u.write_units ?? u.wu);
    if (ru <= 0 && wu <= 0) return;
    this.state.ruUsed += ru;
    this.state.wuUsed += wu;
    await this.persist();
  }

  async noteError(err: unknown): Promise<"OTHER" | "STORAGE_FULL"> {
    await this.load();
    this.rollPeriodIfNeeded();
    const kind = classifyPineconeError(err);
    if (kind === "RU_EXHAUST" && env.pineconeAutoDisableReadsOnRuExhaust) {
      this.state.readDisabledUntil = endOfCurrentMonth();
      this.state.lastReason = "Pinecone RU exhausted/rate-limited";
      await this.persist();
      this.maybeLog("[PineconeGovernor] RU exhausted; reads disabled for current month");
      return "OTHER";
    }
    if (kind === "WU_EXHAUST" && env.pineconeAutoDisableWritesOnWuExhaust) {
      this.state.writeDisabledUntil = endOfCurrentMonth();
      this.state.lastReason = "Pinecone WU exhausted/rate-limited";
      await this.persist();
      this.maybeLog("[PineconeGovernor] WU exhausted; writes disabled for current month");
      return "OTHER";
    }
    if (kind === "STORAGE_FULL") {
      this.state.storageBlockedUntil = new Date(
        Date.now() + Math.max(1_000, env.pineconeStorageReallocateWaitMs)
      );
      this.state.lastReason = "Pinecone storage full";
      await this.persist();
      return "STORAGE_FULL";
    }
    return "OTHER";
  }

  async clearStorageBlock(): Promise<void> {
    await this.load();
    this.state.storageBlockedUntil = undefined;
    await this.persist();
  }

  async evictOldest(index: Index): Promise<number> {
    if (!env.pineconeAutoEvictOnStorageFull) return 0;

    const candidates: string[] = [];
    let token: string | undefined;
    try {
      for (let p = 0; p < Math.max(1, env.pineconeStorageEvictScanPages); p++) {
        const res = (await index.listPaginated({
          namespace: env.pineconeNamespace,
          limit: 100,
          ...(token ? { paginationToken: token } : {}),
        })) as ListResponse;

        await this.noteUsage(res.usage);

        const ids = (res.vectors ?? [])
          .map((v) => (v as { id?: string }).id)
          .filter((id): id is string => Boolean(id));
        candidates.push(...ids);

        token = res.pagination?.next ?? undefined;
        if (!token) break;
      }
    } catch (e) {
      this.state.lastReason = "Storage eviction scan failed";
      await this.persist();
      this.maybeLog(
        `[PineconeGovernor] eviction scan failed (index may not support listPaginated): ${String(
          (e as { message?: unknown })?.message ?? e
        )}`
      );
      return 0;
    }

    if (candidates.length === 0) return 0;

    const ranked = candidates
      .map((id) => ({ id, ts: parseIsoTimeFromId(id) ?? Number.MAX_SAFE_INTEGER }))
      .sort((a, b) => a.ts - b.ts)
      .slice(0, Math.max(1, env.pineconeStorageEvictBatch));

    const ids = ranked.map((r) => r.id);
    if (ids.length === 0) return 0;

    await index.deleteMany({
      ids,
      namespace: env.pineconeNamespace,
    });

    this.state.storageBlockedUntil = new Date(
      Date.now() + Math.max(1_000, env.pineconeStorageReallocateWaitMs)
    );
    this.state.lastReason = `Evicted ${ids.length} oldest ids`; 
    await this.persist();
    await sleep(Math.max(1_000, env.pineconeStorageReallocateWaitMs));
    await this.clearStorageBlock();
    return ids.length;
  }
}

const governor = new PineconeQuotaGovernor();

export async function pineconeReadsAllowed(): Promise<boolean> {
  return governor.canRead();
}

export async function pineconeWritesAllowed(): Promise<boolean> {
  return governor.canWrite();
}

export async function notePineconeUsage(usage: unknown): Promise<void> {
  await governor.noteUsage(usage);
}

export async function notePineconeError(
  err: unknown
): Promise<"OTHER" | "STORAGE_FULL"> {
  return governor.noteError(err);
}

export async function evictOldestPineconeRecords(index: Index): Promise<number> {
  return governor.evictOldest(index);
}
