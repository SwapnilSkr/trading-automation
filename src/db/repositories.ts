import { ObjectId, type Collection, type Document } from "mongodb";
import { collections, getDb } from "./mongo.js";
import { DateTime } from "luxon";
import { IST } from "../time/ist.js";
import type {
  ActiveWatchlistDoc,
  LessonLearnedDoc,
  NewsArchiveDoc,
  NewsContextDoc,
  Ohlc1m,
  OperatorRunDoc,
  TradeLogDoc,
  WatchlistSnapshotDoc,
} from "../types/domain.js";
import type { OrderLifecycleEventDoc } from "../types/orderLifecycle.js";

export type { PerformerScoreRow } from "../types/domain.js";

async function col<T extends Document>(name: string): Promise<Collection<T>> {
  const db = await getDb();
  return db.collection<T>(name);
}

export async function ensureIndexes(): Promise<void> {
  const ohlc = await col<Ohlc1m>(collections.ohlc1m);
  await ohlc.createIndex({ ticker: 1, ts: 1 }, { unique: true });
  await ohlc.createIndex({ ts: -1 });

  const trades = await col<TradeLogDoc>(collections.trades);
  await trades.createIndex({ entry_time: -1 });
  await trades.createIndex({ ticker: 1, strategy: 1 });
  await trades.createIndex({ angel_orderid: 1 }, { sparse: true });
  await trades.createIndex({ angel_uniqueorderid: 1 }, { sparse: true });

  const orderEv = await col<OrderLifecycleEventDoc>(
    collections.orderLifecycleEvents
  );
  await orderEv.createIndex({ idempotency_key: 1 }, { unique: true });
  await orderEv.createIndex({ received_at: -1 });
  await orderEv.createIndex({ orderid: 1 }, { sparse: true });
  await orderEv.createIndex({ uniqueorderid: 1 }, { sparse: true });
  await trades.createIndex(
    { strategy: 1, env: 1, order_executed: 1, entry_time: -1 },
    { partialFilterExpression: { "result.outcome": { $exists: true } } }
  );

  const lessons = await col<LessonLearnedDoc>(collections.lessons);
  await lessons.createIndex({ date: -1 }, { unique: true });

  const news = await col<NewsContextDoc>(collections.news);
  await news.createIndex({ date: -1 }, { unique: true });

  const newsArchive = await col<NewsArchiveDoc>(collections.newsArchive);
  await newsArchive.createIndex({ ts: -1 });

  const tradesBt = await col<TradeLogDoc>(collections.tradesBacktest);
  await tradesBt.createIndex({ entry_time: -1 });
  await tradesBt.createIndex({ backtest_run_id: 1 });

  const aw = await col<ActiveWatchlistDoc>(collections.activeWatchlist);
  await aw.createIndex({ updated_at: -1 });

  const ws = await col<WatchlistSnapshotDoc>(collections.watchlistSnapshots);
  await ws.createIndex({ effective_date: 1 }, { unique: true });

  const ops = await col<OperatorRunDoc>(collections.operatorRuns);
  await ops.createIndex({ date: -1, operation: 1, started_at: -1 });

  const sgs = await col<StrategyGateStateDoc>(collections.strategyGateState);
  await sgs.createIndex({ updated_at: -1 });

  const fts = await col<FunnelTuningStateDoc>(collections.funnelTuningState);
  await fts.createIndex({ updated_at: -1 });

  const forp = await col<FunnelOptimizerReportDoc>(
    collections.funnelOptimizerReports
  );
  await forp.createIndex({ generated_at: -1 });
}

export async function upsertOhlcBatch(rows: Ohlc1m[]): Promise<void> {
  if (rows.length === 0) return;
  const c = await col<Ohlc1m>(collections.ohlc1m);
  const ops = rows.map((r) => ({
    updateOne: {
      filter: { ticker: r.ticker, ts: r.ts },
      update: { $set: r },
      upsert: true,
    },
  }));
  await c.bulkWrite(ops, { ordered: false });
}

