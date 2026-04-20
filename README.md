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
# Optional: pull the latest Nifty 100 constituents from NSE and refresh data/ind_nifty100list.csv
bun run discovery-sync -- --days 30 --top 20 --refresh-universe
```
Scores all 100 Nifty stocks by momentum (5-day return × volume ratio), picks the top 20, and backfills their 1m candles. Takes ~20–40 minutes due to Angel rate limits.

**Universe source:** By default symbols come from `data/ind_nifty100list.csv` in the repo. **`--refresh-universe`** downloads the official NSE Nifty 100 CSV, overwrites that file when the download succeeds (≥90 symbols), then scores; if NSE fails, it falls back to the existing CSV. The daemon’s **nightly** `discovery-sync` does **not** pass this flag (it always uses the on-disk CSV unless you change the code).

### Step 2 — Fill NIFTY50 index bars (needed for trend context)
```bash
bun run sync-history -- --days 30 --ticker NIFTY50
```
The judge needs NIFTY50 data to say "market is bullish/bearish today." Without this it gets no macro context.

### Step 3 — Backfill daily news for live AND backtest use
```bash
# Fills news_context (live daemon judge context) + news_archive (backtest replay headlines)
bun run backfill-news-scraper -- --from 2026-03-01 --to 2026-04-17 --output-archive
```
Writes **one row per calendar day** into Mongo ``news_context`` (used by ``fetchTodayNewsContext`` in the live daemon). With ``--output-archive``, also writes ``news_archive`` (timestamped at 09:30 IST per day) so backtest replay gets causal news headlines. **Bar replay backtests** do **not** read `news_context`; they use ``news_archive`` and/or ``HISTORICAL_NEWS_PATH`` JSON — see [MongoDB collections](#mongodb-collections).

### Step 4 — Mine price patterns into Pinecone
```bash
bun run weekend-optimize
```
Walks 6 months of 1m candles for every ticker in Mongo, finds bars with >2% moves in the next 30 minutes, embeds the preceding 30-bar window, and upserts to Pinecone. This is what powers the Pinecone gate. Run this every weekend to keep memory fresh.

### Step 5 — Run the backtest
```bash
bun run backtest -- --from 2026-03-01 --to 2026-04-17 --watchlist-snapshots
```
Full bar-by-bar replay with exit simulation (stop/target/trailing). Writes to `trades_backtest` with complete entry + exit + PnL.
Replay uses causal context: news is filtered by `ts <= simulated bar`, watchlist snapshots are date-bound, and Pinecone neighbors are filtered to dates strictly before the simulated session day.

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
| `bun run backtest-snapshots` | One-shot: snapshot tickers → OHLC sync → clear trades_backtest → backtest → analyze |
| `bun run backtest-ablation` | Run multi-profile strategy ablation on same window (single-strategy, disable-one, and regime-switch profiles) |
| `bun run backtest-analyze` | Print win rate, Sharpe, profit factor from trades_backtest |
| `bun run live-analyze` | Print end-of-day stats for live/paper `trades` (default: today IST) |
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
bun run discovery-sync -- --refresh-universe     # fetch NSE Nifty 100 CSV → update data/ind_nifty100list.csv
bun run discovery-sync -- --dry-run              # score only, don't write
bun run discovery-sync -- --skip-ohlc           # score only, skip 1m backfill
```

### backtest flags
```bash
bun run backtest -- --from 2026-01-01 --to 2026-04-17 --tickers RELIANCE,TCS
bun run backtest -- --from 2026-01-01 --to 2026-04-17 --ticker-source snapshots
bun run backtest -- --from 2026-01-01 --to 2026-04-17 --watchlist-snapshots
bun run backtest -- --from 2026-01-01 --to 2026-04-17 --skip-judge      # technical-only deterministic mode, no LLM
bun run backtest -- --from 2026-01-01 --to 2026-04-17 --no-persist      # dry run
# one-shot sequence: snapshot ticker union -> sync-history -> clear trades_backtest -> backtest -> analyze
bun run backtest-snapshots -- --from 2026-03-20 --to 2026-04-17 --skip-judge
# options: --no-sync --no-clear-trades --no-analyze --no-persist --step 15 --tickers-fallback A,B --force-sync-all
# run profile comparison on same date range
bun run backtest-ablation -- --from 2026-03-20 --to 2026-04-02 --no-clear-first
# options: --skip-judge --sync --force-sync-all --step 15
# --profiles baseline,all-strategies,regime-switch,orb15-only,orb-retest-only,meanrev-only,bigboy-only,vwap-reclaim-reject-only,vwap-pullback-only,prevday-break-retest-only,ema20-break-retest-only,vwap-reclaim-cont-only,ib-break-retest-only,vol-contraction-only,insidebar-retest-only,opendrive-pullback-only,orb-fakeout-only
```

Backtest PnL is net-realistic by default (latency, spread/slippage/impact, and charges). Tune via `BACKTEST_*` realism env vars in `docs/env-reference.md`.

### backtest-analyze flags
```bash
bun run backtest-analyze -- --last              # latest run
bun run backtest-analyze -- --run-id bt-1234   # specific run
bun run backtest-analyze                       # all backtest trades combined
```

