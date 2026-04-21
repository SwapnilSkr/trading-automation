# Environment Variable Reference

Full list of all `.env` variables, their defaults, and when to change them.

---

## Database

| Variable | Default | Notes |
|----------|---------|-------|
| `MONGODB_URI` | `mongodb://127.0.0.1:27017` | Local or Atlas connection string |
| `MONGODB_DB` | `trading-automation` | Database name |

---

## Pinecone (pattern memory)

| Variable | Default | Notes |
|----------|---------|-------|
| `PINECONE_API_KEY` | — | Required |
| `PINECONE_INDEX` | `trading-patterns` | Index must exist: cosine, 1536 dims |
| `PINECONE_NAMESPACE` | `golden-patterns` | Namespace within index |
| `WEEKEND_OPTIMIZE_SKIP_EXISTING` | `true` | When `true`, `weekend-optimize` batch-fetches Pinecone by id and skips OpenAI embed + upsert if the vector already exists |
| `WEEKEND_OPTIMIZE_RESUME` | `true` | When `true`, persists per-ticker progress in Mongo so an interrupted run can skip finished tickers the same IST calendar day (same ticker universe). Use CLI `--no-resume` to force a clean checkpoint for that run |
| `WEEKEND_OPTIMIZE_FETCH_BATCH` | `100` | Max ids per Pinecone `fetch` when checking existence |

---

## Embeddings

| Variable | Default | Notes |
|----------|---------|-------|
| `OPENAI_API_KEY` | — | For `text-embedding-3-small` (1536-dim) |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | Any OpenAI-compatible 1536-dim model |
| `EMBEDDING_BASE_URL` | `https://api.openai.com/v1` | Override for local embeddings |