export async function fetchOhlcRange(
  ticker: string,
  from: Date,
  to: Date
): Promise<Ohlc1m[]> {
  const c = await col<Ohlc1m>(collections.ohlc1m);
  return c
    .find({ ticker, ts: { $gte: from, $lte: to } })
    .sort({ ts: 1 })
    .toArray();
}

export async function insertTrade(doc: TradeLogDoc): Promise<ObjectId> {
  const c = await col<TradeLogDoc>(collections.trades);
  const r = await c.insertOne(doc);
  return r.insertedId;
}

export async function updateTradeExit(
  tradeId: ObjectId,
  patch: Pick<TradeLogDoc, "exit_time" | "result">
): Promise<void> {
  const c = await col<TradeLogDoc>(collections.trades);
  await c.updateOne(
    { _id: tradeId },
    {
      $set: {
        exit_time: patch.exit_time,
        result: patch.result,
      },
    }
  );
}

export async function updateTradePartialExits(
  tradeId: ObjectId,
  partialExits: NonNullable<TradeLogDoc["partial_exits"]>
): Promise<void> {
  const c = await col<TradeLogDoc>(collections.trades);
  await c.updateOne(
    { _id: tradeId },
    {
      $set: {
        partial_exits: partialExits,
      },
    }
  );
}

export async function updateTradeBrokerFields(
  tradeId: ObjectId,
  patch: Pick<
    TradeLogDoc,
    "angel_orderid" | "angel_uniqueorderid" | "broker_order_status"
  >
): Promise<void> {
  const c = await col<TradeLogDoc>(collections.trades);
  const $set: Record<string, string> = {};
  if (patch.angel_orderid !== undefined) $set.angel_orderid = patch.angel_orderid;
  if (patch.angel_uniqueorderid !== undefined) {
    $set.angel_uniqueorderid = patch.angel_uniqueorderid;
  }
  if (patch.broker_order_status !== undefined) {
    $set.broker_order_status = patch.broker_order_status;
  }
  if (Object.keys($set).length === 0) return;
  await c.updateOne({ _id: tradeId }, { $set });
}

/**
 * @returns true if inserted, false if duplicate idempotency_key
 */
export async function insertOrderLifecycleEventIfNew(
  doc: OrderLifecycleEventDoc
): Promise<boolean> {
  const c = await col<OrderLifecycleEventDoc>(
    collections.orderLifecycleEvents
  );
  try {
    await c.insertOne(doc);
    return true;
  } catch (e) {
    const err = e as { code?: number };
    if (err.code === 11000) return false;
    throw e;
  }
}

export async function findOpenTradeIdByBrokerOrderId(
  orderid?: string,
  uniqueorderid?: string
): Promise<ObjectId | null> {
  if (!orderid && !uniqueorderid) return null;
  const c = await col<TradeLogDoc & { _id: ObjectId }>(collections.trades);
  const or: Record<string, string>[] = [];
  if (orderid) or.push({ angel_orderid: orderid });
  if (uniqueorderid) or.push({ angel_uniqueorderid: uniqueorderid });
  const t = await c.findOne(
    { $or: or, result: { $exists: false }, order_executed: { $ne: false } },
    { sort: { entry_time: -1 } }
  );
  return t?._id ?? null;
}

export async function insertBacktestTrade(doc: TradeLogDoc): Promise<void> {
  const c = await col<TradeLogDoc>(collections.tradesBacktest);
  await c.insertOne(doc);
}

export async function fetchOpenExecutedTrades(
  envMode?: TradeLogDoc["env"]
): Promise<Array<TradeLogDoc & { _id: ObjectId }>> {
  const c = await col<TradeLogDoc>(collections.trades);
  const filter: Record<string, unknown> = {
    order_executed: { $ne: false },
    result: { $exists: false },
  };
  if (envMode) filter.env = envMode;
  return c
    .find(filter)
    .sort({ entry_time: 1 })
    .toArray() as Promise<Array<TradeLogDoc & { _id: ObjectId }>>;
}

