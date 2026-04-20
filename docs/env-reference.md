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
| `JUDGE_MODEL` | `deepseek/deepseek-chat` | Live judge (~$0.001/call) |
| `JUDGE_MODEL_BACKTEST` | `google/gemini-2.0-flash-001` | Cheaper backtest model |
| `JUDGE_COOLDOWN_MS` | `900000` (15 min) | Min time between judge calls per ticker in live mode |
| `LIVE_SKIP_JUDGE` | `false` | If `true`, daemon bypasses LLM judge and auto-approves technical triggers |
| `PINECONE_GATE_ENABLED` | `true` | Auto-approve from Pinecone without LLM if top match ≥ threshold |
| `PINECONE_GATE_MIN_SCORE` | `0.98` | Cosine similarity threshold for auto-approval |

**Cost estimation (live):** With 5 tickers, 6.5h session, 15-min cooldown → max 13 judge calls per ticker → 65 calls/day. At $0.001 = **$0.065/day**. After weekend-optimize fills Pinecone, Pinecone gate handles most cases → actual cost is much less.

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
| `MAX_CONCURRENT_TRADES` | `3` | Max open positions at once |
| `WATCHED_TICKERS` | `RELIANCE,TCS,INFY` | Default tickers (used when TRADING_TICKER_SOURCE=env) |
| `TRADING_TICKER_SOURCE` | `env` | `env` = use WATCHED_TICKERS, `active_watchlist` = use Mongo discovery list |

---

## Exit / Risk Parameters

| Variable | Default | Notes |
|----------|---------|-------|
| `EXIT_STOP_PCT` | `0.015` | Stop loss at 1.5% below entry |
| `EXIT_TARGET_PCT` | `0.025` | Profit target at 2.5% above entry |
| `EXIT_TRAIL_TRIGGER_PCT` | `0.01` | Trailing stop activates when 1% in profit |
| `EXIT_TRAIL_DIST_PCT` | `0.0075` | Trailing stop distance: 0.75% below peak |
| `BACKTEST_POSITION_QTY` | `10` | Position size (shares) for backtest PnL calculation |
| `BACKTEST_ENABLE_ORB_15M` | `true` | Enable ORB trigger evaluation |
| `BACKTEST_ENABLE_ORB_RETEST_15M` | `false` | Enable ORB retest confirmation strategy |
| `BACKTEST_ENABLE_MEAN_REV_Z` | `true` | Enable mean-reversion trigger evaluation |
| `BACKTEST_ENABLE_BIG_BOY_SWEEP` | `true` | Enable liquidity sweep trigger evaluation |
| `BACKTEST_ENABLE_VWAP_RECLAIM_REJECT` | `true` | Enable VWAP reclaim/rejection trigger evaluation |
| `BACKTEST_ENABLE_VWAP_PULLBACK_TREND` | `false` | Enable VWAP pullback trend continuation strategy |
| `BACKTEST_ENABLE_PREV_DAY_HIGH_LOW_BREAK_RETEST` | `false` | Enable PDH/PDL break-and-retest strategy |
| `BACKTEST_ENABLE_EMA20_BREAK_RETEST` | `false` | Enable EMA20 break-retest strategy |
| `BACKTEST_ENABLE_VWAP_RECLAIM_CONTINUATION` | `false` | Enable VWAP reclaim continuation strategy |
| `BACKTEST_ENABLE_INITIAL_BALANCE_BREAK_RETEST` | `false` | Enable initial-balance break-retest strategy |
| `BACKTEST_ENABLE_VOLATILITY_CONTRACTION_BREAKOUT` | `false` | Enable volatility-contraction breakout strategy |
| `BACKTEST_ENABLE_INSIDE_BAR_BREAKOUT_WITH_RETEST` | `false` | Enable inside-bar breakout-retest strategy |
| `BACKTEST_ENABLE_OPEN_DRIVE_PULLBACK` | `false` | Enable open-drive pullback continuation strategy |
| `BACKTEST_ENABLE_ORB_FAKEOUT_REVERSAL` | `false` | Enable ORB fakeout reversal strategy |

### Volatility Regime Switch (strategy gating)

| Variable | Default | Notes |
|----------|---------|-------|
| `VOL_REGIME_SWITCH_ENABLED` | `false` | If `true`, allows/blocks strategies by intraday volatility regime |
| `VOL_REGIME_LOOKBACK_BARS` | `30` | Number of 1m bars used for realized volatility regime classification |
| `VOL_REGIME_LOW_MAX_PCT` | `0.08` | Realized vol % below this => `LOW` regime |
| `VOL_REGIME_HIGH_MIN_PCT` | `0.22` | Realized vol % at/above this => `HIGH` regime |
| `VOL_REGIME_ORB_LOW` | `false` | Allow ORB in `LOW` regime |
| `VOL_REGIME_ORB_MID` | `true` | Allow ORB in `MID` regime |
| `VOL_REGIME_ORB_HIGH` | `true` | Allow ORB in `HIGH` regime |
| `VOL_REGIME_MEANREV_LOW` | `true` | Allow MEAN_REV_Z in `LOW` regime |
| `VOL_REGIME_MEANREV_MID` | `true` | Allow MEAN_REV_Z in `MID` regime |
| `VOL_REGIME_MEANREV_HIGH` | `false` | Allow MEAN_REV_Z in `HIGH` regime |
| `VOL_REGIME_BIGBOY_LOW` | `false` | Allow BIG_BOY_SWEEP in `LOW` regime |
| `VOL_REGIME_BIGBOY_MID` | `true` | Allow BIG_BOY_SWEEP in `MID` regime |
| `VOL_REGIME_BIGBOY_HIGH` | `true` | Allow BIG_BOY_SWEEP in `HIGH` regime |
| `VOL_REGIME_VWAP_LOW` | `false` | Allow VWAP_RECLAIM_REJECT in `LOW` regime |
| `VOL_REGIME_VWAP_MID` | `true` | Allow VWAP_RECLAIM_REJECT in `MID` regime |
| `VOL_REGIME_VWAP_HIGH` | `true` | Allow VWAP_RECLAIM_REJECT in `HIGH` regime |

