# Alpha Architect — Trading Automation

Bun/TypeScript intraday trading system for NSE (India). Discovers momentum stocks from Nifty 100, backtests strategies with full PnL simulation, mines price patterns into Pinecone memory, and paper-trades autonomously with AI-assisted signal filtering.

**Status:** PAPER trading only (`EXECUTION_ENV=PAPER`). No real orders are placed until you explicitly change that.

---

## How the system works (30-second overview)

```
                      ┌─────────────────────────────────────────┐
                      │            Main Daemon (60s tick)        │
                      │                                          │
   Angel SmartAPI ───►│  INIT → OBSERVE → EXECUTE → SQUAREOFF   │
   (broker + OHLC)    │              │                           │
                      │     ┌────────┴──────────┐               │
   MongoDB ◄──────────│     │  ExecutionEngine   │               │
   (candles, trades)  │     │  1. Read Mongo 1m  │               │
                      │     │  2. ORB / MeanRev  │               │
   Pinecone ◄─────────│     │  3. Embed pattern  │───► trade log │
   (pattern memory)   │     │  4. Pinecone gate  │               │
                      │     │  5. Judge (LLM)    │               │
   OpenRouter ◄───────│     └────────────────────┘               │
   (judge model)      │                                          │
                      │  SYNC → POST_MORTEM (nightly discovery)  │
                      └─────────────────────────────────────────┘
```

**Phases (IST weekdays only):**

| Phase | Time | What happens |
|-------|------|--------------|
| INIT | 09:00–09:15 | Auth, news fetch, optional pre-open pivot |
| OBSERVATION | 09:15–09:30 | VWAP calibration, no trades |
| EXECUTION | 09:30–15:15 | Scan every 60s — triggers → Pinecone gate → judge → order |
| SQUARE_OFF | 15:15–15:30 | Close all intraday positions |
| SYNC | 15:30–17:00 | Backfill today's 1m OHLC from Angel |
| POST_MORTEM | 18:00–21:00 | Nightly discovery-sync (Nifty 100 rescore) |

**Exit logic (per position, live paper + backtest):**
- Stop loss at **1.5%** below entry
- Profit target at **2.5%** above entry
- Trailing stop: once **1%** profitable, trail **0.75%** below peak
- Hard close at 15:15 regardless

**Token cost:** the Pinecone gate (`PINECONE_GATE_ENABLED`) auto-approves known WIN patterns without an LLM call. After weekend-optimize fills the index, most trades skip the judge entirely. Expect 5–15 judge calls per day at Deepseek prices (~$0.001/call = pennies/day).

---

## Setup

```bash
bun install
cp .env.example .env   # fill in your keys
```

Required `.env` keys:

| Variable | Purpose |
|----------|---------|
| `MONGODB_URI` | MongoDB connection (default: `mongodb://127.0.0.1:27017`) |
| `MONGODB_DB` | Database name (default: `trading-automation`) |
| `PINECONE_API_KEY` | Pinecone API key |
| `PINECONE_INDEX` | Index name (cosine, 1536 dims) |
| `OPENAI_API_KEY` | Embeddings (`text-embedding-3-small`) |
| `OPENROUTER_API_KEY` | Judge LLM (Deepseek default, ~$0.001/call) |
| `ANGEL_API_KEY`, `ANGEL_CLIENT_CODE`, `ANGEL_PASSWORD`, `TOTP_SEED` | Angel SmartAPI credentials |

See `src/config/env.ts` for all variables and defaults. See `docs/env-reference.md` for detailed explanations.

---

## Weekend Preparation (run before first paper trading session)

Run these commands **in order** on Saturday/Sunday to fill the data tank. Each depends on the previous. See `docs/weekend-playbook.md` for detailed step-by-step.

### Step 1 — Score Nifty 100, get top 20 + their OHLC (30 days)
```bash
bun run discovery-sync -- --days 30 --top 20
```
Scores all 100 Nifty stocks by momentum (5-day return × volume ratio), picks the top 20, and backfills their 1m candles. Takes ~20–40 minutes due to Angel rate limits.

### Step 2 — Fill NIFTY50 index bars (needed for trend context)
```bash
bun run sync-history -- --days 30 --ticker NIFTY50
```
The judge needs NIFTY50 data to say "market is bullish/bearish today." Without this it gets no macro context.