export async function fetchLatestOpenExecutedTradeByTicker(
  ticker: string,
  envMode?: TradeLogDoc["env"]
): Promise<(TradeLogDoc & { _id: ObjectId }) | null> {
  const c = await col<TradeLogDoc>(collections.trades);
  const filter: Record<string, unknown> = {
    ticker,
    order_executed: { $ne: false },
    result: { $exists: false },
  };
  if (envMode) filter.env = envMode;
  return (await c
    .find(filter)
    .sort({ entry_time: -1 })
    .limit(1)
    .next()) as (TradeLogDoc & { _id: ObjectId }) | null;
}

export async function fetchNewsArchiveHeadlinesBeforeOrAt(
  sim: Date,
  limitDocs = 40,
  dedupe = true
): Promise<string[]> {
  const c = await col<NewsArchiveDoc>(collections.newsArchive);
  const docs = await c
    .find({ ts: { $lte: sim } })
    .sort({ ts: -1 })
    .limit(limitDocs)
    .toArray();
  const out: string[] = [];
  const seen = new Set<string>();
  for (const d of docs) {
    for (const h of d.headlines ?? []) {
      if (dedupe) {
        if (seen.has(h)) continue;
        seen.add(h);
      }
      out.push(h);
      if (out.length >= 30) return out;
    }
  }
  return out;
}

export async function upsertNewsArchiveDay(
  istDate: string,
  headlines: string[],
  source = "ET-archive-scraper"
): Promise<void> {
  const d = DateTime.fromISO(istDate, { zone: IST }).set({
    hour: 9,
    minute: 30,
    second: 0,
    millisecond: 0,
  });
  if (!d.isValid) {
    throw new Error(`Invalid IST date for news_archive upsert: ${istDate}`);
  }
  const ts = d.toJSDate();
  const c = await col<NewsArchiveDoc>(collections.newsArchive);
  const existing = await c.findOne({ ts, source });
  const mergeUnique = (items: string[]): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const h of items) {
      const t = h.trim();
      if (!t) continue;
      const k = t.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(t);
    }
    return out;
  };
  const merged = mergeUnique([
    ...(existing?.headlines ?? []),
    ...headlines,
  ]).slice(0, 60);
  await c.updateOne(
    { ts, source },
    {
      $set: {
        ts,
        source,
        headlines: merged,
      },
    },
    { upsert: true }
  );
}

export async function bulkInsertNewsArchive(
  rows: NewsArchiveDoc[]
): Promise<number> {
  if (rows.length === 0) return 0;
  const c = await col<NewsArchiveDoc>(collections.newsArchive);
  try {
    const r = await c.insertMany(rows, { ordered: false });
    return r.insertedCount;
  } catch (e: unknown) {
    const err = e as { insertedCount?: number };
    if (typeof err.insertedCount === "number") return err.insertedCount;
    throw e;
  }
}

export async function tradesForDay(istDate: string): Promise<TradeLogDoc[]> {
  const c = await col<TradeLogDoc>(collections.trades);
  const start = new Date(`${istDate}T00:00:00+05:30`);
  const end = new Date(`${istDate}T23:59:59+05:30`);
  return c
    .find({ entry_time: { $gte: start, $lte: end } })
    .sort({ entry_time: 1 })
    .toArray();
}

export async function fetchTradesInRange(
  from: Date,
  to: Date,
  executionEnv?: TradeLogDoc["env"]
): Promise<TradeLogDoc[]> {
  const c = await col<TradeLogDoc>(collections.trades);
  const filter: Record<string, unknown> = {
    entry_time: { $gte: from, $lte: to },
  };
  if (executionEnv) filter.env = executionEnv;
  return c.find(filter).sort({ entry_time: 1 }).toArray();
}

export async function fetchExecutedTradesSince(
  from: Date,
  executionEnv?: TradeLogDoc["env"]
): Promise<TradeLogDoc[]> {
  const c = await col<TradeLogDoc>(collections.trades);
  const filter: Record<string, unknown> = {
    entry_time: { $gte: from },
    order_executed: true,
    "result.pnl": { $exists: true },
  };
  if (executionEnv) filter.env = executionEnv;
  return c.find(filter).sort({ entry_time: 1 }).toArray();
}

/**
 * Fetch last N executed trades for a given strategy (most recent first).
 * Used by strategy auto-gate to compute rolling performance.
 */
