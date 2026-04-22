# Alpha Architect — Trading Automation

Bun/TypeScript intraday trading system for NSE (India). Discovers momentum stocks from Nifty 100, backtests strategies with full PnL simulation, mines price patterns into Pinecone memory, and paper-trades autonomously with AI-assisted signal filtering.

**Status:** PAPER trading only (`EXECUTION_ENV=PAPER`). No real orders are placed until you explicitly change that.

---
## Start Here (Simple)

If you only want the practical flow, use this:

1. Open terminal 1:
```bash
bun run ops
```
Choose `Prepare/resume trading for selected date`.

2. Open terminal 2:
```bash
bun run start
```

3. Check health:
```bash
curl http://127.0.0.1:3000/health
```

For plain-English operator help, read:
- `docs/instructions.md`

---

## How the system works (30-second overview)

```
                      ┌───────────────────────────────────────────────────┐
                      │              Main Daemon (60s tick)                │
                      │                                                     │
   Angel SmartAPI ───►│   INIT → OBSERVE → EXECUTE → SQUAREOFF            │
   (broker + OHLC)    │                │                                   │
                      │      ┌─────────┴──────────────────┐               │
   MongoDB ◄──────────│      │       ExecutionEngine        │               │
   (candles, trades)  │      │  1. Load strategy health     │               │
                      │      │  2. Load yesterday's lessons │               │
   Pinecone ◄─────────│      │  3. Read Mongo 1m candles   │───► trade log │
   (pattern memory)   │      │  4. Risk + market gates      │               │
                      │      │  5. Strategy auto-gate (PF/WR)│              │
   OpenRouter ◄───────│      │  6. Consensus Pinecone gate │               │
   (model from .env)  │      │  7. ATR sizing + judge (LLM) │               │
                      │      └──────────────────────────────┘               │
                      │   SYNC → POST_MORTEM (nightly discovery)            │
                      └───────────────────────────────────────────────────┘
```

**Phases (IST weekdays only):**

| Phase | Time | What happens |
|-------|------|--------------|
| INIT | 09:00–09:15 | Auth, news fetch, optional pre-open pivot |
| OBSERVATION | 09:15–09:30 | VWAP calibration, no trades |
| EXECUTION | 09:30–15:15 | Scan every 60s — triggers → vol/strategy gates → hard risk gates → Pinecone consensus → judge → order |
| SQUARE_OFF | 15:15–15:30 | Close all intraday positions |
| SYNC | 15:30–17:00 | Backfill today's 1m OHLC from Angel (shared SmartAPI limiter prevents burst rate-limit spikes) |
| POST_MORTEM | 18:00–21:00 | Nightly discovery-sync (Nifty 100 rescore) |

Daemon daily jobs (same `bun run start` process):
- **15:35 IST**: live-analyze summary
- **15:45 IST**: analyst post-mortem (`lessons_learned` update)

**Exit logic (per position, live paper + backtest):**