**Tuning guide:**
- If you keep getting stopped out before reaching target → widen stop (`EXIT_STOP_PCT=0.02`)
- If winners often reverse before hitting target → lower target or trail sooner (`EXIT_TRAIL_TRIGGER_PCT=0.008`)
- If losses are large relative to wins → tighten stop (`EXIT_STOP_PCT=0.012`)
- Good rule of thumb: target should be ≥ 1.5× stop (1:1.5 reward/risk minimum)

---

## Backtest Realism (Microstructure + Charges)

| Variable | Default | Notes |
|----------|---------|-------|
| `BACKTEST_REALISM_ENABLED` | `true` | Master toggle for realistic fills/costs in replay |
| `BACKTEST_ENTRY_LATENCY_BARS` | `1` | Entry delay in bars (`1` = next-bar-open execution) |
| `BACKTEST_PESSIMISTIC_INTRABAR` | `true` | If stop+target hit in same candle, choose adverse outcome |
| `BACKTEST_SPREAD_BPS` | `2.0` | Assumed bid-ask spread (bps) |
| `BACKTEST_BASE_SLIPPAGE_BPS` | `1.0` | Baseline adverse slippage per fill |
| `BACKTEST_IMPACT_BPS_PER_1PCT_PARTICIPATION` | `0.15` | Extra slippage by `qty / bar_volume` participation |
| `BACKTEST_VOLATILITY_SLIPPAGE_COEFF` | `0.1` | Scales bar-range volatility into slippage |
| `BACKTEST_FEES_ENABLED` | `true` | Apply brokerage/taxes model to net PnL |
| `BACKTEST_BROKERAGE_PCT` | `0.0003` | Brokerage % (0.03%) per leg |
| `BACKTEST_BROKERAGE_CAP_PER_ORDER` | `20` | Brokerage cap per order leg (₹) |
| `BACKTEST_STT_SELL_PCT` | `0.00025` | STT on sell turnover |
| `BACKTEST_EXCHANGE_TXN_PCT` | `0.0000297` | Exchange charge on turnover |
| `BACKTEST_SEBI_PCT` | `0.000001` | SEBI charge on turnover |
| `BACKTEST_GST_PCT` | `0.18` | GST on brokerage + exchange charge |
| `BACKTEST_STAMP_DUTY_BUY_PCT` | `0.00003` | Stamp duty on buy turnover |

Use `BACKTEST_REALISM_ENABLED=false` when you want quick research-only runs; keep it `true` for execution-realistic evaluation.

---

## Discovery / Watchlist

| Variable | Default | Notes |
|----------|---------|-------|
| `DISCOVERY_SYMBOL_DELAY_MS` | `2000` | Pause between Nifty 100 symbols (daily fetch) |
| `NIGHTLY_DISCOVERY` | `true` | Run discovery-sync automatically in POST_MORTEM |

**CLI (not env):** `bun run discovery-sync -- --refresh-universe` downloads the [NSE Nifty 100 CSV](https://nsearchives.nseindia.com/content/indices/ind_nifty100list.csv) and updates `data/ind_nifty100list.csv` when valid. Default runs use the **on-disk CSV only**. **Nightly** in-process discovery does **not** set `refresh-universe` — use a weekend CLI run with `--refresh-universe` if you need the latest index constituents.

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
| `NEWS_SENTINEL` | `true` | Merge Moneycontrol HTML scrape with RSS |
| `SENTINEL_MC_URL` | Moneycontrol markets URL | Override if URL changes |
| `SENTINEL_TIMEOUT_MS` | `15000` | Per-request timeout (ms) for RSS, Moneycontrol, and ET archive fetches |
| `SENTINEL_MAX_RETRIES` | `4` | Retries on `5xx`, `429`, timeouts, and transient network errors |
| `SENTINEL_RETRY_BASE_MS` | `700` | Base backoff between retry attempts (jitter added) |
| `ARCHIVE_SCRAPER_DELAY_MS` | `2500` | Delay between days in `backfill-news-scraper` (rate politeness) |
| `HISTORICAL_NEWS_PATH` | `data/historical_news.json` | JSON file for backtest news replay |

ET archive backfill uses the site’s `starttime-*` day URLs (not legacy `day-*`, which 404). Scrapers detect soft 404 HTML shells when present.

**Collections:** `news_context` = daily rows for **live** `fetchTodayNewsContext`. **`news_archive`** = `ts` + headlines for **backtest** replay (`getHeadlinesForBacktest`); not filled by `backfill-news-scraper` — use `backtest --import-news` or `HISTORICAL_NEWS_PATH`. See `docs/architecture.md`.

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