### Step 3 — Backfill historical news (last 30 days)
```bash
bun run backfill-news-scraper -- --from 2026-03-01 --to 2026-04-17
```
Scrapes ET archive headlines into `news_context` so the judge has market context during backtest replay. Adjust dates to your target range.

### Step 4 — Mine price patterns into Pinecone
```bash
bun run weekend-optimize
```
Walks 6 months of 1m candles for every ticker in Mongo, finds bars with >2% moves in the next 30 minutes, embeds the preceding 30-bar window, and upserts to Pinecone. This is what powers the Pinecone gate. Run this every weekend to keep memory fresh.

### Step 5 — Run the backtest
```bash
bun run backtest -- --from 2026-03-01 --to 2026-04-17 --ticker-source snapshots
```
Full bar-by-bar replay with exit simulation (stop/target/trailing). Writes to `trades_backtest` with complete entry + exit + PnL.

### Step 6 — Analyze results
```bash
bun run backtest-analyze -- --last
```
Prints win rate, profit factor, max drawdown, Sharpe estimate, breakdown by strategy and ticker. Interpret the output:

| Profit Factor | Meaning |
|---|---|
| < 1.0 | Losing money — adjust stops/targets or tighten entry signals |
| 1.0–1.5 | Marginal edge — needs tuning |
| 1.5–2.0 | Decent edge — focus on reducing drawdown |
| > 2.0 | Strong edge — validate on out-of-sample data before going live |

---

## Running the live daemon (paper trading)

```bash
# Development (watch mode, restarts on file change)
bun run dev

# Production (PM2)
bun run build
pm2 start ecosystem.config.cjs
```

The daemon runs the full phase loop. It's safe to start any time — it will idle until the next valid IST phase window.

**Emergency stop:**
```bash
curl -X POST http://127.0.0.1:3000/v1/emergency/square-off \
  -H "X-Emergency-Key: your-secret"
```
Requires `EMERGENCY_SQUARE_OFF_SECRET` set in `.env`.

**Health check:**
```bash
curl http://127.0.0.1:3000/health
```

---

## All Commands

| Command | What it does |
|---------|-------------|
| `bun run start` | Run main daemon once |
| `bun run dev` | Watch mode (auto-restart on file change) |
| `bun run typecheck` | TypeScript type check (no emit) |
| `bun run build` | Bundle all entry points to `dist/` for PM2 |
| `bun run sync-history` | Backfill 1m OHLC from Angel for specific tickers/days |
| `bun run discovery-sync` | Score Nifty 100, write top-N to active_watchlist + OHLC |
| `bun run backfill-news` | Manually seed news_context rows (edit the script for dates) |
| `bun run backfill-news-scraper` | Scrape ET archive headlines into news_context |
| `bun run weekend-optimize` | Mine price patterns from all Mongo tickers → Pinecone |
| `bun run backtest` | Full replay with PnL simulation → trades_backtest |
| `bun run backtest-analyze` | Print win rate, Sharpe, profit factor from trades_backtest |
| `bun run analyst` | Post-mortem: winners vs losers → lessons_learned |

### sync-history flags
```bash
bun run sync-history -- --days 30               # backfill all WATCHED_TICKERS
bun run sync-history -- --days 30 --ticker NIFTY50
bun run sync-history -- --from 2026-01-01 --to 2026-03-31 --ticker RELIANCE
```

### discovery-sync flags
```bash
bun run discovery-sync -- --days 5 --top 10      # default
bun run discovery-sync -- --days 30 --top 20     # more data, bigger watchlist
bun run discovery-sync -- --dry-run              # score only, don't write
bun run discovery-sync -- --skip-ohlc           # score only, skip 1m backfill
```

### backtest flags
```bash
bun run backtest -- --from 2026-01-01 --to 2026-04-17 --tickers RELIANCE,TCS
bun run backtest -- --from 2026-01-01 --to 2026-04-17 --ticker-source snapshots
bun run backtest -- --from 2026-01-01 --to 2026-04-17 --skip-judge      # deterministic, no LLM
bun run backtest -- --from 2026-01-01 --to 2026-04-17 --no-persist      # dry run
```

### backtest-analyze flags
```bash
bun run backtest-analyze -- --last              # latest run
bun run backtest-analyze -- --run-id bt-1234   # specific run
bun run backtest-analyze                       # all backtest trades combined
```

