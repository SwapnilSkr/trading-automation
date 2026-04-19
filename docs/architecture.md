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
│  backfill-news-scraper ──► MongoDB news_context                     │
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
│    ├─ fetchNiftyTrendContext() → EMA + VWAP from Mongo NIFTY50     │
│    ├─ fetchTodayNewsContext() → live headlines                      │
│    └─ for each ticker in active_watchlist:                          │
│         ├─ checkLiveExits() → stop/target/trailing stop             │
│         ├─ fetchOhlcRange() → Mongo 1m candles (no broker call!)   │
│         └─ runScanningPass():                                       │
│               ├─ evaluateOrb() ─┐                                   │
│               ├─ evaluateMeanReversion() ─┤ → TriggerHit[]          │
│               └─ evaluateBigBoy() ─┘                               │
│                    │                                                │
│                    ▼                                                │
│               embedCandlePattern() → 1536-dim vector               │
│                    │                                                │
│                    ▼                                                │
│               querySimilarPatterns() → Pinecone top-8 neighbors    │
│                    │                                                │
│               score ≥ 0.98 + WIN? ──YES──► auto-approve (no LLM)  │
│                    │ NO                                             │
│                    ▼                                                │
│               callJudgeModel() → OpenRouter (Deepseek)             │
│                    │                                                │
│               approve? ──YES──► placePaperOrder() → MongoDB trades │
│                                                                     │
│  IST 15:15  SQUARE_OFF → closeIntraday() for all tickers           │
│                                                                     │
│  IST 15:30  SYNC                                                    │
│    └─ syncIntradayHistory() → Angel API → MongoDB ohlc_1m          │
│                                                                     │
│  IST 18:00  POST_MORTEM                                             │
│    └─ runDiscoverySync() → Nifty 100 rescore → active_watchlist    │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                         BACKTEST REPLAY                             │
│                                                                     │
│  runBacktestReplay()                                                │
│    └─ for each IST weekday in [from, to]:                           │
│         └─ load dayBars from MongoDB ohlc_1m                        │
│              └─ for each 1m bar (chronological):                    │
│                   ├─ checkExitOnBar() → stop/target/trailing        │
│                   │   → insertBacktestTrade() with full PnL         │
│                   │                                                 │
│                   └─ (every stepMinutes) runScanningPass()          │
│                        └─ same engine as live                        │
│                             (but Pinecone neighbors are filtered     │
│                              to dates before simulated day)          │
│                             → onTradeEntry() → SimPosition          │
│                                                                     │
│  backtest-analyze → win rate, profit factor, Sharpe, max DD        │
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
│   ├── orchestrator.ts          # 60s tick loop, phase switching
│   └── mode.ts                  # IST phase calculator (INIT/OBSERVE/EXECUTE/...)
│
├── execution/
│   ├── ExecutionEngine.ts       # Signal → Pinecone gate → judge → order
│   ├── exitSimulator.ts         # Bar-by-bar stop/target/trailing simulation
│   └── safety.ts                # Daily stop-loss, kill switch
│
├── strategies/
│   └── triggers.ts              # evaluateOrb, evaluateMeanReversion, evaluateBigBoy
│
├── indicators/
│   ├── core.ts                  # VWAP, RSI(14), Z-score, volume Z-score, divergence
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
│   └── repositories.ts          # All CRUD operations
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
```

---

## Strategies

### ORB_15M — Opening Range Breakout
- Computes the high/low of the first 15 minutes of session (09:15–09:30)
- Triggers when price breaks above the opening range high
- Requires volume spike ≥ 1.5× the 20-bar average (to confirm real buying)
- Direction: always BUY (breakout long)
- Typical setup: strong gap-up + continued momentum

### MEAN_REV_Z — Z-Score Mean Reversion
- Computes Z-score of current close vs VWAP: `(close - VWAP) / stdev(20 closes)`
- Triggers when |Z| > 2.5 (overextended from VWAP)
- Requires RSI divergence (price making new extreme but RSI not confirming) OR RSI at extreme (>70 or <30)
- Direction: BUY when Z < -2.5 (oversold), SELL when Z > 2.5 (overbought)
- Typical setup: intraday overreaction, fade the move back to VWAP

### BIG_BOY_SWEEP — Liquidity Sweep
- Finds prior day's high and low (the "liquidity pools" where stops cluster)
- Monitors last 5-minute aggregated bar
- Triggers when price pierces PDH or PDL but closes back inside (fake-out sweep)
- Direction: always BUY (assumes sweep was a fakeout, real move will be upward)
- Typical setup: institutional "stop hunt" — big players push price past obvious levels, fill their orders, then reverse

---

## AI Judge

The judge is a small LLM call (Deepseek ~$0.001/call) that acts as a final filter before placing an order. It receives:
- Strategy name + trigger description
- Technical snapshot (RSI, Z-score, VWAP, volume Z)
- NIFTY50 trend context (real EMA/VWAP from Mongo)
- Up to 5 news headlines
- Pinecone pattern summary (win rate in similar historical setups)

It returns: `{approve: bool, confidence: 0–1, reasoning: string}`

**Cost optimization — the Pinecone gate:**
If the top Pinecone neighbor has cosine similarity ≥ 0.98 AND outcome = WIN, the trade is auto-approved without calling the LLM. After `weekend-optimize` fills Pinecone with thousands of patterns, most trades in familiar regimes skip the judge entirely.

Backtest note: replay does not use live auto-gate approvals; it still queries Pinecone for context but only from dates strictly before the simulated session day (causal filter).

Judge cooldown: 15 minutes per ticker in live mode (avoids LLM spam on choppy price action).

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
  "exit_time": ISODate,          // populated after exit
  "strategy": "ORB_15M",
  "env": "PAPER",
  "technical_snapshot": { "rsi": 58, "z_score_vwap": 1.2, ... },
  "ai_confidence": 0.87,
  "ai_reasoning": "Strong ORB with volume confirmation...",
  "backtest_run_id": "bt-1745123456789",  // backtest only
  "result": {                             // populated after exit
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
**Use:** **Live** pipeline — `fetchTodayNewsContext`, `backfill-news-scraper`, RSS ingestion. Keyed by **calendar `date`** (YYYY-MM-DD).

### news_archive
```json
{ "ts": ISODate, "headlines": ["..."], "source": "import-json" }
```
**Use:** **Backtest** replay only — `getHeadlinesForBacktest(sim)` loads rows with `ts ≤` the simulated bar time (causal headlines). Populate via `bun run backtest -- --import-news <file.json>` or direct Mongo writes. Optional merge with `HISTORICAL_NEWS_PATH` JSON.

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

**Query logic:** embed current candle pattern → query top-8 → filter similarity ≥ 0.72 → compute pWin = wins/total → pass to judge as context. If top score ≥ 0.98 + WIN → auto-approve.

---

## Known Limitations

1. **No real-time tick data** — 60s REST polling only. Angel SmartAPI WebSocket is possible but not implemented.
2. **No ATR-based position sizing** — flat `qty=1` regardless of stock price or volatility. (Next improvement)
3. **News is market-wide** — same headlines for all tickers; no per-ticker relevance filtering. (Next improvement)
4. **Backtest slippage** — enters/exits at stop/target price exactly; real fills may be worse.
5. **Nifty 100 universe only** — discovery won't find small/mid-cap breakouts outside this list.
6. **Scraping fragility** — Moneycontrol/ET HTML can change, breaking the scrapers.