export async function fetchRecentTradesByStrategy(
  strategy: string,
  limit: number,
  executionEnv?: "PAPER" | "LIVE"
): Promise<TradeLogDoc[]> {
  const c = await col<TradeLogDoc>(collections.trades);
  const filter: Record<string, unknown> = {
    strategy,
    order_executed: true,
    "result.outcome": { $exists: true },
  };
  if (executionEnv) filter.env = executionEnv;
  return c
    .find(filter)
    .sort({ entry_time: -1 })
    .limit(limit)
    .toArray();
}

/**
 * Fetch yesterday's lesson from lessons_learned collection.
 */
export async function fetchLessonForDate(
  istDate: string
): Promise<LessonLearnedDoc | null> {
  const c = await col<LessonLearnedDoc>(collections.lessons);
  return c.findOne({ date: istDate });
}

export async function upsertLesson(doc: LessonLearnedDoc): Promise<void> {
  const c = await col<LessonLearnedDoc>(collections.lessons);
  await c.updateOne(
    { date: doc.date },
    { $set: doc },
    { upsert: true }
  );
}

export async function upsertNews(doc: NewsContextDoc): Promise<void> {
  const c = await col<NewsContextDoc>(collections.news);
  await c.updateOne({ date: doc.date }, { $set: doc }, { upsert: true });
}

export async function getNewsForDate(date: string): Promise<NewsContextDoc | null> {
  const c = await col<NewsContextDoc>(collections.news);
  return c.findOne({ date });
}

export async function upsertSessionWatchlist(
  doc: ActiveWatchlistDoc
): Promise<void> {
  const c = await col<ActiveWatchlistDoc>(collections.activeWatchlist);
  await c.replaceOne({ _id: doc._id }, doc, { upsert: true });
}

export async function getSessionWatchlist(): Promise<ActiveWatchlistDoc | null> {
  const c = await col<ActiveWatchlistDoc>(collections.activeWatchlist);
  return c.findOne({ _id: "current_session" });
}

/** Mean total cash volume per session over the last `sessionDays` IST days before `before` (exclusive). */
export async function averageDailyVolumeBefore(
  ticker: string,
  before: Date,
  sessionDays = 5
): Promise<number | undefined> {
  const c = await col<Ohlc1m>(collections.ohlc1m);
  const lookbackStart = DateTime.fromJSDate(before, { zone: IST })
    .minus({ days: sessionDays * 3 })
    .toJSDate();
  const bars = await c
    .find({ ticker, ts: { $gte: lookbackStart, $lt: before } })
    .sort({ ts: -1 })
    .limit(5000)
    .toArray();
  if (bars.length === 0) return undefined;
  const byDay = new Map<string, number>();
  for (const b of bars) {
    const day = DateTime.fromJSDate(b.ts, { zone: IST }).toFormat("yyyy-MM-dd");
    byDay.set(day, (byDay.get(day) ?? 0) + b.v);
  }
  const sortedDays = [...byDay.entries()].sort((a, b) =>
    b[0].localeCompare(a[0])
  );
  const slice = sortedDays.slice(0, sessionDays);
  if (slice.length === 0) return undefined;
  const sum = slice.reduce((s, [, vol]) => s + vol, 0);
  return sum / slice.length;
}

export async function upsertWatchlistSnapshot(
  doc: WatchlistSnapshotDoc
): Promise<void> {
  const c = await col<WatchlistSnapshotDoc>(collections.watchlistSnapshots);
  await c.replaceOne({ effective_date: doc.effective_date }, doc, {
    upsert: true,
  });
}

export async function getWatchlistSnapshotForEffectiveDate(
  effectiveDate: string
): Promise<WatchlistSnapshotDoc | null> {
  const c = await col<WatchlistSnapshotDoc>(collections.watchlistSnapshots);
  return c.findOne({ effective_date: effectiveDate });
}

/** Single-doc checkpoint for `weekend-optimize` resume (per-ticker granularity). */
export interface WeekendOptimizeCheckpointDoc extends Document {
  _id: "current";
  started_ist_date: string;
  tickers_sig: string;
  completed_tickers: string[];
  updated_at: Date;
}