---

## Tuning the strategy

All tunable without code changes via `.env`:

```bash
# Entry signals
# (code-level: Z-score threshold in src/strategies/triggers.ts:42, default 2.5)
# (code-level: ORB volume spike in src/strategies/triggers.ts:21, default 1.5x)

# Exits (risk management)
EXIT_STOP_PCT=0.015          # 1.5% stop loss
EXIT_TARGET_PCT=0.025        # 2.5% profit target
EXIT_TRAIL_TRIGGER_PCT=0.01  # start trailing after 1% profit
EXIT_TRAIL_DIST_PCT=0.0075   # trail 0.75% below peak

# Judge cost control
JUDGE_COOLDOWN_MS=900000     # 15 min between judge calls per ticker
PINECONE_GATE_MIN_SCORE=0.98 # auto-approve threshold (raise to 0.99 to be stricter)
JUDGE_MODEL=deepseek/deepseek-chat  # cheapest capable judge
```

**Common tuning moves based on backtest output:**
- Profit factor < 1 and win rate > 50%: targets too small, widen `EXIT_TARGET_PCT`
- Profit factor < 1 and win rate < 40%: entries are bad, tighten Z-score threshold or ORB volume filter
- Win rate OK but large drawdown: tighten `EXIT_STOP_PCT`
- Good profit factor but few trades: cooldown too high or Pinecone gate too strict

---

## Architecture

See `docs/architecture.md` for the full system diagram and data flow.

- **Broker** — `src/broker/angelOneBroker.ts`: SmartAPI REST (auth, 1m/daily candles, quotes, orders, positions). Falls back to stub if credentials incomplete.
- **Indicators** — `src/indicators/`: VWAP, RSI(14), Z-score vs VWAP, volume Z-score, RSI divergence, opening range, prior-day high/low.
- **Strategies** — `src/strategies/triggers.ts`: ORB_15M, MEAN_REV_Z, BIG_BOY_SWEEP.
- **Execution** — `src/execution/ExecutionEngine.ts`: signal → Pinecone gate → judge → paper order → live exit tracking.
- **Exit simulation** — `src/execution/exitSimulator.ts`: bar-by-bar stop/target/trailing for backtest.
- **Discovery** — `src/services/discoveryRun.ts` + `src/discovery/performerScore.ts`: Nifty 100 momentum score, writes `active_watchlist` + `watchlist_snapshots`.
- **Pattern memory** — `src/pinecone/patternStore.ts` + `src/embeddings/patternEmbedding.ts`: log-return embeddings, cosine similarity, WIN/LOSS metadata.
- **News** — `src/services/news.ts` + `src/services/sentinel-scraper.ts`: ET RSS + Moneycontrol HTML merge, upsert to `news_context`.
- **NIFTY trend** — `src/services/niftyTrend.ts`: real-time EMA + VWAP trend string from Mongo 1m bars, passed to judge every tick.

---

## MongoDB collections

| Collection | Contents |
|-----------|----------|
| `ohlc_1m` | `{ticker, ts, o, h, l, c, v}` — 1-minute candles |
| `trades` | Live paper/live trade logs with AI reasoning |
| `trades_backtest` | Backtest trades with full `entry + exit + result.pnl` |
| `news_context` | `{date (YYYY-MM-DD), headlines[]}` — daily market news |
| `news_archive` | Timestamped headlines for backtest replay |
| `active_watchlist` | `{_id: "current_session", tickers[]}` — current trading list |
| `watchlist_snapshots` | Dated snapshots for no-lookahead backtest |
| `lessons_learned` | Post-mortem summaries from analyst runs |

---

## PM2 production setup

```bash
bun run build
pm2 start ecosystem.config.cjs
pm2 logs trading-bot
pm2 monit
```

PM2 processes:
- `trading-bot` — main daemon, autorestart, runs 24/7
- `evening-analyst` — 15:45 IST weekdays, post-mortem → lessons_learned
- `nightly-discovery` — 18:20 IST weekdays, Nifty 100 rescore (backup to in-process nightly)

Disable the PM2 nightly-discovery cron OR set `NIGHTLY_DISCOVERY=false` — don't run both.

---

## Disclaimer

Research and education only. Markets involve risk. Past backtests do not guarantee future results. You are responsible for compliance, broker terms, and any capital deployed.
