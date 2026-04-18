# Trading automation (Alpha Architect)

Bun/TypeScript service for **scheduled intraday workflows** (IST), **technical triggers** (ORB, mean reversion, liquidity sweep), **AI judge** via OpenRouter, **pattern memory** in Pinecone, and **MongoDB** as the system of record. Angel One integration is stubbed until you wire the real SmartAPI.

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
| `TOTP_SEED` / Angel vars | Broker auth (stub until implemented) |
| `DAILY_STOP_LOSS`, `MAX_CONCURRENT_TRADES`, `EXECUTION_ENV` | Risk and paper/live |

See `src/config/env.ts` for the full list and defaults.

## Scripts

| Command | Description |
|---------|-------------|
| `bun run dev` | Watch mode, main process |
| `bun run start` | Run `src/index.ts` once (no watch) |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run build` | Bundle `dist/index.js`, `dist/analyst.js`, `dist/sync-history.js`, `dist/weekend-optimize.js` for Node |
| `bun run analyst` | Post-mortem + `lessons_learned` |
| `bun run sync-history` | OHLC upsert job (needs real broker) |
| `bun run weekend-optimize` | Mine patterns → Pinecone + sample hybrid replay |

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
