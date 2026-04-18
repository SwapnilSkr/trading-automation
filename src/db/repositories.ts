import type { Collection, Document } from "mongodb";
import { collections, getDb } from "./mongo.js";
import type {
  ActiveWatchlistDoc,
  LessonLearnedDoc,
  NewsArchiveDoc,
  NewsContextDoc,
  Ohlc1m,
  TradeLogDoc,
} from "../types/domain.js";

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

export async function insertTrade(doc: TradeLogDoc): Promise<void> {
  const c = await col<TradeLogDoc>(collections.trades);
  await c.insertOne(doc);
}

export async function insertBacktestTrade(doc: TradeLogDoc): Promise<void> {
  const c = await col<TradeLogDoc>(collections.tradesBacktest);
  await c.insertOne(doc);
}

export async function fetchNewsArchiveHeadlinesBeforeOrAt(
  sim: Date,
  limitDocs = 40
): Promise<string[]> {
  const c = await col<NewsArchiveDoc>(collections.newsArchive);
  const docs = await c
    .find({ ts: { $lte: sim } })
    .sort({ ts: -1 })
    .limit(limitDocs)
    .toArray();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of docs) {
    for (const h of d.headlines ?? []) {
      if (seen.has(h)) continue;
      seen.add(h);
      out.push(h);
      if (out.length >= 30) return out;
    }
  }
  return out;
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
