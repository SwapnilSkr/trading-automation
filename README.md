# Trading automation (Alpha Architect)

Bun/TypeScript service for **scheduled intraday workflows** (IST), **technical triggers** (ORB, mean reversion, liquidity sweep), **AI judge** via OpenRouter, **pattern memory** in Pinecone, and **MongoDB** as the system of record. **[Angel One SmartAPI](https://smartapi.angelone.in/docs)** is integrated for session login (`loginByPassword`), candles (`getCandleData`), scrip search, positions, and orders (see `src/broker/`). If API key / client / PIN / TOTP seed are incomplete, the app falls back to a stub broker.

## Features

- **Phase scheduler** — INIT → observation → execution → square-off → OHLC sync → post-mortem window (`src/scheduler/`).
- **Strategies** — Opening range breakout + volume spike, Z-score vs VWAP with RSI divergence heuristics, prior-day high/low sweep (`src/indicators/`, `src/strategies/`).
- **Safety** — Daily stop-loss, max concurrent trades, kill switch (`src/execution/safety.ts`).
- **Hybrid AI** — Embeddings + Pinecone similarity, then cheap judge model when memory is weak (`src/execution/ExecutionEngine.ts`, `src/pinecone/`).
- **Backtest hook** — Mongo candle replay + Pinecone short-circuit or full judge (`src/backtest/hybridBacktest.ts`).
- **CLI jobs** — Evening analyst, history sync, weekend pattern mining (`src/analyst.ts`, `src/cli/`).
- **Health** — `GET /health` on `HEALTH_PORT` (default `3000`).

## Prerequisites

- [Bun](https://bun.sh/) (dev and `bun run build`)
- [MongoDB](https://www.mongodb.com/) (local or Atlas)
- [Pinecone](https://www.pinecone.io/) index: **cosine**, **1536** dimensions (you supply vectors from the embedding step)
- Optional: OpenAI-compatible API for **1536-d** embeddings; OpenRouter for the **judge**

## Setup

```bash
bun install
```

Create a `.env` in the project root (gitignored) with the variables below. Minimum:

| Variable | Purpose |
|----------|---------|
| `MONGODB_URI` | Mongo connection string |
| `MONGODB_DB` | Database name (default `trading-automation`) |
| `PINECONE_API_KEY` | Pinecone API key |
| `PINECONE_INDEX` | Index name (e.g. `trading-patterns`) |
| `PINECONE_NAMESPACE` | Namespace for pattern vectors |
| `OPENAI_API_KEY` | Embeddings (`text-embedding-3-small`–style, 1536 dims) |
| `OPENROUTER_API_KEY` | Judge / post-mortem model |
| `ANGEL_API_KEY` | SmartAPI app API key (`X-PrivateKey`) |
| `ANGEL_CLIENT_CODE`, `ANGEL_PASSWORD` | Client ID + trading PIN |
| `TOTP_SEED` | Base32 secret from Angel **Enable TOTP** (used to generate the `totp` field for login) |
| `ANGEL_CLIENT_PUBLIC_IP` (optional) | Should match the **whitelisted static IP** in your SmartAPI app (orders may fail otherwise) |
| `DAILY_STOP_LOSS`, `MAX_CONCURRENT_TRADES`, `EXECUTION_ENV` | Risk; `EXECUTION_ENV=LIVE` sends real `placeOrder` calls |

REST paths follow the official SDK map ([`config/api.js`](https://github.com/angel-one/smartapi-javascript/blob/main/config/api.js)). Auth uses **password + TOTP only** (no browser redirect).

See `src/config/env.ts` for the full list and defaults.

### Risk and intelligence controls

| Variable | Purpose |
|----------|---------|
| `JUDGE_COOLDOWN_MS` | Default `900000` (15 minutes). Minimum time between judge / Pinecone-gate evaluations **per ticker** in live mode, to avoid LLM spam when price chops around a trigger. |
| `PINECONE_GATE_ENABLED` | Default on; set `false` to always send borderline patterns to the judge. When on, a top neighbor with score ≥ `PINECONE_GATE_MIN_SCORE` and outcome `WIN` can approve without OpenRouter (`PINECONE_MATCH`). |
| `PINECONE_GATE_MIN_SCORE` | Cosine similarity threshold for the gate (default `0.98`). |
| `EMERGENCY_SQUARE_OFF_SECRET` | If set, enables `POST /v1/emergency/square-off` with header `X-Emergency-Key: <same value>`. Issues **MARKET** exits for all open positions (via existing broker paths), then **exits the process** (see PM2 note below). |

### Health and emergency API

- **`GET /health`** — Includes `last_tick_at`, `tick_stale` (true if no tick yet or last tick older than ~2 minutes), and `tick_age_ms`. Use this to detect a frozen scheduler while the HTTP server is still up.
- **`POST /v1/emergency/square-off`** — Requires `EMERGENCY_SQUARE_OFF_SECRET` and matching `X-Emergency-Key`. Squares all listed positions, then calls `process.exit`. If PM2 is configured with autorestart, the app may come back up; run `pm2 stop <app>` if you want the daemon fully off after a nuclear exit.

Example:

```bash
curl -X POST http://127.0.0.1:3000/v1/emergency/square-off \
  -H "X-Emergency-Key: your-long-random-secret"
```

### Data management (Mongo OHLC)

- **`bun run sync-history --days 5`** — Backfills `ohlc_1m` for **`WATCHED_TICKERS`** (IST day window ending today). Use **`--ticker RELIANCE`** or **`--tickers A,B`** to narrow the list. Optional **`--from` / `--to`** (`YYYY-MM-DD`, IST) for an explicit range. Expect **no rows** for NSE holidays and weekends; indicators use **consecutive bars** only, not calendar-filled flat prices between sessions.
- **`bun run discovery-sync --days 5 --top 10`** — Loads **Nifty 100** from `data/ind_nifty100list.csv` (optional **`--refresh-universe`**). Scores with **`ONE_DAY`** candles through **`--to YYYY-MM-DD`** (default **today** IST); writes **`watchlist_snapshots`** for **`--effective-for`** (default **next Indian weekday** after `--to`). Updates **`active_watchlist.current_session`** unless **`--snapshot-only`**. Then **`ohlc_1m`** for winners (**`--skip-ohlc`** to skip). Throttles: **`DISCOVERY_SYMBOL_DELAY_MS`**, **`ANGEL_API_THROTTLE_MS`**, **`QUOTE_BATCH_DELAY_MS`** (quote batches).
- **Automation (daemon):** During **`POST_MORTEM` (18:00–20:59 IST)**, if **`NIGHTLY_DISCOVERY`** is not `false`, runs **`runDiscoverySync`** once per calendar day (async; overlaps with optional PM2 **`nightly-discovery`** cron — disable one if redundant). During **`INIT`** at **≥09:10 IST**, if **`PREOPEN_PIVOT`** is not `false` and **`TRADING_TICKER_SOURCE=active_watchlist`**, runs **pre-open pivot**: Angel **`market/v1/quote`** (FULL), filters **`PREOPEN_MIN_ABS_GAP_PCT`** and session volume vs **`averageDailyVolumeBefore`** (**`PREOPEN_MIN_VOL_VS_AVG`**), optional **`PREOPEN_JUDGE=true`** (OpenRouter JSON pick). Updates **`current_session`** + snapshot for **today’s** `effective_date`.
- **`TRADING_TICKER_SOURCE=active_watchlist`** — Uses **`active_watchlist.current_session`** for **`EXECUTION`**, **`SQUARE_OFF`**, **`syncIntradayHistory`** (fallback **`WATCHED_TICKERS`** if missing).
- **Backtest:** **`--use-active-watchlist`** = single current session list (lookahead bias). **`--watchlist-snapshots`** = per simulated **session day**, load **`watchlist_snapshots.effective_date`**; use **`--tickers-fallback`** (or **`--tickers`**) when a date has no snapshot. Seed snapshots with historical **`discovery-sync --to <prior_session> --snapshot-only`** (or full) for each day you replay.
- **`bun run analyst`** — Evening dual-call post-mortem (winners vs losers) into `lessons_learned`.

### Historical news (backtest / replay)

- **Live daemon:** `fetchTodayNewsContext()` pulls **Economic Times markets/stocks RSS** (`NEWS_ET_RSS_URL`, default ET feed) into Mongo **`news_context`** for **today (IST)**, then passes headlines to the judge. On RSS failure it uses the existing row or a stub.
- **Manual session seed:** `bun run backfill-news` upserts sample **`news_context`** rows for fixed IST dates (edit `src/cli/backfill-news.ts` for your week).
- **Discovery:** `bun run discovery-sync` without `--to` (or `--to` = **today IST**) runs the same RSS ingest first; historical `--to` logs a reminder to use **backfill-news** / **`news_archive`**.
- **File:** `data/historical_news.json` (or `HISTORICAL_NEWS_PATH`) — array of `{ "ts": "ISO-8601", "headlines": ["..."] }` and/or `{ "date": "YYYY-MM-DD", "headlines": [...] }` (IST).
- **Mongo:** `news_archive` with `{ ts, headlines[] }`. Seed with `bun run backtest -- --import-news data/historical_news.json`. Replay merges **JSON + Mongo** with `ts <= simulated moment`.

### Time Machine backtest (Path A)

Replay stored `ohlc_1m` bar-by-bar with a **simulated clock** (weekday sessions 09:15–15:29 IST). Does **not** use the live daemon’s `currentRunMode()`. Writes optional rows to **`trades_backtest`** with `backtest_run_id`. Broker orders are **skipped by default** (stub only).

```bash
# Requires Mongo populated (e.g. sync-history / Angel historical API)
bun run backtest -- --from 2026-01-01 --to 2026-04-17 --tickers RELIANCE,HDFCBANK,ICICIBANK --step 15
```

- **`JUDGE_MODEL_BACKTEST`** — default `google/gemini-2.0-flash-001` on OpenRouter (cheap replay).
- Flags: `--skip-judge`, `--no-persist`, `--judge-model <slug>`, `--allow-broker-orders` (unsafe).

## Scripts

| Command | Description |
|---------|-------------|
| `bun run dev` | Watch mode, main process |
| `bun run start` | Run `src/index.ts` once (no watch) |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run build` | Bundle `dist/index.js`, `dist/analyst.js`, `dist/sync-history.js`, `dist/discovery-sync.js`, `dist/weekend-optimize.js`, `dist/backtest.js` for Node |
| `bun run analyst` | Post-mortem + `lessons_learned` |
| `bun run sync-history` | OHLC upsert / backfill (see **Data management**; needs SmartAPI + `TOTP_SEED` for live Angel) |
| `bun run discovery-sync` | Nifty 100 momentum scan → `active_watchlist` + optional 1m OHLC for top tickers |
| `bun run backfill-news` | Seed `news_context` with manual headlines for historical backtest days |
| `bun run weekend-optimize` | Mine patterns → Pinecone + sample hybrid replay |
| `bun run backtest -- --from … --to …` | Time Machine replay (Mongo OHLC + historical news) |

## PM2 (production-style)

```bash
bun run build
pm2 start ecosystem.config.cjs
```

Edit `ecosystem.config.cjs` and set `cwd` to this repo path. The bundle loads `.env` via `dotenv/config` in each entrypoint. Crons use **Asia/Kolkata**: **evening-analyst** (15:45), **nightly-discovery** (18:20, optional backup to in-process nightly discovery). Disable one nightly path if you want a single source.

## Pinecone agent docs

Reference material for assistants lives in `.agents/` (from the Pinecone install script). Project-specific agent rules: `AGENTS.md`.

## Disclaimer

This software is for **research and education**. Markets involve risk; past backtests do not guarantee results. You are responsible for compliance, broker terms, and capital you deploy.

## License

See repository default or add a `LICENSE` file if you publish publicly.