### live-analyze flags
```bash
bun run live-analyze                            # today IST
bun run live-analyze -- --date 2026-04-20      # specific IST date
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

# Strategy toggles
BACKTEST_ENABLE_ORB_15M=true
BACKTEST_ENABLE_ORB_RETEST_15M=false
BACKTEST_ENABLE_MEAN_REV_Z=true
BACKTEST_ENABLE_BIG_BOY_SWEEP=true
BACKTEST_ENABLE_VWAP_RECLAIM_REJECT=true
BACKTEST_ENABLE_VWAP_PULLBACK_TREND=false
BACKTEST_ENABLE_PREV_DAY_HIGH_LOW_BREAK_RETEST=false
BACKTEST_ENABLE_EMA20_BREAK_RETEST=false
BACKTEST_ENABLE_VWAP_RECLAIM_CONTINUATION=false
BACKTEST_ENABLE_INITIAL_BALANCE_BREAK_RETEST=false
BACKTEST_ENABLE_VOLATILITY_CONTRACTION_BREAKOUT=false
BACKTEST_ENABLE_INSIDE_BAR_BREAKOUT_WITH_RETEST=false
BACKTEST_ENABLE_OPEN_DRIVE_PULLBACK=false
BACKTEST_ENABLE_ORB_FAKEOUT_REVERSAL=false

# Volatility regime switch (optional)
VOL_REGIME_SWITCH_ENABLED=false
VOL_REGIME_LOW_MAX_PCT=0.08
VOL_REGIME_HIGH_MIN_PCT=0.22

# Judge cost control
JUDGE_COOLDOWN_MS=900000     # 15 min between judge calls per ticker
LIVE_SKIP_JUDGE=false        # true => bypass LLM judge in daemon (technical-only auto-approve)
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
- **Strategies** — `src/strategies/triggers.ts`: ORB_15M, ORB_RETEST_15M, MEAN_REV_Z, BIG_BOY_SWEEP, VWAP_RECLAIM_REJECT, VWAP_PULLBACK_TREND, PREV_DAY_HIGH_LOW_BREAK_RETEST, EMA20_BREAK_RETEST, VWAP_RECLAIM_CONTINUATION, INITIAL_BALANCE_BREAK_RETEST, VOLATILITY_CONTRACTION_BREAKOUT, INSIDE_BAR_BREAKOUT_WITH_RETEST, OPEN_DRIVE_PULLBACK, ORB_FAKEOUT_REVERSAL.
- **Execution** — `src/execution/ExecutionEngine.ts`: signal → Pinecone gate → judge → paper order → live exit tracking.
- **Exit simulation** — `src/execution/exitSimulator.ts`: bar-by-bar stop/target/trailing for backtest.
- **Discovery** — `src/services/discoveryRun.ts` + `src/discovery/performerScore.ts`: Nifty 100 momentum score, writes `active_watchlist` + `watchlist_snapshots`.
- **Pattern memory** — `src/pinecone/patternStore.ts` + `src/embeddings/patternEmbedding.ts`: log-return embeddings, cosine similarity, WIN/LOSS metadata.
- **News** — `src/services/news.ts` + `src/services/sentinel-scraper.ts`: ET RSS + Moneycontrol HTML merge → **`news_context`** (daily). Backtest replay headlines come from **`news_archive`** + optional JSON via `src/services/historicalNewsFeed.ts`.
- **NIFTY trend** — `src/services/niftyTrend.ts`: real-time EMA + VWAP trend string from Mongo 1m bars, passed to judge every tick.

---

## MongoDB collections

| Collection | Contents |
|-----------|----------|
| `ohlc_1m` | `{ticker, ts, o, h, l, c, v}` — 1-minute candles |
| `trades` | Live paper/live trade logs with AI reasoning |
| `trades_backtest` | Backtest trades with full `entry + exit + result.pnl` |
| `news_context` | **`date` (YYYY-MM-DD)** + `headlines[]` — one row per day; used by **live** `fetchTodayNewsContext` / RSS / scraper backfill |
| `news_archive` | **`ts`** + `headlines[]` — time-stamped bundles; used by **backtest** `getHeadlinesForBacktest` (no lookahead: headlines with `ts ≤` simulated bar). Fill via `bun run backtest -- --import-news file.json` or your own inserts |
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

### Terminal workflow (recommended)

Terminal 1 (ops/run terminal):
```bash
bun run build
pm2 start ecosystem.config.cjs
pm2 status
pm2 logs trading-bot --lines 100
```
Keep this terminal for PM2 status/logs/restarts.

Terminal 2 (manual checks/commands):
```bash
bun run live-analyze
bun run analyst
```
Use this terminal for on-demand reports and post-mortem runs.

If you edit `.env` or code later:
```bash
pm2 restart ecosystem.config.cjs --update-env
```

PM2 processes:
- `trading-bot` — main daemon, autorestart, runs 24/7
- `evening-live-analyze` — 15:35 IST weekdays, end-of-day numeric stats from `trades`
- `evening-analyst` — 15:45 IST weekdays, post-mortem → lessons_learned
- `nightly-discovery` — 18:20 IST weekdays, Nifty 100 rescore (backup to in-process nightly)

Disable the PM2 nightly-discovery cron OR set `NIGHTLY_DISCOVERY=false` — don't run both.

---

## Disclaimer

Research and education only. Markets involve risk. Past backtests do not guarantee future results. You are responsible for compliance, broker terms, and any capital deployed.
