import { env } from "../config/env.js";
import { getSessionWatchlist } from "../db/repositories.js";

/**
 * Tickers the daemon / sync jobs scan. Uses Mongo `active_watchlist` when
 * `TRADING_TICKER_SOURCE=active_watchlist`, else `WATCHED_TICKERS`.
 */
export async function resolveWatchlistTickers(): Promise<string[]> {
  if (env.tradingTickerSource === "active_watchlist") {
    const doc = await getSessionWatchlist();
    if (doc?.tickers?.length) return doc.tickers;
    console.warn(
      "[Watchlist] TRADING_TICKER_SOURCE=active_watchlist but Mongo has no `current_session` — falling back to WATCHED_TICKERS"
    );
  }
  return env.watchedTickers;
}