export interface StrategyGateStateDoc extends Document {
  _id: string; // strategy id
  disabled: boolean;
  disabled_at?: Date;
  reenabled_at?: Date;
  reason?: string;
  last_metrics?: {
    trades: number;
    weighted_pf: number;
    weighted_wr: number;
    recent_pf: number;
    recent_wr: number;
  };
  updated_at: Date;
}

export interface FunnelTuningStateDoc extends Document {
  _id: "current";
  week_key: string;
  applied_count: number;
  last_applied_at?: Date;
  last_action?: string;
  updated_at: Date;
}

export interface FunnelOptimizerReportDoc extends Document {
  generated_at: Date;
  lookback_days: number;
  from: Date;
  to: Date;
  total: number;
  executed: number;
  execution_rate: number;
  dominant_blocker?: string;
  blocker_share?: number;
  recommendation?: string;
  changes?: Array<{
    key: string;
    from: string;
    to: string;
  }>;
}

export async function getWeekendOptimizeCheckpoint(): Promise<WeekendOptimizeCheckpointDoc | null> {
  const c = await col<WeekendOptimizeCheckpointDoc>(
    collections.weekendOptimizeCheckpoint
  );
  return c.findOne({ _id: "current" });
}

export async function clearWeekendOptimizeCheckpoint(): Promise<void> {
  const c = await col<WeekendOptimizeCheckpointDoc>(
    collections.weekendOptimizeCheckpoint
  );
  await c.deleteOne({ _id: "current" });
}

export async function saveWeekendOptimizeCheckpoint(
  doc: Pick<
    WeekendOptimizeCheckpointDoc,
    "started_ist_date" | "tickers_sig" | "completed_tickers"
  >
): Promise<void> {
  const c = await col<WeekendOptimizeCheckpointDoc>(
    collections.weekendOptimizeCheckpoint
  );
  await c.updateOne(
    { _id: "current" },
    {
      $set: {
        started_ist_date: doc.started_ist_date,
        tickers_sig: doc.tickers_sig,
        completed_tickers: doc.completed_tickers,
        updated_at: new Date(),
      },
    },
    { upsert: true }
  );
}

export async function weekendOptimizeAppendCompletedTicker(
  ticker: string
): Promise<void> {
  const c = await col<WeekendOptimizeCheckpointDoc>(
    collections.weekendOptimizeCheckpoint
  );
  await c.updateOne(
    { _id: "current" },
    {
      $addToSet: { completed_tickers: ticker },
      $set: { updated_at: new Date() },
    }
  );
}

export async function fetchStrategyGateStates(): Promise<
  Map<string, StrategyGateStateDoc>
> {
  const c = await col<StrategyGateStateDoc>(collections.strategyGateState);
  const docs = await c.find({}).toArray();
  return new Map(docs.map((d) => [d._id, d] as const));
}

export async function upsertStrategyGateState(
  strategy: string,
  patch: Omit<StrategyGateStateDoc, "_id">
): Promise<void> {
  const c = await col<StrategyGateStateDoc>(collections.strategyGateState);
  await c.updateOne(
    { _id: strategy },
    {
      $set: {
        ...patch,
        updated_at: new Date(),
      },
    },
    { upsert: true }
  );
}

export async function fetchFunnelTuningState(): Promise<FunnelTuningStateDoc | null> {
  const c = await col<FunnelTuningStateDoc>(collections.funnelTuningState);
  return c.findOne({ _id: "current" });
}

export async function upsertFunnelTuningState(
  patch: Omit<FunnelTuningStateDoc, "_id" | "updated_at">
): Promise<void> {
  const c = await col<FunnelTuningStateDoc>(collections.funnelTuningState);
  await c.updateOne(
    { _id: "current" },
    {
      $set: {
        ...patch,
        updated_at: new Date(),
      },
    },
    { upsert: true }
  );
}

export async function insertFunnelOptimizerReport(
  doc: FunnelOptimizerReportDoc
): Promise<void> {
  const c = await col<FunnelOptimizerReportDoc>(collections.funnelOptimizerReports);
  await c.insertOne(doc);
}
