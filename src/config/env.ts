function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") {
    throw new Error(`Missing required env: ${name}`);
  }
  return v;
}

function num(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function bool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  return v === "true";
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",

  mongoUri: () => req("MONGODB_URI", "mongodb://127.0.0.1:27017/trading-automation"),
  mongoDbName: process.env.MONGODB_DB ?? "trading-automation",

  pineconeApiKey: () => process.env.PINECONE_API_KEY ?? "",
  pineconeIndex: process.env.PINECONE_INDEX ?? "trading-patterns",
  pineconeNamespace: process.env.PINECONE_NAMESPACE ?? "golden-patterns",

  /** OpenAI-compatible embeddings (text-embedding-3-small → 1536 dims) */
  embeddingApiKey: () => process.env.OPENAI_API_KEY ?? process.env.EMBEDDING_API_KEY ?? "",
  embeddingModel: process.env.EMBEDDING_MODEL ?? "text-embedding-3-small",
  embeddingBaseUrl:
    process.env.EMBEDDING_BASE_URL ?? "https://api.openai.com/v1",

  /** Judge / simulation (OpenRouter or OpenAI-compatible) */
  openRouterApiKey: () => process.env.OPENROUTER_API_KEY ?? "",
  openRouterBaseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
  judgeModel: process.env.JUDGE_MODEL ?? "anthropic/claude-sonnet-4",
  /** Cheaper model for `bun run backtest` (OpenRouter slug, e.g. Gemini Flash) */
  judgeModelBacktest:
    process.env.JUDGE_MODEL_BACKTEST ?? "google/gemini-2.0-flash-001",
  /** Optional path to `historical_news.json` for replay */
  historicalNewsPath:
    process.env.HISTORICAL_NEWS_PATH ?? "data/historical_news.json",

  /** Economic Times (or other) RSS for live `news_context` ingestion */
  newsEtRssUrl:
    process.env.NEWS_ET_RSS_URL ??
    "https://economictimes.indiatimes.com/markets/stocks/rssfeeds/2146842.cms",

  /** Merge Moneycontrol (etc.) HTML scrape with RSS in `fetchTodayNewsContext` */
  newsSentinelEnabled: process.env.NEWS_SENTINEL !== "false",
  sentinelMoneycontrolUrl:
    process.env.SENTINEL_MC_URL ??
    "https://www.moneycontrol.com/news/business/markets/",
  sentinelTimeoutMs: num("SENTINEL_TIMEOUT_MS", 15_000),
  /** Retries for RSS / HTML scrape (5xx, 429, transient network) */
  sentinelMaxRetries: num("SENTINEL_MAX_RETRIES", 4),
  sentinelRetryBaseMs: num("SENTINEL_RETRY_BASE_MS", 700),

  /** Delay between ET archive day requests (backfill-news-scraper) */
  archiveScraperDelayMs: num("ARCHIVE_SCRAPER_DELAY_MS", 2500),

  angelApiKey: process.env.ANGEL_API_KEY ?? "",
  /** Dashboard secret (UUID); REST login uses API key + PIN + TOTP per SmartAPI docs */
  angelApiSecret: process.env.ANGEL_API_SECRET ?? "",
  angelClientCode: process.env.ANGEL_CLIENT_CODE ?? "",
  angelPassword: process.env.ANGEL_PASSWORD ?? "",
  /** Base32 TOTP secret from Angel “Enable TOTP” (not the 6-digit code) */
  totpSeed: process.env.TOTP_SEED ?? "",
  /** SmartAPI requires client/public IP + MAC on each request; set to match whitelisted IP */
  angelClientLocalIp: process.env.ANGEL_CLIENT_LOCAL_IP ?? "192.168.1.1",
  angelClientPublicIp: process.env.ANGEL_CLIENT_PUBLIC_IP ?? "127.0.0.1",
  angelMacAddress: process.env.ANGEL_MAC_ADDRESS ?? "00:00:00:00:00:00",
  angelExchange: process.env.ANGEL_EXCHANGE ?? "NSE",

  /**
   * Local symbol resolution from Angel’s OpenAPIScripMaster (avoids per-ticker `searchScrip`).
   * Default is Angel’s public instrument file (~daily updates).
   */
  angelScripMasterUrl:
    process.env.ANGEL_SCRIP_MASTER_URL ??
    "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json",
  /** Optional path to a downloaded OpenAPIScripMaster.json (skips URL fetch when set) */
  angelScripMasterPath: process.env.ANGEL_SCRIP_MASTER_PATH ?? "",
  /** Override cache path for downloaded master JSON (default: OS temp dir, hashed by URL) */
  angelScripMasterCachePath: process.env.ANGEL_SCRIP_MASTER_CACHE_PATH ?? "",
  /** Re-download master when cache file is older than this (hours) */
  angelScripMasterMaxAgeHours: num("ANGEL_SCRIP_MASTER_MAX_AGE_HOURS", 24),
  /** Minimum gap between `searchScrip` calls when local master misses (fallback only) */
  angelSearchScripMinGapMs: num("ANGEL_SEARCH_SCRIP_MIN_GAP_MS", 450),

  /**
   * Global SmartAPI client (`SmartApiHttp`): all `post`/`get` are serialized through one queue
   * so parallel callers cannot burst past Angel limits. Optional minimum idle time after each
   * response before the next request starts (0 = only serialization, no extra delay).
   */
  angelHttpMinGapMs: num("ANGEL_HTTP_MIN_GAP_MS", 0),
  /** Retries when SmartAPI returns HTTP 403 (often rate limit); 0 disables */
  angelHttp403Retries: num("ANGEL_HTTP_403_RETRIES", 2),
  /** Base backoff for 403 retries (ms); multiplied by 2^attempt */
  angelHttp403RetryBaseMs: num("ANGEL_HTTP_403_RETRY_BASE_MS", 1500),

  /** Pause between `getCandleData` chunk requests to avoid Angel rate limits (403) */
  angelApiThrottleMs: num("ANGEL_API_THROTTLE_MS", 450),
  /** Extra pause between tickers during `sync-history` */
  angelSyncTickerGapMs: num("ANGEL_SYNC_TICKER_GAP_MS", 800),

  /** Pause between Angel `/quote` batches (≤50 symbols each, ~1 rps) */
  quoteBatchDelayMs: num("QUOTE_BATCH_DELAY_MS", 1100),

  /** Run discovery-sync once per weekday ~18:00 IST (POST_MORTEM window) */
  nightlyDiscoveryEnabled: process.env.NIGHTLY_DISCOVERY !== "false",

  /** Pre-open pivot during INIT (~9:10 IST): quotes + gap/volume filter */
  preopenPivotEnabled: process.env.PREOPEN_PIVOT !== "false",
  preopenJudgeEnabled: process.env.PREOPEN_JUDGE === "true",
  preopenMinAbsGapPct: num("PREOPEN_MIN_ABS_GAP_PCT", 1.5),
  preopenMinVolVsAvg: num("PREOPEN_MIN_VOL_VS_AVG", 0.2),
  preopenMaxCandidates: num("PREOPEN_MAX_CANDIDATES", 50),
  preopenMaxPicks: num("PREOPEN_MAX_PICKS", 10),

  dailyStopLoss: num("DAILY_STOP_LOSS", 25_000),
  maxConcurrentTrades: num("MAX_CONCURRENT_TRADES", 5),
  executionEnv: (process.env.EXECUTION_ENV ?? "PAPER") as "PAPER" | "LIVE",

  watchedTickers: (process.env.WATCHED_TICKERS ?? "RELIANCE,TCS,INFY").split(",").map((s) => s.trim()),

  /**
   * `env` — use `WATCHED_TICKERS` only.
   * `active_watchlist` — use Mongo `active_watchlist` doc `_id: current_session` (from discovery-sync).
   */
  tradingTickerSource: (process.env.TRADING_TICKER_SOURCE ?? "active_watchlist") as
    | "env"
    | "active_watchlist",

  /** Extra gap between symbols during discovery (daily fetch + scrip resolve); stay ≥1000ms under Angel limits */
  discoverySymbolDelayMs: num("DISCOVERY_SYMBOL_DELAY_MS", 2000),

  healthPort: num("HEALTH_PORT", 3000),

  niftySymbol: process.env.NIFTY_BENCHMARK_TICKER ?? "NIFTY50",

  /** Min ms between judge (or Pinecone-gate) decisions per ticker — live only */
  judgeCooldownMs: num("JUDGE_COOLDOWN_MS", 5 * 60 * 1000),
  /** If true, bypass judge in live daemon and auto-approve technical triggers */
  liveSkipJudge: process.env.LIVE_SKIP_JUDGE === "true",
  /** If true, print per-scan trigger and judge decision logs in live daemon */
  liveDebugScans: process.env.LIVE_DEBUG_SCANS !== "false",
  /** Log layer-1 shadow decisions alongside live decisions (observe-only by default). */
  shadowEvalEnabled: bool("SHADOW_EVAL_ENABLED", false),
  /** If true, enforce layer-1 veto before Pinecone/LLM. Keep false until shadow metrics are validated. */
  shadowEvalEnforceLayer1: bool("SHADOW_EVAL_ENFORCE_LAYER1", false),
  /** Layer-1 veto: block setups if volume z-score is below this threshold. */
  layer1MinVolumeZ: num("LAYER1_MIN_VOLUME_Z", -0.8),
  /** Layer-1 veto: block setups when ATR(14)/price% exceeds this threshold. */
  layer1MaxAtrPct: num("LAYER1_MAX_ATR_PCT", 3.5),
  /**
   * During EXECUTION window, periodically backfill recent 1m bars so scanning
   * does not depend on post-market SYNC only.
   */
  liveExecSyncEnabled: process.env.LIVE_EXEC_SYNC_ENABLED !== "false",
  /** Minutes between execution-time auto-sync passes */
  liveExecSyncIntervalMinutes: num("LIVE_EXEC_SYNC_INTERVAL_MINUTES", 10),
  /** How far back each execution-time auto-sync fetches */
  liveExecSyncLookbackMinutes: num("LIVE_EXEC_SYNC_LOOKBACK_MINUTES", 180),
  /** Cooldown for ticker-specific rescue sync when bars are insufficient */
  liveExecTickerResyncCooldownMinutes: num(
    "LIVE_EXEC_TICKER_RESYNC_COOLDOWN_MINUTES",
    10
  ),

  /** If top Pinecone neighbor is this similar and outcome WIN, skip LLM */
  pineconeGateEnabled: process.env.PINECONE_GATE_ENABLED !== "false",
  pineconeGateMinScore: num("PINECONE_GATE_MIN_SCORE", 0.92),

  /** Skip OpenAI embed + Pinecone upsert when vector id already exists (weekend-optimize) */
  weekendOptimizeSkipExisting:
    process.env.WEEKEND_OPTIMIZE_SKIP_EXISTING !== "false",
  /** Resume weekend-optimize across tickers after interrupt (same IST day + same ticker set) */
  weekendOptimizeResume: process.env.WEEKEND_OPTIMIZE_RESUME !== "false",
  /** Pinecone fetch batch size for existence checks */
  weekendOptimizeFetchBatch: num("WEEKEND_OPTIMIZE_FETCH_BATCH", 100),

  /**
   * If set, `POST /v1/emergency/square-off` requires header `X-Emergency-Key: <value>`.
   * Empty disables the route (returns 404).
   */
  emergencySquareOffSecret: process.env.EMERGENCY_SQUARE_OFF_SECRET ?? "",

  // ── Exit / Risk parameters ─────────────────────────────────────────────────
  /** Stop-loss distance from entry as fraction (fallback when ATR unavailable) */
  exitStopPct: num("EXIT_STOP_PCT", 0.012),
  /** Profit-target distance from entry as fraction (fallback when ATR unavailable) */
  exitTargetPct: num("EXIT_TARGET_PCT", 0.020),
  /** Profit % that activates the trailing stop (fallback when ATR unavailable) */
  exitTrailTriggerPct: num("EXIT_TRAIL_TRIGGER_PCT", 0.008),
  /** Trailing stop distance from peak as fraction (fallback when ATR unavailable) */
  exitTrailDistPct: num("EXIT_TRAIL_DIST_PCT", 0.005),
  /** Position size in shares for backtest PnL calculation */
  backtestPositionQty: num("BACKTEST_POSITION_QTY", 25),
  /** Strategy toggles (used by live + backtest trigger evaluation) */
  backtestEnableOrb15m: process.env.BACKTEST_ENABLE_ORB_15M !== "false",
  backtestEnableOrbRetest15m:
    process.env.BACKTEST_ENABLE_ORB_RETEST_15M !== "false",
  backtestEnableMeanRevZ:
    process.env.BACKTEST_ENABLE_MEAN_REV_Z !== "false",
  backtestEnableBigBoySweep:
    process.env.BACKTEST_ENABLE_BIG_BOY_SWEEP !== "false",
  backtestEnableVwapReclaimReject:
    process.env.BACKTEST_ENABLE_VWAP_RECLAIM_REJECT !== "false",
  backtestEnableVwapPullbackTrend:
    process.env.BACKTEST_ENABLE_VWAP_PULLBACK_TREND !== "false",
  backtestEnablePrevDayBreakRetest:
    process.env.BACKTEST_ENABLE_PREV_DAY_HIGH_LOW_BREAK_RETEST !== "false",
  backtestEnableEma20BreakRetest:
    process.env.BACKTEST_ENABLE_EMA20_BREAK_RETEST !== "false",
  backtestEnableVwapReclaimContinuation:
    process.env.BACKTEST_ENABLE_VWAP_RECLAIM_CONTINUATION !== "false",
  backtestEnableInitialBalanceBreakRetest:
    process.env.BACKTEST_ENABLE_INITIAL_BALANCE_BREAK_RETEST !== "false",
  backtestEnableVolContractionBreakout:
    process.env.BACKTEST_ENABLE_VOLATILITY_CONTRACTION_BREAKOUT !== "false",
  backtestEnableInsideBarBreakoutRetest:
    process.env.BACKTEST_ENABLE_INSIDE_BAR_BREAKOUT_WITH_RETEST !== "false",
  backtestEnableOpenDrivePullback:
    process.env.BACKTEST_ENABLE_OPEN_DRIVE_PULLBACK !== "false",
  backtestEnableOrbFakeoutReversal:
    process.env.BACKTEST_ENABLE_ORB_FAKEOUT_REVERSAL !== "false",

  // ── ATR-based position sizing ────────────────────────────────────────────
  /** Account equity for risk calculation (INR) */
  accountEquity: num("ACCOUNT_EQUITY", 500_000),
  /** Fraction of equity to risk per trade (1% = 0.01) */
  riskPerTradePct: num("RISK_PER_TRADE_PCT", 0.01),
  /** ATR period for position sizing and exits */
  atrPeriod: num("ATR_PERIOD", 14),
  /** ATR multiplier for stop-loss (1.5 = 1.5x ATR from entry) */
  atrStopMultiple: num("ATR_STOP_MULTIPLE", 1.5),
  /** ATR multiplier for profit target */
  atrTargetMultiple: num("ATR_TARGET_MULTIPLE", 2.5),
  /** ATR multiplier for trailing stop trigger */
  atrTrailTriggerMultiple: num("ATR_TRAIL_TRIGGER_MULTIPLE", 1.0),
  /** ATR multiplier for trailing stop distance */
  atrTrailDistMultiple: num("ATR_TRAIL_DIST_MULTIPLE", 0.75),
  /** Max shares per single trade (cap regardless of ATR calc) */
  maxQtyPerTrade: num("MAX_QTY_PER_TRADE", 500),
  /** Min shares per trade (floor) */
  minQtyPerTrade: num("MIN_QTY_PER_TRADE", 1),
  /** Enable ATR-based dynamic exits (false = use fixed % exits) */
  atrExitsEnabled: bool("ATR_EXITS_ENABLED", true),
  /** Enable ATR-based position sizing (false = use fixed qty) */
  atrSizingEnabled: bool("ATR_SIZING_ENABLED", true),
  /** Confidence scaling: multiply qty by (0.5 + confidence * factor), clamped [0.5, 2.0] */
  confidenceScaleFactor: num("CONFIDENCE_SCALE_FACTOR", 1.5),

  // ── Strategy auto-gate (rolling performance filter) ────────────────────
  /** Enable automatic strategy disabling based on rolling performance */
  strategyAutoGateEnabled: bool("STRATEGY_AUTO_GATE_ENABLED", true),
  /** Rolling trade window for strategy performance evaluation */
  strategyGateWindow: num("STRATEGY_GATE_WINDOW", 20),
  /** Minimum profit factor to keep strategy active (below this → disabled) */
  strategyGateMinPf: num("STRATEGY_GATE_MIN_PF", 0.8),
  /** Minimum win rate (0-1) to keep strategy active */
  strategyGateMinWinRate: num("STRATEGY_GATE_MIN_WIN_RATE", 0.3),

  // ── Lessons feedback loop ─────────────────────────────────────────────
  /** Inject yesterday's lessons_learned into judge prompt */
  lessonsFeedbackEnabled: bool("LESSONS_FEEDBACK_ENABLED", true),

  // ── Volatility regime switch (strategy gating) ────────────────────────────
  /** If true, gate strategies by intraday realized-volatility regime (low/mid/high) */
  volRegimeSwitchEnabled: bool("VOL_REGIME_SWITCH_ENABLED", true),
  /** Number of bars used to compute realized-volatility regime */
  volRegimeLookbackBars: num("VOL_REGIME_LOOKBACK_BARS", 30),
  /** Low regime threshold: realized vol % below this is LOW */
  volRegimeLowMaxPct: num("VOL_REGIME_LOW_MAX_PCT", 0.08),
  /** High regime threshold: realized vol % at/above this is HIGH */
  volRegimeHighMinPct: num("VOL_REGIME_HIGH_MIN_PCT", 0.22),
  /** Breakout strategies: clean breakouts in LOW-MID, too choppy in HIGH */
  volRegimeOrbLow: bool("VOL_REGIME_ORB_LOW", true),
  volRegimeOrbMid: bool("VOL_REGIME_ORB_MID", true),
  volRegimeOrbHigh: bool("VOL_REGIME_ORB_HIGH", false),
  /** Mean reversion: needs overextension → MID-HIGH vol */
  volRegimeMeanRevLow: bool("VOL_REGIME_MEANREV_LOW", false),
  volRegimeMeanRevMid: bool("VOL_REGIME_MEANREV_MID", true),
  volRegimeMeanRevHigh: bool("VOL_REGIME_MEANREV_HIGH", true),
  /** Liquidity grabs: need volatility → MID-HIGH */
  volRegimeBigBoyLow: bool("VOL_REGIME_BIGBOY_LOW", false),
  volRegimeBigBoyMid: bool("VOL_REGIME_BIGBOY_MID", true),
  volRegimeBigBoyHigh: bool("VOL_REGIME_BIGBOY_HIGH", true),
  /** VWAP strategies: clean VWAP respect in LOW-MID, chopped in HIGH */
  volRegimeVwapLow: bool("VOL_REGIME_VWAP_LOW", true),
  volRegimeVwapMid: bool("VOL_REGIME_VWAP_MID", true),
  volRegimeVwapHigh: bool("VOL_REGIME_VWAP_HIGH", false),

  // ── Backtest microstructure realism ───────────────────────────────────────
  /** Master toggle for slippage/spread/fees/latency realism model in replay */
  backtestRealismEnabled: process.env.BACKTEST_REALISM_ENABLED !== "false",
  /** Entry fill delay in bars (0 = signal bar, 1 = next bar open) */
  backtestEntryLatencyBars: num("BACKTEST_ENTRY_LATENCY_BARS", 1),
  /** If stop and target are both touched in one candle, assume adverse fill */
  backtestPessimisticIntrabar:
    process.env.BACKTEST_PESSIMISTIC_INTRABAR !== "false",
  /** Assumed bid-ask spread in basis points (round-trip cost split across legs) */
  backtestSpreadBps: num("BACKTEST_SPREAD_BPS", 3.0),
  /** Baseline adverse slippage in basis points per fill */
  backtestBaseSlippageBps: num("BACKTEST_BASE_SLIPPAGE_BPS", 1.5),
  /** Additional slippage bps for each 1% participation of bar volume */
  backtestImpactBpsPer1PctParticipation: num(
    "BACKTEST_IMPACT_BPS_PER_1PCT_PARTICIPATION",
    0.25
  ),
  /** Scales bar-range-derived volatility into slippage bps */
  backtestVolatilitySlippageCoeff: num(
    "BACKTEST_VOLATILITY_SLIPPAGE_COEFF",
    0.1
  ),
  /** Enable fee/tax model in backtest PnL */
  backtestFeesEnabled: process.env.BACKTEST_FEES_ENABLED !== "false",
  /** Brokerage rate as fraction of turnover (0.03% = 0.0003) */
  backtestBrokeragePct: num("BACKTEST_BROKERAGE_PCT", 0.0003),
  /** Max brokerage per order leg (rupees) */
  backtestBrokerageCapPerOrder: num("BACKTEST_BROKERAGE_CAP_PER_ORDER", 20),
  /** STT on sell turnover (intraday equity) */
  backtestSttSellPct: num("BACKTEST_STT_SELL_PCT", 0.00025),
  /** Exchange transaction charge on total turnover */
  backtestExchangeTxnPct: num("BACKTEST_EXCHANGE_TXN_PCT", 0.0000297),
  /** SEBI turnover charge */
  backtestSebiPct: num("BACKTEST_SEBI_PCT", 0.000001),
  /** GST on brokerage + exchange charge */
  backtestGstPct: num("BACKTEST_GST_PCT", 0.18),
  /** Stamp duty on buy turnover */
  backtestStampDutyBuyPct: num("BACKTEST_STAMP_DUTY_BUY_PCT", 0.00003),
};
