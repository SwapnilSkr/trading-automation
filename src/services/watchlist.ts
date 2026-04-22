import { env } from "../config/env.js";
import {
  getSessionWatchlist,
  getWatchlistSnapshotForEffectiveDate,
  upsertSessionWatchlist,
} from "../db/repositories.js";
import { istDateString } from "../time/ist.js";

/**
 * Tickers the daemon / sync jobs scan. Uses Mongo `active_watchlist` when
 * `TRADING_TICKER_SOURCE=active_watchlist`, else `WATCHED_TICKERS`.
 */
export async function resolveWatchlistTickers(): Promise<string[]> {
  if (env.tradingTickerSource === "active_watchlist") {
    const doc = await getSessionWatchlist();
    if (doc?.tickers?.length) return doc.tickers;

    const today = istDateString();
    const snap = await getWatchlistSnapshotForEffectiveDate(today);
    if (snap?.tickers?.length) {
      await upsertSessionWatchlist({
        _id: "current_session",
        tickers: snap.tickers,
        updated_at: new Date(),
        source: `recovered_from_snapshot:${today}`,
        performers: snap.performers,
      });
      console.warn(
        `[Watchlist] recovered active_watchlist.current_session from watchlist_snapshots ${today}`
      );
      return snap.tickers;
    }

    console.warn(
      "[Watchlist] TRADING_TICKER_SOURCE=active_watchlist but Mongo has no `current_session` — falling back to WATCHED_TICKERS"
    );
  }
  return env.watchedTickers;
}
