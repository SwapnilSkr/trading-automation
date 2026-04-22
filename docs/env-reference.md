# Environment Variable Reference

Full list of all `.env` variables, their defaults, and when to change them.

---

## Read This First (Simple)

If you are not sure what to edit, start with only these:

1. Broker login: `ANGEL_API_KEY`, `ANGEL_CLIENT_CODE`, `ANGEL_PASSWORD`, `TOTP_SEED`
2. Safety mode: `EXECUTION_ENV` (`PAPER` is safest)
3. Judge model: `JUDGE_MODEL` (live) and `JUDGE_MODEL_BACKTEST` (replay)
4. Hard risk caps: `DAILY_STOP_LOSS`, `MAX_CONCURRENT_TRADES`
5. Replay news quality: `BACKTEST_NEWS_MIN_HEADLINES_PER_DAY`

If in doubt, keep defaults and run in paper mode.

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
| `PINECONE_RU_SOFT_LIMIT` | `0` | Monthly read-unit soft cap (`0` disables); when reached, reads are paused if auto-disable is enabled |
| `PINECONE_WU_SOFT_LIMIT` | `0` | Monthly write-unit soft cap (`0` disables); when reached, writes are paused if auto-disable is enabled |
| `PINECONE_AUTO_DISABLE_READS_ON_RU_EXHAUST` | `true` | Auto-disables Pinecone reads for the remainder of the month on RU exhaustion/rate-limit errors |
| `PINECONE_AUTO_DISABLE_WRITES_ON_WU_EXHAUST` | `true` | Auto-disables Pinecone writes for the remainder of the month on WU exhaustion/rate-limit errors |
| `PINECONE_AUTO_EVICT_ON_STORAGE_FULL` | `true` | On storage-full upsert errors, evicts oldest IDs and retries |
| `PINECONE_STORAGE_EVICT_BATCH` | `200` | Number of IDs deleted in one storage-pressure eviction pass |
| `PINECONE_STORAGE_EVICT_SCAN_PAGES` | `10` | Max `listPaginated` pages scanned to collect eviction candidates |
| `PINECONE_STORAGE_REALLOCATE_WAIT_MS` | `20000` | Wait after delete before retrying upsert to allow storage reallocation |
| `PINECONE_STORAGE_MAX_EVICTION_RETRIES` | `3` | Max eviction+retry attempts per upsert |
| `PINECONE_GOVERNOR_LOG_COOLDOWN_MS` | `60000` | Minimum interval between repeated Pinecone governor warnings |

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
| `JUDGE_MODEL` | `deepseek/deepseek-chat` | Live judge model |
| `JUDGE_MODEL_BACKTEST` | `google/gemini-2.0-flash-001` | Cheaper backtest model |
| `OPS_AI_MODEL` | `google/gemma-4-31b-it:free` | Model used by `bun run ops-ai` |
| `OPS_MISSING_TRADING_DAYS_LOOKBACK` | `10` | `ops` audits this many recent trading days for missing artifacts and repair queue |
| `FUNNEL_OPTIMIZER_LOOKBACK_DAYS` | `5` | Decision-funnel lookback window for `funnel-optimize` and ops tuning |
| `FUNNEL_OPTIMIZER_MIN_DECISIONS` | `120` | Minimum decisions required before optimizer proposes tuning |
| `FUNNEL_OPTIMIZER_DOMINANCE_PCT` | `0.35` | Dominant blocker share threshold (non-executed subset) |
| `FUNNEL_OPTIMIZER_MAX_CHANGES_PER_WEEK` | `1` | Weekly safety cap for applied `.env` tuning changes |
| `JUDGE_COOLDOWN_MS` | `300000` (5 min) | Min time between judge calls **per strategy per ticker** in live mode |
| `ADAPTIVE_JUDGE_COOLDOWN_ENABLED` | `true` | If `true`, cooldown is scaled by candidate quality score instead of fixed `JUDGE_COOLDOWN_MS` |
| `ADAPTIVE_JUDGE_COOLDOWN_MIN_MS` | `60000` (1 min) | Lower bound for adaptive cooldown (best candidates) |
| `ADAPTIVE_JUDGE_COOLDOWN_MAX_MS` | `300000` (5 min) | Upper bound for adaptive cooldown (weak candidates) |
| `RISK_VETO_RETRY_COOLDOWN_MS` | `60000` (1 min) | Min retry wait after a hard `RISK_VETO` for the same strategy+ticker |
| `CANDIDATE_QUEUE_ENABLED` | `true` | Rank and cap trigger candidates per ticker before full decisioning |
| `MAX_CANDIDATES_PER_TICKER` | `2` | Maximum ranked candidates evaluated per ticker each scan |
| `REPLACEMENT_ENABLED` | `true` | Allow replacing weakest open position when book is full |
| `REPLACEMENT_MIN_SCORE_DELTA` | `0.15` | Minimum incoming-vs-weakest score edge required for replacement |
| `REPLACEMENT_MIN_CONFIDENCE` | `0.65` | Minimum judge confidence required before replacement is allowed |
| `LIVE_SKIP_JUDGE` | `false` | If `true`, daemon bypasses LLM judge and auto-approves technical triggers |
| `LIVE_DEBUG_SCANS` | `true` | Print per-ticker scan/decision logs in EXECUTION mode (very useful for understanding why trades fire or don't) |
| `SHADOW_EVAL_ENABLED` | `false` | Log layer-1/layer-2/final/counterfactual decisions into `trades.shadow_eval` (observe-only mode) |
| `SHADOW_EVAL_ENFORCE_LAYER1` | `false` | If `true`, layer-1 veto is enforced before Pinecone/LLM (start with `false`) |
| `LAYER1_MIN_VOLUME_Z` | `-0.8` | Layer-1 block threshold: `volume_z < this` |
| `LAYER1_MAX_ATR_PCT` | `3.5` | Layer-1 block threshold: `ATR(14)/price × 100 > this` |
| `LIVE_EXEC_SYNC_ENABLED` | `true` | During EXECUTION, auto-sync recent 1m bars from broker into Mongo |
| `LIVE_EXEC_SYNC_INTERVAL_MINUTES` | `15` | Interval between execution-time auto-sync passes |
| `LIVE_EXEC_SYNC_LOOKBACK_MINUTES` | `120` | Lookback window used per execution-time auto-sync pass |
| `LIVE_EXEC_TICKER_RESYNC_COOLDOWN_MINUTES` | `15` | Per-ticker cooldown for rescue sync when bars are insufficient |
| `PINECONE_GATE_ENABLED` | `true` | Auto-approve from Pinecone without LLM only when consensus rules pass |
| `PINECONE_GATE_MIN_SCORE` | `0.92` | Legacy single-neighbor score retained for compatibility; consensus settings now control approval |
| `PINECONE_GATE_MIN_NEIGHBORS` | `3` | Minimum strong neighbors required before Pinecone can auto-approve |
| `PINECONE_GATE_CONSENSUS_MIN_SCORE` | `0.85` | Minimum score for a neighbor to count in consensus |
| `PINECONE_GATE_MIN_WIN_RATE` | `0.6` | Minimum weighted win rate across strong neighbors |
| `PINECONE_GATE_REQUIRE_SAME_STRATEGY` | `true` | If true, only same-strategy neighbors count |
| `PINECONE_GATE_SAME_SECTOR_WEIGHT` | `1.2` | Weight boost for same-sector neighbors |
| `PINECONE_GATE_SAME_REGIME_WEIGHT` | `1.1` | Weight boost for same-vol-regime neighbors |

**Cost estimation (live):** With 10 tickers, 5-min cooldown per strategy per ticker, and all risk gates active, you usually see only a few LLM calls per day. Exact cost depends on your selected `JUDGE_MODEL`.

Pinecone note: `weekend-optimize` mines generic `strategy=MINED` vectors for judge context. With `PINECONE_GATE_REQUIRE_SAME_STRATEGY=true`, those generic vectors do not auto-approve trades by themselves.

**Judge prompt structure:** The judge receives a structured multi-section prompt:
- `[SIGNAL]` — strategy, ticker, side, setup description
- `[PRICE ACTION]` — last 5 candles (O/H/L/C/Vol tabular)
- `[INDICATORS]` — RSI(14), ATR(14), VWAP distance, Volume Z-score
- `[PATTERN MEMORY]` — Pinecone similar patterns win rate and count
- `[STRATEGY TRACK RECORD]` — rolling WR/PF from last N executed trades
- `[MARKET CONTEXT]` — NIFTY50 trend + up to 5 news headlines
- `[YESTERDAY'S LESSONS]` — analyst post-mortem summary from prior session (if available)

If no API key: judge always returns `approve=false` (no trades fire).

### Shadow eval workflow (recommended)

1. Set:
   - `SHADOW_EVAL_ENABLED=true`
   - `SHADOW_EVAL_ENFORCE_LAYER1=false`
2. Let paper daemon run for a few sessions.
3. Analyze disagreements:
   - `bun run shadow-eval-report -- --days 5 --env PAPER`
4. Enforce only after review:
   - `SHADOW_EVAL_ENFORCE_LAYER1=true`

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
| `ANGEL_HTTP_MIN_GAP_MS` | `0` | Shared in-process minimum gap between any SmartAPI calls (set this first before increasing fixed sleeps) |
| `ANGEL_HTTP_MAX_CONCURRENCY` | `1` | Shared in-process SmartAPI concurrency cap |
| `ANGEL_HTTP_403_RETRIES` | `2` | Retries for HTTP 403 responses |
| `ANGEL_HTTP_429_RETRIES` | `2` | Retries for HTTP 429 responses |
| `ANGEL_HTTP_403_RETRY_BASE_MS` | `1500` | Exponential retry base delay for 403/429 |
| `ANGEL_HTTP_RATE_LIMIT_COOLDOWN_MS` | `1500` | Limiter cooldown after rate-limit responses |
| `ANGEL_HTTP_MAX_BACKOFF_MS` | `30000` | Max cooldown cap for repeated 403/429 |
| `ANGEL_HTTP_RETRY_JITTER_MS` | `200` | Random jitter added to retry delay |
| `ANGEL_HTTP_LOG_LIMITER` | `false` | Logs SmartAPI limiter queue/cooldown diagnostics |

**TOTP_SEED:** Go to Angel SmartAPI dashboard → Enable TOTP → you'll see a QR code and a Base32 secret below it. Use the Base32 secret here (looks like `4OCBO5ENLFSES4EXHCAXEPJBYU`), NOT the 6-digit rotating code.

If credentials incomplete: falls back to `AngelOneStubBroker` — all broker calls return empty data or no-ops. Data fill commands won't work.

---

## Risk / Execution

| Variable | Default | Notes |
|----------|---------|-------|
| `EXECUTION_ENV` | `PAPER` | `PAPER` = log only, `LIVE` = real Angel orders |
| `DAILY_STOP_LOSS` | `15000` | Kill switch: stop all trading if daily PnL ≤ -₹15,000 |
| `MAX_CONCURRENT_TRADES` | `5` | Max open positions at once |
| `WATCHED_TICKERS` | `RELIANCE,TCS,INFY` | Fallback tickers when active_watchlist is empty |
| `TRADING_TICKER_SOURCE` | `active_watchlist` | `env` = use WATCHED_TICKERS, `active_watchlist` = use Mongo discovery list |
| `MAX_SECTOR_POSITIONS` | `2` | Hard cap for open positions in one sector |
| `MAX_SAME_SIDE_POSITIONS` | `3` | Hard cap for simultaneous BUY or SELL positions |
| `MAX_CORRELATION_WITH_OPEN` | `0.7` | Blocks a new ticker if rolling return correlation with any open ticker exceeds this |
| `CORRELATION_LOOKBACK_DAYS` | `20` | Daily-return lookback used for correlation checks |
| `MAX_GROSS_EXPOSURE_PCT` | `1.5` | Gross notional exposure cap vs `ACCOUNT_EQUITY` |
| `MAX_BETA_EXPOSURE_PCT` | `2.0` | Beta-weighted notional exposure cap vs `ACCOUNT_EQUITY` |
| `EXPOSURE_FIT_SIZING_ENABLED` | `true` | If true, engine shrinks qty to fit gross/beta headroom before hard-blocking |
| `ROLLING_3D_DRAWDOWN_LIMIT` | `40000` | Hard stop if last 3 sessions' realized PnL ≤ -₹40,000 |
| `WEEKLY_DRAWDOWN_LIMIT` | `50000` | Hard stop if last 7 calendar days' realized PnL ≤ -₹50,000 |
| `CONSECUTIVE_LOSS_THROTTLE` | `3` | After this many realized losses, size is throttled |
| `LOSS_THROTTLE_SIZE_MULTIPLIER` | `0.5` | Qty multiplier while consecutive-loss throttle is active |
| `RISK_SOFT_THROTTLES_ENABLED` | `true` | Convert non-catastrophic portfolio crowding into size penalties instead of hard veto |
| `SOFT_SECTOR_OVERFLOW_SIZE_MULTIPLIER` | `0.75` | Size multiplier when sector cap is exceeded (soft mode) |
| `SOFT_SAME_SIDE_OVERFLOW_SIZE_MULTIPLIER` | `0.65` | Size multiplier when same-side cap is exceeded (soft mode) |
| `SOFT_CORRELATION_HARD_BLOCK` | `0.9` | Correlation above this remains hard-blocked |
| `SOFT_CORRELATION_MIN_SIZE_MULTIPLIER` | `0.5` | Minimum size multiplier as correlation nears hard block |
| `MARKET_GATE_ENABLED` | `true` | Enable NIFTY/breadth hard gate |
| `MARKET_BLOCK_LONG_BREAKOUTS_NIFTY_PCT` | `-1.0` | Blocks long breakout strategies when NIFTY change is below/equal this |
| `MARKET_BLOCK_LONG_BREAKOUTS_BREADTH` | `0.3` | Blocks long breakout strategies when watchlist green ratio is below this |
| `MARKET_WEAK_NIFTY_PCT` | `-0.5` | Weak-market threshold for size reduction |
| `MARKET_WEAK_BREADTH` | `0.4` | Weak-breadth threshold for size reduction |
| `MARKET_WEAK_SIZE_MULTIPLIER` | `0.5` | Qty multiplier in weak market conditions |
| `MARKET_WEAK_CONFIDENCE_FLOOR` | `0.62` | Minimum calibrated confidence required in weak market/soft-breakout conditions |
| `TIME_WINDOWS_ENABLED` | `true` | Enable strategy-specific fresh-entry windows |
| `NO_FRESH_ENTRIES_AFTER` | `14:30` | Blocks new entries after this IST time |
| `ORB_ENTRY_START` / `ORB_ENTRY_END` | `09:30` / `11:30` | ORB and fakeout windows |
| `VWAP_ENTRY_START` / `VWAP_ENTRY_END` | `10:00` / `14:00` | VWAP and EMA windows |
| `MEAN_REV_ENTRY_START` / `MEAN_REV_ENTRY_END` | `10:00` / `14:30` | Mean-reversion window |
| `SESSION_POLICY_ENABLED` | `true` | Applies time-block policy multipliers and confidence floors |
| `SESSION_OPEN_STRICT_START` / `SESSION_OPEN_STRICT_END` | `09:30` / `10:30` | Stricter open block |
| `SESSION_OPEN_SIZE_MULTIPLIER` / `SESSION_OPEN_CONFIDENCE_FLOOR` | `0.8` / `0.62` | Open block position-size and confidence requirements |
| `SESSION_MID_START` / `SESSION_MID_END` | `10:30` / `13:30` | Normal block |
| `SESSION_MID_SIZE_MULTIPLIER` / `SESSION_MID_CONFIDENCE_FLOOR` | `1.0` / `0.5` | Midday policy defaults |
| `SESSION_LATE_START` / `SESSION_LATE_END` | `13:30` / `15:00` | Late block |
| `SESSION_LATE_SIZE_MULTIPLIER` / `SESSION_LATE_CONFIDENCE_FLOOR` | `0.75` / `0.67` | Late-session caution defaults |
| `SESSION_LOW_CONVICTION_BLOCK_AFTER` | `15:00` | After this, only high-confidence entries pass |
| `SESSION_LOW_CONVICTION_MIN_CONFIDENCE` | `0.72` | Confidence floor used after low-conviction cutoff |
| `EMA20_RETEST_MIN_VOLUME_Z` | `0` | EMA20 break/retest minimum volume z-score |
| `VWAP_CONTINUATION_MIN_VOLUME_Z` | `0.5` | VWAP continuation minimum volume z-score |
| `RETEST_MAX_BARS_AFTER_BREAK` | `20` | Break/retest must happen within this many bars |
| `ORB_FAKEOUT_CONFIRMATION_BARS` | `2` | ORB fakeout reversal requires this many inside-range confirmation closes |

Execution note: with `LIVE_EXEC_SYNC_ENABLED=true`, the daemon no longer depends on post-market `SYNC` alone for intraday bars; it performs periodic top-up sync during EXECUTION and on-demand ticker rescue sync when bar count is insufficient.

Ticker metadata note: sector caps use `data/ind_nifty100list.csv`; beta exposure uses `data/ticker_metadata.json` overrides and defaults unknown beta to `1.0`.

Policy note:
- Hard blocks remain for catastrophic risk (`daily/rolling/weekly drawdown`, gross/beta exhaustion, very high correlation).
- Mild crowding now flows through size penalties (`risk_eval.soft_penalties`, `risk_eval.size_multiplier`) so throughput improves without opening risk floodgates.

---

## ATR-Based Position Sizing

Position size is computed dynamically from ATR to risk a fixed fraction of account equity per trade.

```
riskPerTrade = ACCOUNT_EQUITY × RISK_PER_TRADE_PCT
baseQty      = floor(riskPerTrade / (ATR × ATR_STOP_MULTIPLE))
confMult     = CONFIDENCE_SIZING_ENABLED ? clamp(0.5 + calibratedConfidence × factor, 0.5, CONFIDENCE_MULTIPLIER_MAX) : 1
qtyRaw       = floor(baseQty × confMult × riskMult × marketMult)
qtyCap       = min(MAX_QTY_PER_TRADE, floor((ACCOUNT_EQUITY × MAX_NOTIONAL_PER_TRADE_PCT) / entryPrice))
qty          = clamp(qtyRaw, MIN_QTY_PER_TRADE, qtyCap)
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
| `MAX_NOTIONAL_PER_TRADE_PCT` | `0.25` | Hard notional cap per trade as fraction of equity |
| `MIN_QTY_PER_TRADE` | `1` | Floor for shares per trade |
| `ATR_EXITS_ENABLED` | `true` | Use ATR-based stop/target/trail (false = fixed %) |
| `ATR_SIZING_ENABLED` | `true` | Use ATR-based qty calc (false = fixed `BACKTEST_POSITION_QTY`) |
| `CONFIDENCE_SCALE_FACTOR` | `1.5` | Scales judge confidence into position size multiplier |
| `CONFIDENCE_SIZING_ENABLED` | `false` | If false, confidence approves/denies but does not boost size |
| `CONFIDENCE_MULTIPLIER_MAX` | `1.3` | Max confidence multiplier when confidence sizing is enabled |
| `CONFIDENCE_CALIBRATION_ENABLED` | `true` | If true, blends raw judge confidence with empirical win/breakeven/loss outcomes |
| `CONFIDENCE_CALIBRATION_LOOKBACK_DAYS` | `45` | Lookback window used to build live confidence buckets |
| `CONFIDENCE_CALIBRATION_MIN_SAMPLES` | `80` | Minimum executed-trade samples before calibration is applied |
| `CONFIDENCE_CALIBRATION_WEIGHT` | `0.5` | Blend weight toward empirical score (0 raw only, 1 empirical only) |

**Example with confidence sizing explicitly enabled:** RELIANCE at ₹2500 with ATR(14) = ₹15.
- `stopDistance = 15 × 1.5 = ₹22.50`
- `baseQty = 5000 / 22.50 = 222 shares`
- Judge confidence = 0.8: `confMult = clamp(0.5 + 0.8×1.5, 0.5, 1.3) = 1.30`
- `qty = floor(222 × 1.30) = 288 shares` → capped at `MAX_QTY_PER_TRADE`

Calibration note:
- `ai_confidence_raw` stores the model's original confidence from the judge.
- `ai_confidence` stores the calibrated value used by sizing/replacement when calibration is enabled.
- Use `bun run confidence-calibration-report -- --field raw` and `--field final` to compare both views.

---

## Exit / Risk Parameters

| Variable | Default | Notes |
|----------|---------|-------|
| `EXIT_STOP_PCT` | `0.012` | Fallback stop loss at 1.2% below entry (when ATR unavailable) |
| `EXIT_TARGET_PCT` | `0.020` | Fallback profit target at 2.0% above entry |
| `EXIT_TRAIL_TRIGGER_PCT` | `0.008` | Fallback trailing stop activates when 0.8% in profit |
| `EXIT_TRAIL_DIST_PCT` | `0.005` | Fallback trailing stop distance: 0.5% below peak |
| `BACKTEST_POSITION_QTY` | `25` | Fallback position size when `ATR_SIZING_ENABLED=false` |
| `PARTIAL_EXITS_ENABLED` | `true` | Scale out before final trailing runner when ATR is available |
| `PARTIAL_EXIT_1_ATR_MULTIPLE` | `1.0` | First scale-out target |
| `PARTIAL_EXIT_1_QTY_PCT` | `0.33` | First scale-out size |
| `PARTIAL_EXIT_2_ATR_MULTIPLE` | `2.0` | Second scale-out target |
| `PARTIAL_EXIT_2_QTY_PCT` | `0.33` | Second scale-out size |

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

## Strategy Auto-Gate (Decay-Weighted + Re-Enable)

Automatically disables strategies whose recent performance falls below thresholds, with optional decay weighting (recent trades matter more) and automatic re-enable after cooldown plus improvement trigger.

| Variable | Default | Notes |
|----------|---------|-------|
| `STRATEGY_AUTO_GATE_ENABLED` | `true` | Enable automatic strategy disabling |
| `STRATEGY_GATE_WINDOW` | `20` | Rolling trade window for evaluation |
| `STRATEGY_GATE_MIN_TRADES` | `40` | Minimum closed trades before strategy can be disabled |
| `STRATEGY_GATE_MIN_PF` | `0.8` | Disable strategy if profit factor < 0.8 |
| `STRATEGY_GATE_MIN_WIN_RATE` | `0.3` | Disable strategy if win rate < 30% |
| `STRATEGY_GATE_DECAY_ENABLED` | `true` | Use decay-weighted PF/WR for disable decision |
| `STRATEGY_GATE_DECAY_HALFLIFE_TRADES` | `10` | Half-life in trades for decay weighting |
| `STRATEGY_REENABLE_ENABLED` | `true` | Allow disabled strategies to auto-reenable |
| `STRATEGY_REENABLE_COOLDOWN_DAYS` | `2` | Minimum disabled days before re-enable checks |
| `STRATEGY_REENABLE_RECENT_TRADES` | `8` | Recent trades used for improvement trigger |
| `STRATEGY_REENABLE_MIN_PF` | `1.05` | Re-enable trigger minimum PF on recent trades |
| `STRATEGY_REENABLE_MIN_WIN_RATE` | `0.45` | Re-enable trigger minimum WR on recent trades |

**Log examples:**
- Disable: `[Strategy Gate] ORB_15M DISABLED: PF=0.62<0.8, WR=28%<30%`
- Re-enable: `[Strategy Gate] ORB_15M REENABLED: reenabled after cooldown 2d + recent PF=1.20 WR=55%`

**Tuning:**
- Too twitchy: increase `STRATEGY_GATE_DECAY_HALFLIFE_TRADES` and/or `STRATEGY_GATE_WINDOW`.
- Re-enabling too slowly: reduce `STRATEGY_REENABLE_COOLDOWN_DAYS` or lower re-enable PF/WR thresholds slightly.
- Re-enabling too early: raise `STRATEGY_REENABLE_MIN_PF/WR` or increase cooldown days.

---

## Lessons Feedback Loop

The analyst post-mortem (run by the daemon around 15:45 IST by default) writes a `lessons_learned` document into Mongo. At the start of each trading session's EXECUTION phase, the orchestrator loads yesterday's lessons and injects them into every judge call that day.

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
| `DAEMON_EVENING_JOBS_ENABLED` | `true` | Run live-analyze + analyst from the daemon loop |
| `DAEMON_EVENING_LIVE_ANALYZE_AT` | `15:35` | IST trigger time for live-analyze report |
| `DAEMON_EVENING_ANALYST_AT` | `15:45` | IST trigger time for analyst post-mortem |

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
| `BACKTEST_NEWS_AUTO_BACKFILL` | `true` | Replay prep auto-fetches ET archive headlines for weekdays in replay range (judge-enabled runs) |
| `BACKTEST_NEWS_MIN_HEADLINES_PER_DAY` | `8` | Coverage threshold per weekday in `news_archive`; lower counts are flagged weak |
| `BACKTEST_NEWS_AUTO_BACKFILL_NO_FILTER` | `false` | If `true`, replay auto-backfill keeps raw ET archive titles (no keyword filter) |

ET archive backfill uses the site's `starttime-*` day URLs (not legacy `day-*`, which 404). Scrapers detect soft 404 HTML shells when present.

**Collections:** `news_context` = daily rows for **live** `fetchTodayNewsContext`; filled by `backfill-news-scraper`. **`news_archive`** = `ts` + headlines for **backtest** replay (`getHeadlinesForBacktest`); fill with `backfill-news-scraper --output-archive`, or `backtest --import-news`, or via `HISTORICAL_NEWS_PATH`. Replay auto-backfill upserts with per-day headline dedup, so repeated runs fetch again but won't duplicate existing headlines for that day/source. See `docs/architecture.md`.

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