If no API key: falls back to a deterministic FNV hash-seeded vector (no real embeddings, Pinecone gate won't work meaningfully).

---

## Judge LLM (OpenRouter)

| Variable | Default | Notes |
|----------|---------|-------|
| `OPENROUTER_API_KEY` | — | Required for live judge |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | Override for local LLM |
| `JUDGE_MODEL` | `anthropic/claude-sonnet-4` | Live judge (high-quality reasoning, ~$0.003/call) |
| `JUDGE_MODEL_BACKTEST` | `google/gemini-2.0-flash-001` | Cheaper backtest model |
| `JUDGE_COOLDOWN_MS` | `300000` (5 min) | Min time between judge calls **per strategy per ticker** in live mode |
| `LIVE_SKIP_JUDGE` | `false` | If `true`, daemon bypasses LLM judge and auto-approves technical triggers |
| `LIVE_DEBUG_SCANS` | `true` | Print per-ticker scan/decision logs in EXECUTION mode (very useful for understanding why trades fire or don't) |
| `LIVE_EXEC_SYNC_ENABLED` | `true` | During EXECUTION, auto-sync recent 1m bars from broker into Mongo |
| `LIVE_EXEC_SYNC_INTERVAL_MINUTES` | `15` | Interval between execution-time auto-sync passes |
| `LIVE_EXEC_SYNC_LOOKBACK_MINUTES` | `120` | Lookback window used per execution-time auto-sync pass |
| `LIVE_EXEC_TICKER_RESYNC_COOLDOWN_MINUTES` | `15` | Per-ticker cooldown for rescue sync when bars are insufficient |
| `PINECONE_GATE_ENABLED` | `true` | Auto-approve from Pinecone without LLM if top match ≥ threshold |
| `PINECONE_GATE_MIN_SCORE` | `0.92` | Cosine similarity threshold for auto-approval (lower = more auto-approvals, higher = stricter) |

**Cost estimation (live):** With 10 tickers, 5-min cooldown per strategy per ticker, 14 strategies → most are suppressed by gates. Expect 3–10 LLM calls/day at Claude Sonnet 4 prices (~$0.003/call = pennies/day).

**Judge prompt structure:** The judge receives a structured multi-section prompt:
- `[SIGNAL]` — strategy, ticker, side, setup description
- `[PRICE ACTION]` — last 5 candles (O/H/L/C/Vol tabular)
- `[INDICATORS]` — RSI(14), ATR(14), VWAP distance, Volume Z-score
- `[PATTERN MEMORY]` — Pinecone similar patterns win rate and count
- `[STRATEGY TRACK RECORD]` — rolling WR/PF from last N executed trades
- `[MARKET CONTEXT]` — NIFTY50 trend + up to 5 news headlines
- `[YESTERDAY'S LESSONS]` — analyst post-mortem summary from prior session (if available)

If no API key: judge always returns `approve=false` (no trades fire).

---

## Angel One SmartAPI (broker)

| Variable | Default | Notes |
|----------|---------|-------|
| `ANGEL_API_KEY` | — | App API key from Angel dashboard |
| `ANGEL_API_SECRET` | — | Dashboard secret (UUID) |
| `ANGEL_CLIENT_CODE` | — | Your client ID (e.g., AACG844081) |
| `ANGEL_PASSWORD` | — | Trading PIN (4-digit) |
| `TOTP_SEED` | — | Base32 secret from Angel "Enable TOTP" — NOT the 6-digit code |
| `ANGEL_CLIENT_LOCAL_IP` | `192.168.1.1` | Your local IP (sent in headers) |
| `ANGEL_CLIENT_PUBLIC_IP` | `127.0.0.1` | Must match the whitelisted static IP in Angel dashboard |
| `ANGEL_MAC_ADDRESS` | `00:00:00:00:00:00` | Your machine's MAC address |
| `ANGEL_EXCHANGE` | `NSE` | Exchange |
| `ANGEL_API_THROTTLE_MS` | `450` | Delay between getCandleData chunk requests |
| `ANGEL_SYNC_TICKER_GAP_MS` | `800` | Extra pause between tickers in sync-history |
| `QUOTE_BATCH_DELAY_MS` | `1100` | Delay between quote batches (≤50 symbols each) |

**TOTP_SEED:** Go to Angel SmartAPI dashboard → Enable TOTP → you'll see a QR code and a Base32 secret below it. Use the Base32 secret here (looks like `4OCBO5ENLFSES4EXHCAXEPJBYU`), NOT the 6-digit rotating code.

If credentials incomplete: falls back to `AngelOneStubBroker` — all broker calls return empty data or no-ops. Data fill commands won't work.

---

## Risk / Execution

| Variable | Default | Notes |
|----------|---------|-------|
| `EXECUTION_ENV` | `PAPER` | `PAPER` = log only, `LIVE` = real Angel orders |
| `DAILY_STOP_LOSS` | `25000` | Kill switch: stop all trading if daily PnL ≤ -₹25,000 |
| `MAX_CONCURRENT_TRADES` | `5` | Max open positions at once |
| `WATCHED_TICKERS` | `RELIANCE,TCS,INFY` | Fallback tickers when active_watchlist is empty |
| `TRADING_TICKER_SOURCE` | `active_watchlist` | `env` = use WATCHED_TICKERS, `active_watchlist` = use Mongo discovery list |

Execution note: with `LIVE_EXEC_SYNC_ENABLED=true`, the daemon no longer depends on post-market `SYNC` alone for intraday bars; it performs periodic top-up sync during EXECUTION and on-demand ticker rescue sync when bar count is insufficient.

---

## ATR-Based Position Sizing

Position size is computed dynamically from ATR to risk a fixed fraction of account equity per trade.

```
riskPerTrade = ACCOUNT_EQUITY × RISK_PER_TRADE_PCT
baseQty      = floor(riskPerTrade / (ATR × ATR_STOP_MULTIPLE))
confMult     = clamp(0.5 + confidence × CONFIDENCE_SCALE_FACTOR, 0.5, 2.0)
qty          = clamp(floor(baseQty × confMult), MIN_QTY_PER_TRADE, MAX_QTY_PER_TRADE)
```

| Variable | Default | Notes |
|----------|---------|-------|
| `ACCOUNT_EQUITY` | `500000` | Account size in INR (used for risk sizing only) |
| `RISK_PER_TRADE_PCT` | `0.01` | Fraction of equity to risk per trade (0.01 = 1% = ₹5,000 on ₹5L) |
| `ATR_PERIOD` | `14` | ATR lookback bars (standard 14-period) |
| `ATR_STOP_MULTIPLE` | `1.5` | Stop distance = ATR × 1.5 |
| `ATR_TARGET_MULTIPLE` | `2.5` | Target distance = ATR × 2.5 (R:R = 1.67:1) |
| `ATR_TRAIL_TRIGGER_MULTIPLE` | `1.0` | Activate trailing stop after 1.0× ATR profit |
| `ATR_TRAIL_DIST_MULTIPLE` | `0.75` | Trail 0.75× ATR below peak |
| `MAX_QTY_PER_TRADE` | `500` | Hard cap on shares per trade |
| `MIN_QTY_PER_TRADE` | `1` | Floor for shares per trade |
| `ATR_EXITS_ENABLED` | `true` | Use ATR-based stop/target/trail (false = fixed %) |
| `ATR_SIZING_ENABLED` | `true` | Use ATR-based qty calc (false = fixed `BACKTEST_POSITION_QTY`) |
| `CONFIDENCE_SCALE_FACTOR` | `1.5` | Scales judge confidence into position size multiplier |

**Example:** RELIANCE at ₹2500 with ATR(14) = ₹15.
- `stopDistance = 15 × 1.5 = ₹22.50`
- `baseQty = 5000 / 22.50 = 222 shares`
- Judge confidence = 0.8: `confMult = clamp(0.5 + 0.8×1.5, 0.5, 2.0) = 1.70`
- `qty = floor(222 × 1.70) = 377 shares` → capped at `MAX_QTY_PER_TRADE`

---

## Exit / Risk Parameters

| Variable | Default | Notes |
|----------|---------|-------|
| `EXIT_STOP_PCT` | `0.012` | Fallback stop loss at 1.2% below entry (when ATR unavailable) |
| `EXIT_TARGET_PCT` | `0.020` | Fallback profit target at 2.0% above entry |
| `EXIT_TRAIL_TRIGGER_PCT` | `0.008` | Fallback trailing stop activates when 0.8% in profit |
| `EXIT_TRAIL_DIST_PCT` | `0.005` | Fallback trailing stop distance: 0.5% below peak |
| `BACKTEST_POSITION_QTY` | `25` | Fallback position size when `ATR_SIZING_ENABLED=false` |

### Strategy Toggles

All 14 strategies are **enabled by default**. The strategy auto-gate (`STRATEGY_AUTO_GATE_ENABLED`) dynamically disables underperformers based on rolling live performance — no need to manually cherry-pick strategies. Disable manually here only if you want to run controlled ablation tests.

| Variable | Default | Notes |
|----------|---------|-------|
| `BACKTEST_ENABLE_ORB_15M` | `true` | Opening range breakout (first 15m high/low) |
| `BACKTEST_ENABLE_ORB_RETEST_15M` | `true` | ORB breakout with retest confirmation |
| `BACKTEST_ENABLE_MEAN_REV_Z` | `true` | Z-score mean reversion vs VWAP |
| `BACKTEST_ENABLE_BIG_BOY_SWEEP` | `true` | Liquidity sweep (PDH/PDL fake-out) |
| `BACKTEST_ENABLE_VWAP_RECLAIM_REJECT` | `true` | VWAP reclaim/rejection |
| `BACKTEST_ENABLE_VWAP_PULLBACK_TREND` | `true` | VWAP pullback trend continuation |
| `BACKTEST_ENABLE_PREV_DAY_HIGH_LOW_BREAK_RETEST` | `true` | Prior-day high/low break and retest |
| `BACKTEST_ENABLE_EMA20_BREAK_RETEST` | `true` | EMA20 break and retest |
| `BACKTEST_ENABLE_VWAP_RECLAIM_CONTINUATION` | `true` | VWAP reclaim continuation |
| `BACKTEST_ENABLE_INITIAL_BALANCE_BREAK_RETEST` | `true` | Initial balance (first 30m) break-retest |
| `BACKTEST_ENABLE_VOLATILITY_CONTRACTION_BREAKOUT` | `true` | Volatility contraction breakout |
| `BACKTEST_ENABLE_INSIDE_BAR_BREAKOUT_WITH_RETEST` | `true` | Inside-bar breakout with retest |
| `BACKTEST_ENABLE_OPEN_DRIVE_PULLBACK` | `true` | Strong open drive pullback entry |
| `BACKTEST_ENABLE_ORB_FAKEOUT_REVERSAL` | `true` | ORB fakeout reversal |

---

## Strategy Auto-Gate (Rolling Performance Filter)

Automatically disables strategies whose recent live performance falls below thresholds. Requires at least 10 trades before gating kicks in (avoids early disabling due to small sample).

| Variable | Default | Notes |
|----------|---------|-------|
| `STRATEGY_AUTO_GATE_ENABLED` | `true` | Enable automatic strategy disabling |
| `STRATEGY_GATE_WINDOW` | `20` | Rolling trade window for evaluation |
| `STRATEGY_GATE_MIN_PF` | `0.8` | Disable strategy if profit factor < 0.8 |
| `STRATEGY_GATE_MIN_WIN_RATE` | `0.3` | Disable strategy if win rate < 30% |

**Log example:** `[Strategy Gate] ORB_15M disabled: PF=0.62<0.8, WR=28%<30% over last 20 trades`

**Tuning:** If strategies get disabled too quickly (small sample noise), raise `STRATEGY_GATE_WINDOW` to 30–50. If you want stricter quality control, raise thresholds to `PF=1.0, WR=0.4`.

---

## Lessons Feedback Loop

The analyst post-mortem (run nightly at 15:45 IST via PM2) writes a `lessons_learned` document into Mongo. At the start of each trading session's EXECUTION phase, the orchestrator loads yesterday's lessons and injects them into every judge call that day.

| Variable | Default | Notes |
|----------|---------|-------|
| `LESSONS_FEEDBACK_ENABLED` | `true` | Inject yesterday's lessons into judge prompt each session |

This creates a self-improving feedback loop: patterns that burned you yesterday get written into the system's "memory" and inform every trade decision the next day.

---

## Volatility Regime Switch (Strategy Gating)

Classifies intraday realized volatility into LOW/MID/HIGH and gates which strategies are allowed to fire. This prevents breakout strategies from firing in chaotic high-vol environments and mean-reversion strategies from firing when the market is too calm to produce overextensions.

| Variable | Default | Notes |
|----------|---------|-------|
| `VOL_REGIME_SWITCH_ENABLED` | `true` | Enable regime-based strategy gating |
| `VOL_REGIME_LOOKBACK_BARS` | `30` | Number of 1m bars used for realized volatility classification |
| `VOL_REGIME_LOW_MAX_PCT` | `0.08` | Realized vol % below this → `LOW` regime |
| `VOL_REGIME_HIGH_MIN_PCT` | `0.22` | Realized vol % at/above this → `HIGH` regime |

**Regime assignments (optimal defaults):**

Breakout strategies work in clean directional moves (LOW-MID), not chaotic HIGH-vol noise:

| Variable | Default | Rationale |
|----------|---------|-----------|
| `VOL_REGIME_ORB_LOW` | `true` | Breakouts in calm markets are clean |
| `VOL_REGIME_ORB_MID` | `true` | Ideal breakout environment |
| `VOL_REGIME_ORB_HIGH` | `false` | Too choppy; breakouts fail |

Mean reversion works when price overextends (MID-HIGH), not when vol is low:

| Variable | Default | Rationale |
|----------|---------|-----------|
| `VOL_REGIME_MEANREV_LOW` | `false` | No overextension in calm markets |
| `VOL_REGIME_MEANREV_MID` | `true` | Good overextension setups |
| `VOL_REGIME_MEANREV_HIGH` | `true` | This is WHERE mean rev works best |

Liquidity sweeps (BIG_BOY) need volatility to produce fake-outs:

| Variable | Default | Rationale |
|----------|---------|-----------|
| `VOL_REGIME_BIGBOY_LOW` | `false` | Insufficient volatility for sweeps |
| `VOL_REGIME_BIGBOY_MID` | `true` | Good sweep environment |
| `VOL_REGIME_BIGBOY_HIGH` | `true` | Sweeps very active in high vol |

VWAP strategies work when price respects VWAP cleanly (LOW-MID):

| Variable | Default | Rationale |
|----------|---------|-----------|
| `VOL_REGIME_VWAP_LOW` | `true` | VWAP highly respected in calm markets |
| `VOL_REGIME_VWAP_MID` | `true` | Good VWAP setup environment |
| `VOL_REGIME_VWAP_HIGH` | `false` | VWAP gets violated randomly in high vol |

---

## Backtest Realism (Microstructure + Charges)

| Variable | Default | Notes |
|----------|---------|-------|
| `BACKTEST_REALISM_ENABLED` | `true` | Master toggle for realistic fills/costs in replay |
| `BACKTEST_ENTRY_LATENCY_BARS` | `1` | Entry delay in bars (`1` = next-bar-open execution) |
| `BACKTEST_PESSIMISTIC_INTRABAR` | `true` | If stop+target hit in same candle, choose adverse outcome |
| `BACKTEST_SPREAD_BPS` | `3.0` | Assumed bid-ask spread (bps); conservative for Indian mid-caps |
| `BACKTEST_BASE_SLIPPAGE_BPS` | `1.5` | Baseline adverse slippage per fill |
| `BACKTEST_IMPACT_BPS_PER_1PCT_PARTICIPATION` | `0.25` | Extra slippage by `qty / bar_volume` participation |
| `BACKTEST_VOLATILITY_SLIPPAGE_COEFF` | `0.1` | Scales bar-range volatility into slippage |
| `BACKTEST_FEES_ENABLED` | `true` | Apply brokerage/taxes model to net PnL |
| `BACKTEST_BROKERAGE_PCT` | `0.0003` | Brokerage % (0.03%) per leg |
| `BACKTEST_BROKERAGE_CAP_PER_ORDER` | `20` | Brokerage cap per order leg (₹) |
| `BACKTEST_STT_SELL_PCT` | `0.00025` | STT on sell turnover |
| `BACKTEST_EXCHANGE_TXN_PCT` | `0.0000297` | Exchange charge on turnover |
| `BACKTEST_SEBI_PCT` | `0.000001` | SEBI charge on turnover |
| `BACKTEST_GST_PCT` | `0.18` | GST on brokerage + exchange charge |
| `BACKTEST_STAMP_DUTY_BUY_PCT` | `0.00003` | Stamp duty on buy turnover |

**Why conservative realism defaults?** If the system is profitable with pessimistic assumptions (3 bps spread, 1.5 bps slippage, 0.25 bps impact), it will perform even better live. Optimistic backtest assumptions create false confidence and disappointment in live trading.

Use `BACKTEST_REALISM_ENABLED=false` when you want quick research-only runs; keep it `true` for execution-realistic evaluation.

---

## Discovery / Watchlist

| Variable | Default | Notes |
|----------|---------|-------|
| `DISCOVERY_SYMBOL_DELAY_MS` | `2000` | Pause between Nifty 100 symbols (daily fetch) |
| `NIGHTLY_DISCOVERY` | `true` | Run discovery-sync automatically in POST_MORTEM |

**CLI (not env):** `bun run discovery-sync -- --refresh-universe` downloads the NSE Nifty 100 CSV and updates `data/ind_nifty100list.csv` when valid. Default runs use the **on-disk CSV only**. **Nightly** in-process discovery does **not** set `refresh-universe` — use a weekend CLI run with `--refresh-universe` if you need the latest index constituents.

---

## Pre-open Pivot

| Variable | Default | Notes |
|----------|---------|-------|
| `PREOPEN_PIVOT` | `true` | Enable pre-open gap/volume filter at ~09:10 IST |
| `PREOPEN_JUDGE` | `false` | Enable LLM pick during pre-open (adds cost) |
| `PREOPEN_MIN_ABS_GAP_PCT` | `1.5` | Min gap-up/down % to qualify |
| `PREOPEN_MIN_VOL_VS_AVG` | `0.2` | Min session volume vs 5-day avg to qualify |
| `PREOPEN_MAX_CANDIDATES` | `50` | Max symbols to quote during pre-open |
| `PREOPEN_MAX_PICKS` | `10` | Max picks for updated watchlist |

Requires: `TRADING_TICKER_SOURCE=active_watchlist`

---

## News

| Variable | Default | Notes |
|----------|---------|-------|
| `NEWS_ET_RSS_URL` | ET markets RSS | ET stocks feed URL |
| `NEWS_SENTINEL` | `false` | Merge Moneycontrol HTML scrape with RSS |
| `SENTINEL_MC_URL` | Moneycontrol markets URL | Override if URL changes |
| `SENTINEL_TIMEOUT_MS` | `15000` | Per-request timeout (ms) for RSS, Moneycontrol, and ET archive fetches |
| `SENTINEL_MAX_RETRIES` | `4` | Retries on `5xx`, `429`, timeouts, and transient network errors |
| `SENTINEL_RETRY_BASE_MS` | `700` | Base backoff between retry attempts (jitter added) |
| `ARCHIVE_SCRAPER_DELAY_MS` | `2500` | Delay between days in `backfill-news-scraper` (rate politeness) |
| `HISTORICAL_NEWS_PATH` | `data/historical_news.json` | JSON file for backtest news replay |

ET archive backfill uses the site's `starttime-*` day URLs (not legacy `day-*`, which 404). Scrapers detect soft 404 HTML shells when present.

**Collections:** `news_context` = daily rows for **live** `fetchTodayNewsContext`; filled by `backfill-news-scraper`. **`news_archive`** = `ts` + headlines for **backtest** replay (`getHeadlinesForBacktest`); fill with `backfill-news-scraper --output-archive`, or `backtest --import-news`, or via `HISTORICAL_NEWS_PATH`. See `docs/architecture.md`.

---

## Benchmark / Trend

| Variable | Default | Notes |
|----------|---------|-------|
| `NIFTY_BENCHMARK_TICKER` | `NIFTY50` | Ticker symbol for macro trend context |

Must have Mongo `ohlc_1m` data for this ticker (fill with `bun run sync-history -- --ticker NIFTY50`).

---

## Health / Emergency

| Variable | Default | Notes |
|----------|---------|-------|
| `HEALTH_PORT` | `3000` | HTTP port for `/health` endpoint |
| `EMERGENCY_SQUARE_OFF_SECRET` | — | If set, enables `POST /v1/emergency/square-off` |

```bash
# Health check
curl http://localhost:3000/health

# Emergency stop all positions
curl -X POST http://localhost:3000/v1/emergency/square-off \
  -H "X-Emergency-Key: your-secret"
```
