import { MongoClient, type Db } from "mongodb";
import { env } from "../config/env.js";

let client: MongoClient | null = null;
let db: Db | null = null;

export async function getDb(): Promise<Db> {
  if (db) return db;
  const uri = env.mongoUri();
  client = new MongoClient(uri);
  await client.connect();
  db = client.db(env.mongoDbName);
  return db;
}

export async function closeMongo(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

export const collections = {
  ohlc1m: "ohlc_1m",
  trades: "trades",
  tradesBacktest: "trades_backtest",
  lessons: "lessons_learned",
  news: "news_context",
  newsArchive: "news_archive",
  activeWatchlist: "active_watchlist",
  watchlistSnapshots: "watchlist_snapshots",
  weekendOptimizeCheckpoint: "weekend_optimize_checkpoint",
} as const;
