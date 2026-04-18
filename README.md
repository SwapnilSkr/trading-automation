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

### Historical news (backtest / replay)

- **File:** `data/historical_news.json` (or set `HISTORICAL_NEWS_PATH`) — array of `{ "ts": "ISO-8601", "headlines": ["..."] }` and/or `{ "date": "YYYY-MM-DD", "headlines": [...] }` (interpreted in IST).
- **Mongo:** collection `news_archive` with `{ ts, headlines[] }`. Seed with:
  `bun run backtest -- --import-news data/historical_news.json`
- At each simulated time, replay uses headlines from **JSON + Mongo** with `ts <= simulated moment`.

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
| `bun run build` | Bundle `dist/index.js`, `dist/analyst.js`, `dist/sync-history.js`, `dist/weekend-optimize.js` for Node |
| `bun run analyst` | Post-mortem + `lessons_learned` |
| `bun run sync-history` | OHLC upsert job (needs SmartAPI credentials + `TOTP_SEED`) |
| `bun run weekend-optimize` | Mine patterns → Pinecone + sample hybrid replay |
| `bun run backtest -- --from … --to …` | Time Machine replay (Mongo OHLC + historical news) |

## PM2 (production-style)

```bash
bun run build
pm2 start ecosystem.config.cjs
```

Edit `ecosystem.config.cjs` and set `cwd` to this repo path. The bundle loads `.env` via `dotenv/config` in each entrypoint. The **evening-analyst** app uses a cron in **Asia/Kolkata**; adjust if your PM2 version or needs differ.

## Pinecone agent docs

Reference material for assistants lives in `.agents/` (from the Pinecone install script). Project-specific agent rules: `AGENTS.md`.

## Disclaimer

This software is for **research and education**. Markets involve risk; past backtests do not guarantee results. You are responsible for compliance, broker terms, and capital you deploy.

## License

See repository default or add a `LICENSE` file if you publish publicly.
