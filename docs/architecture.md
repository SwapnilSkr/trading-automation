# System Architecture

## Data Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                         WEEKEND PREP                                │
│                                                                     │
│  NSE / Angel API                                                    │
│       │                                                             │
│       ▼                                                             │
│  discovery-sync ──► MongoDB ohlc_1m ◄── sync-history               │
│       │                                                             │
│       ▼                                                             │
│  active_watchlist  watchlist_snapshots                              │
│  (current_session) (dated, no-lookahead)                            │
│                                                                     │
│  weekend-optimize ──► Pinecone (pattern vectors, WIN/LOSS)          │
│                                                                     │
│  backfill-news-scraper ──► MongoDB news_context + news_archive      │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                         LIVE DAEMON (60s tick)                      │
│                                                                     │
│  IST 09:00  INIT                                                    │
│    ├─ broker.authenticate()                                         │
│    ├─ fetchTodayNewsContext() → ET RSS + Moneycontrol scrape        │
│    └─ runPreopenPivot() → quote API + gap/vol filter → watchlist    │
│                                                                     │
│  IST 09:15  OBSERVATION                                             │
│    └─ (idle, VWAP calibration window)                               │
│                                                                     │
│  IST 09:30  EXECUTION (every 60s)                                   │
│    ├─ [FIRST TICK] loadStrategyHealth() → rolling PF/WR per strat  │
│    ├─ [FIRST TICK] fetchLessonForDate(yesterday) → lessons_learned  │
│    ├─ fetchNiftyTrendContext() → EMA + VWAP from Mongo NIFTY50     │
│    ├─ fetchTodayNewsContext() → live headlines                      │
│    └─ for each ticker in active_watchlist:                          │
│         ├─ checkLiveExits() → ATR-based stop/target/trail          │
│         ├─ fetchOhlcRange() → Mongo 1m candles (no broker call!)   │
│         └─ runScanningPass():                                       │
│               ├─ evaluate 14 strategies → TriggerHit[]             │
│               │                                                     │
│               ├─ [GATE 1] Vol-regime filter                         │
│               │   classifyVolRegime() → LOW/MID/HIGH               │
│               │   suppress strategies inactive in current regime    │
│               │                                                     │
│               ├─ [GATE 2] Strategy auto-gate (rolling PF/WR)        │
│               │   isStrategyAllowed() → skip if PF<0.8 or WR<30%  │
│               │                                                     │
│               └─ maybeExecute() per surviving trigger:              │
│                    ├─ embedCandlePattern() → 1536-dim vector        │
│                    ├─ querySimilarPatterns() → Pinecone top-8       │
│                    │                                                │
│                    ├─ [GATE 3] Pinecone auto-approve                │
│                    │   score ≥ 0.92 + WIN? → auto-approve (no LLM) │
│                    │                                                │
│                    ├─ computeQty(atr, confidence) → position size   │
│                    │   riskPerTrade = equity × 0.01                 │
│                    │   qty = riskPerTrade / (ATR × 1.5) × confMult │
│                    │                                                │
│                    ├─ buildPriceContext() → last 5 candles table    │
│                    ├─ buildIndicators() → RSI, ATR, VWAP dist, VZ  │
│                    ├─ getStrategyTrackRecord() → WR/PF string       │
│                    │                                                │
│                    ├─ [GATE 4] callJudgeModel() → Claude Sonnet 4  │
│                    │   [SIGNAL] strategy | ticker | setup           │
│                    │   [PRICE ACTION] last 5 candles O/H/L/C/V     │
│                    │   [INDICATORS] RSI, ATR, VWAP dist, Vol Z     │
│                    │   [PATTERN MEMORY] Pinecone win rate           │
│                    │   [STRATEGY TRACK RECORD] rolling WR/PF        │
│                    │   [MARKET CONTEXT] Nifty + news               │
│                    │   [YESTERDAY'S LESSONS] analyst summary        │
│                    │                                                │
│                    └─ approve? → placePaperOrder() → MongoDB trades │
│                                 stores: qty, atr_at_entry, ai_conf  │
│                                                                     │
│  IST 15:15  SQUARE_OFF → closeIntraday() for all tickers           │
│                                                                     │
│  IST 15:30  SYNC                                                    │
│    └─ syncIntradayHistory() → Angel API → MongoDB ohlc_1m          │
│                                                                     │
│  IST 15:45  PM2: evening-analyst                                    │
│    └─ analyst post-mortem → lessons_learned upsert                  │
│                                                                     │
│  IST 18:00  POST_MORTEM                                             │
│    └─ runDiscoverySync() → Nifty 100 rescore → active_watchlist    │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                  LESSONS FEEDBACK LOOP                               │
│                                                                     │
│  Day N:  trading session executes, trades logged to MongoDB         │
│  15:45:  analyst post-mortem                                        │
│          → compares winners vs losers                               │
│          → LLM generates [ACTIONS_KEEP] / [ACTIONS_FIX]            │
│          → upserts lessons_learned{date: N, summary: ...}           │
│                                                                     │
│  Day N+1: EXECUTION phase first tick                                │
│          → fetchLessonForDate(N) → loads yesterday's lessons        │
│          → injected into every judge call as [YESTERDAY'S LESSONS]  │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                         BACKTEST REPLAY                             │
│                                                                     │
│  runBacktestReplay()                                                │
│    └─ for each IST weekday in [from, to]:                           │
│         └─ load dayBars from MongoDB ohlc_1m                        │
│              └─ for each 1m bar (chronological):                    │
│                   ├─ checkExitOnBar() → ATR-based stop/target/trail │
│                   │   → insertBacktestTrade() with full PnL         │
│                   │                                                 │
│                   └─ (every stepMinutes) runScanningPass()          │
│                        └─ same engine as live                        │
│                             (but Pinecone neighbors filtered        │
│                              to dates before simulated day)         │
│                             → onTradeEntry() → SimPosition          │
│                               (stores atrAtEntry for exit sim)      │
│                                                                     │
│  backtest-analyze → win rate, profit factor, Sharpe, max DD        │
│                     per-strategy and per-ticker breakdowns          │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Key Files

```
src/
├── index.ts                     # Main daemon entry point
├── analyst.ts                   # Evening post-mortem (LLM winners vs losers)
│
├── config/
│   └── env.ts                   # All env vars + defaults
│
├── scheduler/
│   ├── orchestrator.ts          # 60s tick loop, phase switching, session init
│   └── mode.ts                  # IST phase calculator (INIT/OBSERVE/EXECUTE/...)
│
├── execution/
│   ├── ExecutionEngine.ts       # Signal → gates → ATR sizing → judge → order
│   ├── exitSimulator.ts         # Bar-by-bar ATR-based stop/target/trailing
│   ├── strategyTracker.ts       # Rolling PF/WR per strategy → auto-gate
│   └── safety.ts                # Daily stop-loss, kill switch
│
├── strategies/
│   └── triggers.ts              # 14 strategies: ORB_15M, MEAN_REV_Z, BIG_BOY_SWEEP,
│                                #   VWAP_RECLAIM_REJECT, VWAP_PULLBACK_TREND,
│                                #   ORB_RETEST_15M, PREV_DAY_HIGH_LOW_BREAK_RETEST,
│                                #   EMA20_BREAK_RETEST, VWAP_RECLAIM_CONTINUATION,
│                                #   INITIAL_BALANCE_BREAK_RETEST,
│                                #   VOLATILITY_CONTRACTION_BREAKOUT,
│                                #   INSIDE_BAR_BREAKOUT_WITH_RETEST,
│                                #   OPEN_DRIVE_PULLBACK, ORB_FAKEOUT_REVERSAL
│
├── indicators/
│   ├── core.ts                  # VWAP, RSI(14), Z-score, vol Z-score, divergence, ATR(14)
│   ├── orb.ts                   # Opening range high/low + breakout detection
│   └── bigBoy.ts                # Prior-day high/low + liquidity sweep detection
│
├── services/
│   ├── discoveryRun.ts          # Nifty 100 scoring + watchlist management
│   ├── niftyTrend.ts            # Real NIFTY50 trend context from Mongo
│   ├── news.ts                  # ET RSS + Moneycontrol scrape → news_context
│   ├── sentinel-scraper.ts      # Cheerio HTML scraper for Moneycontrol
│   ├── marketSync.ts            # Post-market OHLC backfill from Angel
│   ├── preopenPivot.ts          # ~09:10 gap/volume filter
│   ├── watchlist.ts             # resolveWatchlistTickers (env vs Mongo)
│   └── historicalNewsFeed.ts    # News replay for backtest
│
├── ai/
│   └── judge.ts                 # OpenRouter LLM call → {approve, confidence, reasoning}
│                                # Enriched prompt: price action, indicators, track record,
│                                # pattern memory, market context, yesterday's lessons
│
├── embeddings/
│   └── patternEmbedding.ts      # Log-returns → text → embedding API → 1536-dim vector
│
├── pinecone/
│   └── patternStore.ts          # Upsert patterns, query top-K, scoreFromNeighbors
│
├── backtest/
│   ├── BacktestOrchestrator.ts  # Full replay with exit simulation
│   └── hybridBacktest.ts        # Pattern-based sample backtest (used by weekend-optimize)
│
├── broker/
│   ├── types.ts                 # BrokerClient interface
│   ├── factory.ts               # Real vs stub broker selection
│   ├── angelOneBroker.ts        # Angel SmartAPI: auth, candles, quotes, orders
│   └── angelOneStub.ts          # No-op stub (when credentials missing)
│
├── db/
│   ├── mongo.ts                 # MongoDB connection singleton
│   └── repositories.ts          # All CRUD operations (incl. fetchRecentTradesByStrategy,
│                                #   fetchLessonForDate)
│
├── discovery/
│   ├── performerScore.ts        # metricsFromDailyBars() → score formula
│   └── niftyUniverse.ts         # Load Nifty 100 symbols from CSV / NSE
│
├── cli/
│   ├── sync-history.ts          # CLI entry for OHLC backfill
│   ├── discovery-sync.ts        # CLI entry for discovery
│   ├── backtest.ts              # CLI entry for backtest
│   ├── backtest-analyze.ts      # CLI entry for result analysis
│   ├── weekend-optimize.ts      # Pattern mining + Pinecone upsert
│   ├── analyst.ts               # CLI entry for post-mortem
│   ├── backfill-news.ts         # Manual news seed (edit script)
│   └── backfill-news-scraper.ts # ET archive scrape
│
├── time/
│   └── ist.ts                   # IST utilities (nowIST, isIndianWeekday, etc.)
│
└── types/
    └── domain.ts                # TypeScript interfaces (Ohlc1m, TradeLogDoc, etc.)
                                 # TradeLogDoc includes: qty, atr_at_entry fields
```

---

## Strategies

All 14 strategies are enabled by default. The strategy auto-gate (`strategyTracker.ts`) dynamically disables underperformers based on rolling live performance.

### ORB_15M — Opening Range Breakout
- Computes the high/low of the first 15 minutes of session (09:15–09:30)
- Triggers when price breaks above the opening range high
- Requires volume spike ≥ 1.5× the 20-bar average (to confirm real buying)
- Direction: always BUY (breakout long)
- Typical setup: strong gap-up + continued momentum
- **Optimal regime:** LOW-MID volatility (clean breakouts, not choppy)

### ORB_RETEST_15M — ORB with Retest Confirmation
- Same as ORB_15M but waits for a pullback to the breakout level and a confirming bounce
- Higher win rate, fewer signals than ORB_15M
- Typical setup: breakout, pullback to ORB high, bounce with volume
- **Optimal regime:** LOW-MID volatility

### MEAN_REV_Z — Z-Score Mean Reversion
- Computes Z-score of current close vs VWAP: `(close - VWAP) / stdev(20 closes)`
- Triggers when |Z| > 2.5 (overextended from VWAP)
- Requires RSI divergence OR RSI at extreme (>70 or <30)
- Direction: BUY when Z < -2.5 (oversold), SELL when Z > 2.5 (overbought)
- Typical setup: intraday overreaction, fade the move back to VWAP
- **Optimal regime:** MID-HIGH volatility (overextensions need volatility to form)

### BIG_BOY_SWEEP — Liquidity Sweep
- Finds prior day's high and low (the "liquidity pools" where stops cluster)
- Monitors last 5-minute aggregated bar
- Triggers when price pierces PDH or PDL but closes back inside (fake-out sweep)
- Direction: always BUY (assumes sweep was a fakeout, real move will be upward)
- Typical setup: institutional "stop hunt" — big players push price past obvious levels, fill their orders, then reverse
- **Optimal regime:** MID-HIGH volatility (sweeps need volatility to fake out)

### VWAP_RECLAIM_REJECT — VWAP Reclaim / Rejection
- Fires when price reclaims VWAP from below (bullish) or gets rejected at VWAP from above (bearish)
- **Optimal regime:** LOW-MID volatility (VWAP respected cleanly)

### VWAP_PULLBACK_TREND — VWAP Pullback Continuation
- Identifies established trend direction (above or below VWAP) and enters on a pullback to VWAP
- **Optimal regime:** LOW-MID volatility

### PREV_DAY_HIGH_LOW_BREAK_RETEST — Prior Day Level Break-Retest
- Fires when price breaks above PDH or below PDL and retests that level
- **Optimal regime:** MID volatility

### EMA20_BREAK_RETEST — EMA20 Break-Retest
- Monitors EMA20 as dynamic support/resistance
- Fires on a clean break above EMA20 followed by a retest bounce
- **Optimal regime:** LOW-MID volatility

### VWAP_RECLAIM_CONTINUATION — VWAP Reclaim Continuation
- After VWAP reclaim, waits for momentum continuation confirming the new direction
- **Optimal regime:** LOW-MID volatility

### INITIAL_BALANCE_BREAK_RETEST — Initial Balance Break-Retest
- Defines the first 30 minutes as the initial balance (IB) range
- Fires on a breakout above IB high or below IB low with a retest confirmation
- **Optimal regime:** MID volatility

### VOLATILITY_CONTRACTION_BREAKOUT — Volatility Contraction Breakout
- Detects periods of low intraday volatility (narrow candles, contracting range)
- Fires on the first expansion bar breaking out of the contraction zone
- **Optimal regime:** Transition from LOW to MID (contraction followed by expansion)

### INSIDE_BAR_BREAKOUT_WITH_RETEST — Inside-Bar Breakout with Retest
- Identifies inside bars (candles with range inside the prior bar's range)
- Fires on the breakout from the inside bar with a retest of the breakout level
- **Optimal regime:** LOW-MID volatility

### OPEN_DRIVE_PULLBACK — Open Drive Pullback
- Identifies strong directional move at market open (first 15m)
- Enters on a pullback after the drive with trend resumption signals
- **Optimal regime:** MID volatility

### ORB_FAKEOUT_REVERSAL — ORB Fakeout Reversal
- Monitors for failed ORB breakouts (price spikes above ORB high then reverses)
- Fires when price closes back below ORB high after the false breakout
- **Optimal regime:** MID-HIGH volatility (fakeouts need volatility to produce traps)

---

## Signal Pipeline (4 Gates)

Every trigger must pass through all four gates before an order fires:

```
TriggerHit[]
    │
    ▼ GATE 1: Volatility Regime
    │  classifyVolRegime(last 30 bars) → LOW / MID / HIGH
    │  filter by VOL_REGIME_{STRATEGY}_{REGIME} config
    │
    ▼ GATE 2: Strategy Auto-Gate
    │  loadStrategyHealth() (cached, refreshed each EXECUTION session start)
    │  isStrategyAllowed() → false if PF < 0.8 or WR < 30% over last 20 trades
    │  minimum 10 trades required before gating kicks in
    │
    ▼ GATE 3: Pinecone Pattern Gate
    │  embedCandlePattern(last 30 1m bars) → 1536-dim vector
    │  querySimilarPatterns(top-8, date filter = before today)
    │  if topScore ≥ 0.92 and outcome=WIN → auto-approve (skip LLM)
    │  else → pass to Gate 4 with pattern summary context
    │
    ▼ GATE 4: LLM Judge (Claude Sonnet 4)
       Enriched structured prompt (7 sections)
       → {approve: bool, confidence: 0-1, reasoning: string}
       approve=true + dailyPnL > -DAILY_STOP_LOSS + openCount < MAX_CONCURRENT
       → ATR-based qty calc → placePaperOrder()
```

---

## ATR-Based Position Sizing

Position size adapts to each stock's actual volatility (ATR) and the judge's confidence:

```
riskPerTrade = ACCOUNT_EQUITY × RISK_PER_TRADE_PCT  // e.g., ₹5,000
stopDistance = ATR(14) × ATR_STOP_MULTIPLE          // e.g., ₹15 × 1.5 = ₹22.50
baseQty      = floor(riskPerTrade / stopDistance)   // e.g., floor(5000/22.50) = 222
confMult     = clamp(0.5 + confidence × 1.5, 0.5, 2.0)
qty          = clamp(floor(baseQty × confMult), MIN_QTY, MAX_QTY)
```

Stored in the trade document: `qty`, `atr_at_entry`. Used by exit simulator for accurate PnL: `pnl = (exitPrice - entryPrice) × qty`.

---

## ATR-Based Dynamic Exits

Exits adapt to each stock's volatility rather than using fixed percentages:

```
// Live exits (checkLiveExits in ExecutionEngine)
stopDist    = pos.atrAtEntry × ATR_STOP_MULTIPLE      // 1.5x ATR
targetDist  = pos.atrAtEntry × ATR_TARGET_MULTIPLE    // 2.5x ATR
trailTrigger = pos.atrAtEntry × ATR_TRAIL_TRIGGER_MULTIPLE // 1.0x ATR
trailDist   = pos.atrAtEntry × ATR_TRAIL_DIST_MULTIPLE // 0.75x ATR

// Fallback when ATR unavailable
stopDist    = entryPrice × EXIT_STOP_PCT   // 1.2%
targetDist  = entryPrice × EXIT_TARGET_PCT // 2.0%
```

The `SimPosition` in backtest also carries `atrAtEntry` so exit simulation uses the same ATR-adaptive logic.

---

## AI Judge

The judge (Claude Sonnet 4 via OpenRouter, ~$0.003/call) acts as a final filter with a comprehensive structured prompt:

```
[SIGNAL]
Strategy: ORB_15M | Ticker: RELIANCE | Side: BUY
Setup: ORB breakout above 2501.5 with 2.1x vol spike

[PRICE ACTION]
Time      O       H       L       C       Vol
09:45   2499.2  2508.5  2498.1  2507.3  45200
...

[INDICATORS]
RSI(14): 62.3 | ATR(14): ₹15.2 | VWAP: 2503.1 (price +0.17% above)
EMA20: 2504.8 | Volume Z-Score: +1.8

[PATTERN MEMORY]
Similar patterns: 6 found | Win rate: 72% | Avg PnL: +1.8%
Best match: score=0.94, outcome=WIN

[STRATEGY TRACK RECORD]
Last 18 trades: WR=67%, PF=1.72, PnL=₹24,300

[MARKET CONTEXT]
Nifty: Bullish, +0.8% from open, above VWAP
News: RBI holds rates | FII inflows continue | IT earnings beat

[YESTERDAY'S LESSONS]
[ACTIONS_KEEP] Taking ORB trades on high vol open days worked well.
[ACTIONS_FIX] Avoid MEAN_REV trades in first 30m — getting stopped too often.
```

Returns: `{approve: bool, confidence: 0–1, reasoning: string}`

**Cost optimization — the Pinecone gate:**
If the top Pinecone neighbor has cosine similarity ≥ 0.92 AND outcome = WIN, the trade is auto-approved without calling the LLM. After `weekend-optimize` fills Pinecone, most trades in familiar regimes skip the judge entirely.

**Judge cooldown:** 5 minutes **per strategy per ticker** in live mode (each strategy on each ticker gets its own independent cooldown, so multiple strategies on the same ticker don't block each other).

---

## Strategy Auto-Gate (Rolling Performance Filter)

`src/execution/strategyTracker.ts` maintains rolling performance stats for all 14 strategies:

- Queries last `STRATEGY_GATE_WINDOW` (default 20) executed trades from Mongo per strategy
- Computes: win rate, profit factor, total PnL
- **Gate condition:** disable strategy if `trades >= 10` AND (`PF < STRATEGY_GATE_MIN_PF` OR `WR < STRATEGY_GATE_MIN_WIN_RATE`)
- The 10-trade minimum prevents premature disabling due to small sample variance
- Health map is refreshed once at EXECUTION session start, cached for the session

This creates a "survival of the fittest" mechanism: strategies that consistently lose money get automatically suspended until you reset them or their rolling window improves.

---

## Lessons Feedback Loop

Creates a self-improving cycle from daily experience:

1. **Evening analyst** (PM2, 15:45 IST): calls two LLM prompts — one to analyze winning trades, one to analyze losing trades. Generates `[ACTIONS_KEEP]` and `[ACTIONS_FIX]` sections. Upserts to `lessons_learned` collection (keyed by IST date).

2. **Next-day EXECUTION init**: orchestrator loads yesterday's `lessons_learned` doc, calls `engine.setYesterdaysLessons(summary)`, stored in engine instance.

3. **Every judge call that day**: yesterday's lessons are injected as the final section of the judge prompt, giving the LLM contextual wisdom about what has and hasn't worked recently.

---

## MongoDB Schema

### ohlc_1m
```json
{ "ticker": "RELIANCE", "ts": ISODate, "o": 2940, "h": 2945, "l": 2938, "c": 2942, "v": 15420 }
```
Index: `{ticker, ts}` unique + `{ts: -1}`

### trades / trades_backtest
```json
{
  "ticker": "RELIANCE",
  "entry_time": ISODate,
  "exit_time": ISODate,
  "strategy": "ORB_15M",
  "env": "PAPER",
  "entry_price": 2501.5,
  "qty": 222,
  "atr_at_entry": 15.2,
  "technical_snapshot": { "rsi": 58, "z_score_vwap": 1.2, ... },
  "ai_confidence": 0.87,
  "ai_reasoning": "Strong ORB with volume confirmation...",
  "order_executed": true,
  "backtest_run_id": "bt-1745123456789",
  "result": {
    "pnl": 2840,
    "slippage": 0,
    "outcome": "WIN",
    "pnl_percent": 2.43
  }
}
```

### active_watchlist
```json
{ "_id": "current_session", "tickers": ["RELIANCE","HDFCBANK",...], "updated_at": ISODate }
```

### watchlist_snapshots
```json
{ "effective_date": "2026-04-21", "tickers": [...], "performers": [...], "created_at": ISODate }
```

### news_context
```json
{ "date": "2026-04-18", "headlines": ["Budget 2026...", "RBI holds rates..."], "source": "ET-RSS+Sentinel" }
```
**Use:** **Live** pipeline — `fetchTodayNewsContext`, `backfill-news-scraper`. Keyed by **calendar `date`** (YYYY-MM-DD).

### news_archive
```json
{ "ts": ISODate, "headlines": ["..."], "source": "ET-archive-scraper" }
```
**Use:** **Backtest** replay only — `getHeadlinesForBacktest(sim)` loads rows with `ts ≤` the simulated bar time (causal headlines). Populate via `bun run backfill-news-scraper -- --output-archive` or `bun run backtest -- --import-news <file.json>`.

### lessons_learned
```json
{
  "date": "2026-04-20",
  "summary": "[ACTIONS_KEEP]\n...\n[ACTIONS_FIX]\n...",
  "metrics": { "trades": 8, "wins": 5, "winRate": 0.625, ... },
  "created_at": ISODate
}
```
**Use:** Loaded by orchestrator at EXECUTION session start and injected into every judge call that day.

---

## Pinecone Schema

**Index:** cosine, 1536 dimensions, namespace: `golden-patterns`

**Vector:** 1536-dim embedding of log-return text (last 30 1m candles: `"0.001,0.0023,-0.0012,..."`)

**Metadata per vector:**
```json
{
  "outcome": "WIN",
  "pnl_percent": 2.43,
  "date": "2026-03-15",
  "ticker": "RELIANCE",
  "strategy": "MINED"
}
```

**Query logic:** embed current candle pattern → query top-8 → filter similarity ≥ 0.72 → compute pWin = wins/total → pass to judge as context. If top score ≥ 0.92 + WIN → auto-approve (no LLM call).

---

## Known Limitations

1. **No real-time tick data** — 60s REST polling only. Angel SmartAPI WebSocket is possible but not implemented.
2. **News is market-wide** — same headlines for all tickers; no per-ticker relevance filtering. (Next improvement)
3. **Backtest slippage** — enters/exits at stop/target price exactly; real fills may be worse even with the realism model.
4. **Nifty 100 universe only** — discovery won't find small/mid-cap breakouts outside this list.
5. **Scraping fragility** — Moneycontrol/ET HTML can change, breaking the scrapers.
6. **Strategy auto-gate is session-scoped** — health map is loaded once per EXECUTION session; won't update if a strategy has a sudden bad streak within the same day.