ATR-based exits (primary, adapts to each stock's volatility):
- Stop loss at **1.5× ATR(14)** below entry
- Partial exit: **33%** at **1.0× ATR**, **33%** at **2.0× ATR**
- Remaining runner trails after **1.0× ATR** move, trailing **0.75× ATR** below peak
- Hard close at 15:15 regardless

Fixed-% exits (fallback when ATR unavailable):
- Stop loss at **1.2%**, target at **2.0%**, trailing trigger at **0.8%**, trail distance **0.5%**

**Position sizing (ATR-based, risk-per-trade):**
- Risk per trade = 1% of account equity (₹5,000 on ₹5L account)
- `qty = riskPerTrade / (ATR × stopMultiple)` × risk/market multipliers
- LLM confidence does **not** increase size by default (`CONFIDENCE_SIZING_ENABLED=false`)
- Bounds: 1–500 shares per trade

**Signal pipeline (EXECUTION phase, per ticker, every 60s):**
1. **Vol-regime gate** — classify intraday vol as LOW/MID/HIGH; suppress strategies that don't work in current regime
2. **Strategy auto-gate** — disable strategies with rolling PF < 0.8 or WR < 30% over last 20 trades
3. **Hard risk/market/time gates** — daily/weekly drawdown, sector/side/correlation/exposure caps, NIFTY/breadth, strategy-specific windows
4. **Shadow layer-1 eval (optional)** — cheap veto candidate (`volume z-score`, `ATR%`) logged for offline calibration; observe-only unless explicitly enforced
5. **Pinecone consensus gate** — require 3+ strong same-strategy neighbors and ≥60% weighted win rate before auto-approval
6. **Judge (LLM)** — model from `.env` (`JUDGE_MODEL`) via OpenRouter with enriched prompt (price action, indicators, track record, lessons)

**Token cost:** Pinecone now skips the LLM only on consensus: 3+ strong same-strategy neighbors and ≥60% weighted win rate. Expect fewer unsafe auto-approvals and more LLM calls until strategy-specific memory builds up.

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
| `OPENROUTER_API_KEY` | Judge LLM (default live model: `deepseek/deepseek-chat`) |
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
Scores all 100 Nifty stocks by momentum (5-day return × volume ratio), picks the top 20, and backfills their 1m candles. Uses the shared SmartAPI limiter (`ANGEL_HTTP_*`) so rate-limit retries are adaptive instead of fixed sleeps only.

**Universe source:** By default symbols come from `data/ind_nifty100list.csv` in the repo. **`--refresh-universe`** downloads the official NSE Nifty 100 CSV, overwrites that file when the download succeeds (≥90 symbols), then scores; if NSE fails, it falls back to the existing CSV. The daemon's **nightly** `discovery-sync` does **not** pass this flag (it always uses the on-disk CSV unless you change the code).

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
Writes **one row per calendar day** into Mongo ``news_context`` (used by ``fetchTodayNewsContext`` in the live daemon). With ``--output-archive``, also writes ``news_archive`` (timestamped at 09:30 IST per day) so backtest replay gets causal news headlines. Archive writes are day-level upserts with headline dedup, so reruns fetch again but avoid duplicate same-day headlines. **Bar replay backtests** do **not** read `news_context`; they use ``news_archive`` and/or ``HISTORICAL_NEWS_PATH`` JSON — see [MongoDB collections](#mongodb-collections).

### Step 4 — Mine price patterns into Pinecone
```bash
bun run weekend-optimize
```
Walks 6 months of 1m candles for every ticker in Mongo, finds bars with >2% moves in the next 30 minutes, embeds the preceding 30-bar window, and upserts to Pinecone. Pinecone usage now runs through a quota/storage governor (`PINECONE_*_SOFT_LIMIT`, auto-disable on RU/WU exhaustion, oldest-first eviction on storage-full).

Note: mined vectors use `strategy=MINED`, so they enrich judge context immediately. Strict no-LLM auto-approval requires same-strategy neighbors; expect more judge calls until strategy-labelled memory accumulates.

### Step 5 — Run the backtest
```bash
bun run backtest -- --from 2026-03-01 --to 2026-04-17 --watchlist-snapshots
```
Full portfolio-level bar replay with global concurrent-position state and exit simulation (stop/target/trailing). Writes to `trades_backtest` with complete entry + exit + PnL.
Replay uses causal context: news is filtered by `ts <= simulated bar`, watchlist snapshots are date-bound, and Pinecone neighbors are filtered to dates strictly before the simulated session day. Replay now evaluates each simulated timestamp across all active tickers in one timeline so portfolio gates are tested under concurrent exposures.

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
| `bun run ops` | Interactive operator console: daily status, repair, replay, analyst/discovery runs |
| `bun run dev` | Watch mode (auto-restart on file change) |
| `bun run typecheck` | TypeScript type check (no emit) |
| `bun run build` | Bundle all entry points to `dist/` for PM2 |
| `bun run sync-history` | Backfill 1m OHLC from Angel for specific tickers/days |
| `bun run discovery-sync` | Score Nifty 100, write top-N to active_watchlist + OHLC |
| `bun run backfill-news` | Manually seed news_context rows (edit the script for dates) |
| `bun run backfill-news-scraper` | Scrape ET archive headlines into news_context |
| `bun run weekend-optimize` | Mine price patterns from all Mongo tickers → Pinecone |
| `bun run backtest` | Full replay with PnL simulation → trades_backtest |
| `bun run backtest-snapshots` | One-shot: snapshot tickers → OHLC sync → clear trades_backtest → backtest → analyze (shows effective judge model and auto-refreshes replay news coverage) |
| `bun run backtest-ablation` | Run multi-profile strategy ablation on same window (single-strategy, disable-one, and regime-switch profiles) |
| `bun run backtest-analyze` | Print win rate, Sharpe, profit factor from trades_backtest |
| `bun run live-analyze` | Print end-of-day stats for live/paper `trades` (default: today IST) |
| `bun run risk-report` | Summarize hard risk/market gate blocks from `trades.risk_eval` |
| `bun run shadow-eval-report` | Summarize shadow layer-1 vs layer-2 disagreement metrics from `trades.shadow_eval` |
| `bun run confidence-calibration-report` | Compare confidence buckets and decision paths vs realized outcomes |
| `bun run monte-carlo-report` | Randomize backtest trade order to estimate max drawdown distribution |
| `bun run walk-forward-backtest` | Run rolling out-of-sample backtest windows |
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

### operator console
```bash
bun run ops
bun run ops -- --status
bun run ops -- --date 2026-04-21 --status
bun run ops -- --date 2026-04-21 --prepare
bun run ops -- --date 2026-04-21 --replay
```

Use `ops` when you missed part of a day or started late. It shows whether the watchlist snapshot, active watchlist, news, OHLC coverage, analyst lesson, replay rows, and recent operator actions exist for a date.
`ops` also audits the last `OPS_MISSING_TRADING_DAYS_LOOKBACK` trading days and lists incomplete days (with exact missing reasons), so you can repair backlog days one by one.
`ops` now also prints a decision funnel for the selected day (`total -> risk veto -> cooldown -> deny/other -> executed`) so you can see exactly where trades are getting blocked.
From the menu you can run `Repair missing trading days (guided)`, repair a single day, sync missing bars, run a replay, run analyst, or run discovery.
`ops` includes an `ops-sentinel` recommendation and a one-click `Run suggested action (sentinel)` entry.
For custom range replay, `ops` can also run side-by-side comparison mode: baseline realism profile and a research profile (softer microstructure friction) without changing default backtest logic.

### backtest flags
```bash
bun run backtest -- --from 2026-01-01 --to 2026-04-17 --tickers RELIANCE,TCS
bun run backtest -- --from 2026-01-01 --to 2026-04-17 --ticker-source snapshots
bun run backtest -- --from 2026-01-01 --to 2026-04-17 --watchlist-snapshots
bun run backtest -- --from 2026-01-01 --to 2026-04-17 --skip-judge      # technical-only deterministic mode, no LLM
bun run backtest -- --from 2026-01-01 --to 2026-04-17 --no-persist      # dry run
# one-shot sequence: snapshot ticker union -> sync-history -> clear trades_backtest -> backtest -> analyze
bun run backtest-snapshots -- --from 2026-03-20 --to 2026-04-17 --skip-judge
bun run backtest-snapshots -- --from 2026-03-20 --to 2026-04-17 --judge-model deepseek/deepseek-chat
bun run backtest-snapshots -- --from 2026-03-20 --to 2026-04-17 --fail-on-missing-news   # fail when news coverage is missing/weak
# options: --no-sync --no-clear-trades --no-analyze --no-persist --step 15 --tickers-fallback A,B --force-sync-all --judge-model <id> --fail-on-missing-news --news-min-headlines N --no-auto-backfill-news --news-backfill-no-filter
# run profile comparison on same date range
bun run backtest-ablation -- --from 2026-03-20 --to 2026-04-02 --no-clear-first
# options: --skip-judge --sync --force-sync-all --step 15
# --profiles baseline,all-strategies,regime-switch,orb15-only,orb-retest-only,meanrev-only,bigboy-only,...
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

### risk and validation reports
```bash
bun run risk-report -- --days 5 --env PAPER
bun run confidence-calibration-report -- --days 20 --env PAPER
bun run confidence-calibration-report -- --source backtest
bun run monte-carlo-report -- --last --iters 1000
bun run walk-forward-backtest -- --from 2026-03-01 --to 2026-04-17 --watchlist-snapshots --skip-judge
```

### shadow-eval-report flags
```bash
bun run shadow-eval-report                      # today IST
bun run shadow-eval-report -- --days 5          # last 5 IST sessions ending today
bun run shadow-eval-report -- --days 5 --env PAPER
bun run shadow-eval-report -- --date 2026-04-20 --env LIVE
```

---

## Tuning the system

All tunable without code changes via `.env`:

```bash
# ATR-based position sizing (primary)
ACCOUNT_EQUITY=500000         # your account size in INR
RISK_PER_TRADE_PCT=0.01       # 1% risk per trade = ₹5000 on ₹5L account
ATR_PERIOD=14                 # ATR lookback bars
ATR_STOP_MULTIPLE=1.5         # stop at 1.5x ATR below entry
ATR_TARGET_MULTIPLE=2.5       # target at 2.5x ATR above entry
ATR_TRAIL_TRIGGER_MULTIPLE=1.0 # activate trail after 1.0x ATR profit
ATR_TRAIL_DIST_MULTIPLE=0.75  # trail 0.75x ATR below peak
MAX_QTY_PER_TRADE=500         # cap: never buy more than 500 shares
MAX_NOTIONAL_PER_TRADE_PCT=0.25 # cap notional per trade at 25% of equity
MIN_QTY_PER_TRADE=1           # floor: always at least 1 share
CONFIDENCE_SCALE_FACTOR=1.5   # used only when CONFIDENCE_SIZING_ENABLED=true
CONFIDENCE_SIZING_ENABLED=false # false = confidence approves/denies only, no size boost
CONFIDENCE_MULTIPLIER_MAX=1.3 # cap when confidence sizing is explicitly enabled

# Institutional hard risk gates
DAILY_STOP_LOSS=15000
MAX_SECTOR_POSITIONS=2
MAX_SAME_SIDE_POSITIONS=3
MAX_CORRELATION_WITH_OPEN=0.70
ROLLING_3D_DRAWDOWN_LIMIT=40000
WEEKLY_DRAWDOWN_LIMIT=50000
CONSECUTIVE_LOSS_THROTTLE=3
LOSS_THROTTLE_SIZE_MULTIPLIER=0.5

# Market and time gates
MARKET_GATE_ENABLED=true
MARKET_BLOCK_LONG_BREAKOUTS_NIFTY_PCT=-1.0
MARKET_BLOCK_LONG_BREAKOUTS_BREADTH=0.3
NO_FRESH_ENTRIES_AFTER=14:30
ORB_ENTRY_START=09:30
ORB_ENTRY_END=11:30
VWAP_ENTRY_START=10:00
VWAP_ENTRY_END=14:00
MEAN_REV_ENTRY_START=10:00
MEAN_REV_ENTRY_END=14:30

# Pinecone consensus auto-approval
PINECONE_GATE_MIN_NEIGHBORS=3
PINECONE_GATE_CONSENSUS_MIN_SCORE=0.85
PINECONE_GATE_MIN_WIN_RATE=0.60

# Fixed-% fallback exits (used when ATR unavailable)
EXIT_STOP_PCT=0.012           # 1.2% stop loss
EXIT_TARGET_PCT=0.020         # 2.0% profit target
EXIT_TRAIL_TRIGGER_PCT=0.008  # start trailing after 0.8% profit
EXIT_TRAIL_DIST_PCT=0.005     # trail 0.5% below peak

# Shadow two-layer evaluation (observe-only rollout)
SHADOW_EVAL_ENABLED=false         # true = log layer1/layer2/final/counterfactual per decision
SHADOW_EVAL_ENFORCE_LAYER1=false  # keep false initially; true = hard veto before Pinecone/LLM
LAYER1_MIN_VOLUME_Z=-0.8          # layer1 blocks if volume z-score is below this
LAYER1_MAX_ATR_PCT=3.5            # layer1 blocks if ATR(14)/price% exceeds this

# Strategy toggles — all enabled; auto-gate disables losers dynamically
BACKTEST_ENABLE_ORB_15M=true
BACKTEST_ENABLE_ORB_RETEST_15M=true
BACKTEST_ENABLE_MEAN_REV_Z=true
BACKTEST_ENABLE_BIG_BOY_SWEEP=true
BACKTEST_ENABLE_VWAP_RECLAIM_REJECT=true
BACKTEST_ENABLE_VWAP_PULLBACK_TREND=true
BACKTEST_ENABLE_PREV_DAY_HIGH_LOW_BREAK_RETEST=true
BACKTEST_ENABLE_EMA20_BREAK_RETEST=true
BACKTEST_ENABLE_VWAP_RECLAIM_CONTINUATION=true
BACKTEST_ENABLE_INITIAL_BALANCE_BREAK_RETEST=true
BACKTEST_ENABLE_VOLATILITY_CONTRACTION_BREAKOUT=true
BACKTEST_ENABLE_INSIDE_BAR_BREAKOUT_WITH_RETEST=true
BACKTEST_ENABLE_OPEN_DRIVE_PULLBACK=true
BACKTEST_ENABLE_ORB_FAKEOUT_REVERSAL=true

# Strategy auto-gate (rolling performance filter)
STRATEGY_AUTO_GATE_ENABLED=true
STRATEGY_GATE_WINDOW=20       # evaluate over last 20 trades
STRATEGY_GATE_MIN_TRADES=40   # don't disable until enough closed-trade sample
STRATEGY_GATE_MIN_PF=0.8      # disable if profit factor < 0.8
STRATEGY_GATE_MIN_WIN_RATE=0.3 # disable if win rate < 30%

# Volatility regime gating (strategy ↔ regime pairing)
VOL_REGIME_SWITCH_ENABLED=true
VOL_REGIME_LOW_MAX_PCT=0.08   # below 0.08% realized vol = LOW
VOL_REGIME_HIGH_MIN_PCT=0.22  # above 0.22% realized vol = HIGH

# Judge cost control
JUDGE_COOLDOWN_MS=300000      # 5 min between judge calls per strategy per ticker
RISK_VETO_RETRY_COOLDOWN_MS=60000 # 1 min retry wait after hard risk veto
CANDIDATE_QUEUE_ENABLED=true  # rank and shortlist triggers per ticker
MAX_CANDIDATES_PER_TICKER=2   # evaluate top-N candidates per ticker per scan
REPLACEMENT_ENABLED=true      # allow replacing weakest open position when book is full
REPLACEMENT_MIN_SCORE_DELTA=0.15 # require meaningful quality edge to replace
REPLACEMENT_MIN_CONFIDENCE=0.65 # replacement needs at least this judge confidence
LIVE_SKIP_JUDGE=false         # true => bypass LLM judge (technical-only)
PINECONE_GATE_MIN_SCORE=0.92  # legacy; consensus settings above control auto-approval
JUDGE_MODEL=deepseek/deepseek-chat

# Lessons feedback loop
LESSONS_FEEDBACK_ENABLED=true # inject yesterday's lessons into judge prompt

# Partial exits
PARTIAL_EXITS_ENABLED=true
PARTIAL_EXIT_1_ATR_MULTIPLE=1.0
PARTIAL_EXIT_1_QTY_PCT=0.33
PARTIAL_EXIT_2_ATR_MULTIPLE=2.0
PARTIAL_EXIT_2_QTY_PCT=0.33
```

### Shadow-eval rollout (recommended)
```bash
# 1) Observe only
SHADOW_EVAL_ENABLED=true
SHADOW_EVAL_ENFORCE_LAYER1=false

# 2) Let paper daemon run for a few sessions, then inspect disagreement
bun run shadow-eval-report -- --days 5 --env PAPER

# 3) Only after review, enforce layer-1 in paper first
SHADOW_EVAL_ENFORCE_LAYER1=true
```

**Common tuning moves based on backtest output:**
- Profit factor < 1 and win rate > 50%: targets too small, raise `ATR_TARGET_MULTIPLE` or `EXIT_TARGET_PCT`
- Profit factor < 1 and win rate < 40%: entries are bad, tighten Z-score threshold or ORB volume filter
- Win rate OK but large drawdown: tighten `ATR_STOP_MULTIPLE` or `EXIT_STOP_PCT`
- Good profit factor but few trades: judge cooldown too high (`JUDGE_COOLDOWN_MS`) or Pinecone gate too strict
- Strategy auto-gate too aggressive: lower `STRATEGY_GATE_MIN_PF` or increase `STRATEGY_GATE_WINDOW`
- ATR sizing producing too-large positions: lower `RISK_PER_TRADE_PCT` or `MAX_QTY_PER_TRADE`

---

## Architecture

See `docs/architecture.md` for the full system diagram and data flow.

- **Broker** — `src/broker/angelOneBroker.ts`: SmartAPI REST (auth, 1m/daily candles, quotes, orders, positions). Falls back to stub if credentials incomplete.
- **Indicators** — `src/indicators/`: VWAP, RSI(14), Z-score vs VWAP, volume Z-score, RSI divergence, opening range, prior-day high/low, **ATR(14)**.
- **Strategies** — `src/strategies/triggers.ts`: 14 strategies — ORB_15M, ORB_RETEST_15M, MEAN_REV_Z, BIG_BOY_SWEEP, VWAP_RECLAIM_REJECT, VWAP_PULLBACK_TREND, PREV_DAY_HIGH_LOW_BREAK_RETEST, EMA20_BREAK_RETEST, VWAP_RECLAIM_CONTINUATION, INITIAL_BALANCE_BREAK_RETEST, VOLATILITY_CONTRACTION_BREAKOUT, INSIDE_BAR_BREAKOUT_WITH_RETEST, OPEN_DRIVE_PULLBACK, ORB_FAKEOUT_REVERSAL.
- **Strategy auto-gate** — `src/execution/strategyTracker.ts`: rolling 20-trade PF/WR gate; auto-disables underperforming strategies.
- **Execution** — `src/execution/ExecutionEngine.ts`: signal → vol/strategy gates → hard risk/market/time gates → optional layer-1 shadow eval → Pinecone consensus → enriched judge → ATR-based sizing → paper order → live exit tracking.
- **Risk gates** — `src/risk/`: portfolio exposure, sector/side/correlation caps, NIFTY/breadth gates, strategy time windows.
- **Ticker metadata** — `data/ind_nifty100list.csv` provides sectors; `data/ticker_metadata.json` provides beta overrides.
- **Exit simulation** — `src/execution/exitSimulator.ts`: bar-by-bar stop/trailing plus partial scale-outs for backtest, ATR-aware.
- **Discovery** — `src/services/discoveryRun.ts` + `src/discovery/performerScore.ts`: Nifty 100 momentum score, writes `active_watchlist` + `watchlist_snapshots`.
- **Pattern memory** — `src/pinecone/patternStore.ts` + `src/embeddings/patternEmbedding.ts`: log-return embeddings, cosine similarity, WIN/LOSS metadata.
- **News** — `src/services/news.ts` + `src/services/sentinel-scraper.ts`: ET RSS + Moneycontrol HTML merge → **`news_context`** (daily). Backtest replay headlines come from **`news_archive`** + optional JSON via `src/services/historicalNewsFeed.ts`.
- **NIFTY trend** — `src/services/niftyTrend.ts`: real-time EMA + VWAP trend string from Mongo 1m bars, passed to judge every tick.
- **Lessons feedback** — Analyst post-mortem writes `lessons_learned`; orchestrator loads yesterday's lessons on first EXECUTION tick and passes them into the judge prompt.

---

## MongoDB collections

| Collection | Contents |
|-----------|----------|
| `ohlc_1m` | `{ticker, ts, o, h, l, c, v}` — 1-minute candles |
| `trades` | Live paper/live trade logs with AI reasoning, qty, atr_at_entry |
| `trades_backtest` | Backtest trades with full `entry + partial exits + exit + result.pnl` |
| `news_context` | **`date` (YYYY-MM-DD)** + `headlines[]` — one row per day; used by **live** `fetchTodayNewsContext` / RSS / scraper backfill |
| `news_archive` | **`ts`** + `headlines[]` — time-stamped bundles; used by **backtest** `getHeadlinesForBacktest` (no lookahead: headlines with `ts ≤` simulated bar). Fill via `bun run backtest -- --import-news file.json` or your own inserts |
| `active_watchlist` | `{_id: "current_session", tickers[]}` — current trading list |
| `watchlist_snapshots` | Dated snapshots for no-lookahead backtest |
| `lessons_learned` | Post-mortem summaries from analyst runs; injected into judge prompt next session |

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

**What gets counted**

- **`live-analyze`** — Loads all `trades` whose `entry_time` falls on the chosen **IST calendar day** (default: today). **PnL, win rate, and strategy/ticker breakdowns include only rows where `order_executed` is not `false`** (real entries after the judge + safety path). Rows where the judge rejected the signal (`order_executed: false`) are **omitted** from those stats; if nothing executed, it prints how many decision-only rows were skipped.
- **`analyst`** — Uses the **same executed-trade filter** for metrics and for the two post-mortem judge prompts. It **always upserts** Mongo **`lessons_learned`** for that IST date (one document per day, keyed by `date`), including metrics and a short trade list—even when there were **zero** executed trades that day.

**Restarts** — The live daemon can restart any time; these commands only read **what is already stored in Mongo for that day**. They do not depend on process uptime, PM2 session, or a single continuous run.

If you edit `.env` or code later:
```bash
pm2 restart ecosystem.config.cjs --update-env
```

PM2 is optional and now only needs the main process:
- `trading-bot` — main daemon, autorestart, runs 24/7

`evening-live-analyze`, `evening-analyst`, and nightly discovery are now part of the daemon loop by default.

---

## Disclaimer

Research and education only. Markets involve risk. Past backtests do not guarantee future results. You are responsible for compliance, broker terms, and any capital deployed.
