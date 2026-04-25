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

/** If `backtestKey` is set, use it; else same boolean resolution as `sharedKey` (for replay-only overrides). */
function boolBacktestOverride(
  backtestKey: string,
  sharedKey: string,
  def: boolean
): boolean {
  const b = process.env[backtestKey];
  if (b !== undefined && b !== "") return b === "true";
  return bool(sharedKey, def);
}

function str(name: string, def: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? def : v;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",

  mongoUri: () =>
    req("MONGODB_URI", "mongodb://127.0.0.1:27017/trading-automation"),
  mongoDbName: process.env.MONGODB_DB ?? "trading-automation",

  pineconeApiKey: () => process.env.PINECONE_API_KEY ?? "",
  pineconeIndex: process.env.PINECONE_INDEX ?? "trading-patterns",
  pineconeNamespace: process.env.PINECONE_NAMESPACE ?? "golden-patterns",

  /** OpenAI-compatible embeddings (text-embedding-3-small → 1536 dims) */
  embeddingApiKey: () =>
    process.env.OPENAI_API_KEY ?? process.env.EMBEDDING_API_KEY ?? "",
  embeddingModel: process.env.EMBEDDING_MODEL ?? "text-embedding-3-small",
  embeddingBaseUrl:
    process.env.EMBEDDING_BASE_URL ?? "https://api.openai.com/v1",

  /** Judge / simulation (OpenRouter or OpenAI-compatible) */
  openRouterApiKey: () => process.env.OPENROUTER_API_KEY ?? "",
  openRouterBaseUrl:
    process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
  judgeModel: process.env.JUDGE_MODEL ?? "deepseek/deepseek-chat",
  /** AI operator CLI planner model */
  opsAiModel: process.env.OPS_AI_MODEL ?? "google/gemma-4-31b-it:free",
  /** Ops CLI: how many recent trading days to audit for missing artifacts */
  opsMissingTradingDaysLookback: num("OPS_MISSING_TRADING_DAYS_LOOKBACK", 10),
  /** Funnel optimizer: lookback days for dominant blocker analysis */
  funnelOptimizerLookbackDays: num("FUNNEL_OPTIMIZER_LOOKBACK_DAYS", 5),
  /** Funnel optimizer: minimum decisions required before tuning */
  funnelOptimizerMinDecisions: num("FUNNEL_OPTIMIZER_MIN_DECISIONS", 120),
  /** Funnel optimizer: dominant blocker share threshold (0-1) */
  funnelOptimizerDominancePct: num("FUNNEL_OPTIMIZER_DOMINANCE_PCT", 0.35),
  /** Funnel optimizer: max env tuning applies allowed per IST week */
  funnelOptimizerMaxChangesPerWeek: num(
    "FUNNEL_OPTIMIZER_MAX_CHANGES_PER_WEEK",
    1,
  ),
  /** Phase 8 validation: lookback days for KPI report */
  phase8ValidationLookbackDays: num("PHASE8_VALIDATION_LOOKBACK_DAYS", 5),
  /** Phase 8 target: execution rate minimum (executed/total decisions) */
  phase8TargetExecRateMin: num("PHASE8_TARGET_EXEC_RATE_MIN", 0.02),
  /** Phase 8 target: execution rate upper guidance */
  phase8TargetExecRateMax: num("PHASE8_TARGET_EXEC_RATE_MAX", 0.05),
  /** Phase 8 target: maximum losing-day ratio */
  phase8TargetLosingDayPctMax: num("PHASE8_TARGET_LOSING_DAY_PCT_MAX", 0.3),
  /** Phase 8 target: replay profit factor floor */
  phase8TargetReplayPfMin: num("PHASE8_TARGET_REPLAY_PF_MIN", 1.2),
  /** Phase 8 guardrail: max allowed worst daily loss (absolute INR) */
  phase8TargetMaxDailyLoss: num("PHASE8_TARGET_MAX_DAILY_LOSS", 15_000),
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
  /** Run end-of-day jobs (live-analyze + analyst) from the daemon loop */
  daemonEveningJobsEnabled: bool("DAEMON_EVENING_JOBS_ENABLED", true),
  /** Daemon local trigger time for live-analyze (IST HH:mm) */
  daemonEveningLiveAnalyzeAt: str("DAEMON_EVENING_LIVE_ANALYZE_AT", "15:35"),
  /** Daemon local trigger time for analyst (IST HH:mm) */
  daemonEveningAnalystAt: str("DAEMON_EVENING_ANALYST_AT", "15:45"),
  /** Replay: auto-backfill missing/weak `news_archive` days before judge-enabled backtests */
  backtestNewsAutoBackfill: bool("BACKTEST_NEWS_AUTO_BACKFILL", true),
  /** Replay: min headlines per weekday in `news_archive`; below this is treated as weak coverage */
  backtestNewsMinHeadlinesPerDay: num("BACKTEST_NEWS_MIN_HEADLINES_PER_DAY", 8),
  /** Replay auto-backfill mode: bypass market-keyword filter and keep raw ET archive headlines */
  backtestNewsAutoBackfillNoFilter: bool(
    "BACKTEST_NEWS_AUTO_BACKFILL_NO_FILTER",
    false,
  ),

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
  /** Max concurrent SmartAPI calls in-process; keep 1 unless Angel account limits are explicitly higher */
  angelHttpMaxConcurrency: num("ANGEL_HTTP_MAX_CONCURRENCY", 1),
  /** Retries when SmartAPI returns HTTP 403 (often rate limit); 0 disables */
  angelHttp403Retries: num("ANGEL_HTTP_403_RETRIES", 2),
  /** Retries when SmartAPI returns HTTP 429 */
  angelHttp429Retries: num("ANGEL_HTTP_429_RETRIES", 2),
  /** Base backoff for 403 retries (ms); multiplied by 2^attempt */
  angelHttp403RetryBaseMs: num("ANGEL_HTTP_403_RETRY_BASE_MS", 1500),
  /** Base cooldown injected into limiter after a rate-limit response; exponential by attempt */
  angelHttpRateLimitCooldownMs: num("ANGEL_HTTP_RATE_LIMIT_COOLDOWN_MS", 1500),
  /** Max cooldown cap for repeated 403/429s */
  angelHttpMaxBackoffMs: num("ANGEL_HTTP_MAX_BACKOFF_MS", 30_000),
  /** Random jitter added to rate-limit retries to avoid synchronized bursts */
  angelHttpRetryJitterMs: num("ANGEL_HTTP_RETRY_JITTER_MS", 200),
  /** If true, emits limiter queue/cooldown diagnostics */
  angelHttpLogLimiter: bool("ANGEL_HTTP_LOG_LIMITER", false),

  /** Pause between `getCandleData` chunk requests to avoid Angel rate limits (403) */
  angelApiThrottleMs: num("ANGEL_API_THROTTLE_MS", 450),
  /** Extra pause between tickers during `sync-history` */
  angelSyncTickerGapMs: num("ANGEL_SYNC_TICKER_GAP_MS", 800),
  /**
   * Per day-chunk: retries when getCandleData returns `status: false` (e.g. "Too many requests")
   * or empty failure — does not advance until success or this cap (then throws).
   */
  angelGetCandleChunkMaxAttempts: num("ANGEL_GET_CANDLE_CHUNK_MAX_ATTEMPTS", 2000),

  /** Pause between Angel `/quote` batches (≤50 symbols each, ~1 rps) */
  quoteBatchDelayMs: num("QUOTE_BATCH_DELAY_MS", 1100),

  /**
   * **NSE** (not SmartAPI): minimum gap between `nsearchives.nseindia.com` CSV fetches
   * in-process so we are polite to static hosts. Angel limits do not apply.
   */
  nseArchivesMinGapMs: num("NSE_ARCHIVES_MIN_GAP_MS", 10_000),
  /**
   * `static` — baked-in `DEFAULT_NIFTY50_HEAVYWEIGHTS` for INDEX_LAGGARD supplement lists.
   * `dynamic` — NSE `ind_nifty50list.csv` + top N by LTP×volume via Angel `marketQuote` (see rate limiter).
   */
  niftyHeavyweightsMode: (() => {
    const v = (process.env.NIFTY_HEAVYWEIGHTS_MODE ?? "static")
      .trim()
      .toLowerCase();
    return v === "dynamic" ? "dynamic" : "static";
  })(),
  /** How many names to keep from turnover ranking (default: top 10 “heavyweight” proxy). */
  niftyHeavyweightsDynamicTopN: num("NIFTY_HEAVYWEIGHTS_TOP_N", 10),

  /** Run discovery-sync once per weekday ~18:00 IST (POST_MORTEM window) */
  nightlyDiscoveryEnabled: process.env.NIGHTLY_DISCOVERY !== "false",

  /** Pre-open pivot during INIT (~9:10 IST): quotes + gap/volume filter */
  preopenPivotEnabled: process.env.PREOPEN_PIVOT !== "false",
  preopenJudgeEnabled: process.env.PREOPEN_JUDGE === "true",
  preopenMinAbsGapPct: num("PREOPEN_MIN_ABS_GAP_PCT", 1.5),
  preopenMinVolVsAvg: num("PREOPEN_MIN_VOL_VS_AVG", 0.2),
  preopenMaxCandidates: num("PREOPEN_MAX_CANDIDATES", 50),
  preopenMaxPicks: num("PREOPEN_MAX_PICKS", 10),

  dailyStopLoss: num("DAILY_STOP_LOSS", 15_000),
  maxConcurrentTrades: num("MAX_CONCURRENT_TRADES", 5),
  executionEnv: (process.env.EXECUTION_ENV ?? "PAPER") as "PAPER" | "LIVE",

  watchedTickers: (process.env.WATCHED_TICKERS ?? "RELIANCE,TCS,INFY")
    .split(",")
    .map((s) => s.trim()),

  /**
   * `env` — use `WATCHED_TICKERS` only.
   * `active_watchlist` — use Mongo `active_watchlist` doc `_id: current_session` (from discovery-sync).
   */
  tradingTickerSource: (process.env.TRADING_TICKER_SOURCE ??
    "active_watchlist") as "env" | "active_watchlist",

  /** Extra gap between symbols during discovery (daily fetch + scrip resolve); stay ≥1000ms under Angel limits */
  discoverySymbolDelayMs: num("DISCOVERY_SYMBOL_DELAY_MS", 2000),

  healthPort: num("HEALTH_PORT", 3000),

  /** When set, POST /v1/angel/postback requires header `x-postback-secret` to match */
  angelPostbackSecret: str("ANGEL_POSTBACK_SECRET", ""),
  /**
   * LIVE: poll `getOrderBook` on this interval (ms) as fallback for order updates.
   * Uses the existing SmartAPI queue; 0 disables.
   */
  orderReconciliationPollMs: num("ORDER_RECONCILIATION_POLL_MS", 0),

  /** SmartAPI market WebSocket 2.0 (LTP between 1m bars) */
  marketWsEnabled: bool("MARKET_WS_ENABLED", true),
  /** 1=LTP, 2=Quote (higher payload; prefer LTP for exits) */
  marketWsSubscriptionMode: num("MARKET_WS_SUBSCRIPTION_MODE", 1),
  marketWsMaxTokensPerBatch: num("MARKET_WS_MAX_TOKENS_PER_BATCH", 50),
  marketWsReconnectBaseMs: num("MARKET_WS_RECONNECT_BASE_MS", 2000),
  marketWsMaxReconnectMs: num("MARKET_WS_MAX_RECONNECT_MS", 120_000),

  /**
   * Throttled FULL quote: index + top K watchlist names (for circuit / book context).
   */
  fullQuoteThrottleMs: num("FULL_QUOTE_THROTTLE_MS", 15_000),
  fullQuoteTopK: num("FULL_QUOTE_TOP_K", 12),
  /** Block long entries when abs(ltp - circuit) / circuit * 100 is below this (index + name) */
  circuitProximityVetoPct: num("CIRCUIT_PROXIMITY_VETO_PCT", 0.5),

  /** Use LIMIT entry (LIVE → real API; broker must support) */
  executeLimitOrders: bool("EXECUTE_LIMIT_ORDERS", false),
  /** PAPER: if true, simulate limit fills vs last LTP when LIMIT is used */
  paperSimulateLimitFills: bool("PAPER_SIMULATE_LIMIT_FILLS", false),
  /** Soft cap on modifyOrder calls per calendar day (engine tracks) */
  orderModifyMaxPerDay: num("ORDER_MODIFY_MAX_PER_DAY", 8),
  /** Rupee offset from ref price for “aggressive” limit */
  aggressiveLimitTickOffset: num("AGGRESSIVE_LIMIT_TICK_OFFSET", 0.05),
  /**
   * Backtest: if true, optional limit-touch fill path in `backtest/microstructure` can be used
   * when simulating limit orders (separate from live `EXECUTE_LIMIT_ORDERS`).
   */
  backtestLimitTouchFill: bool("BACKTEST_LIMIT_TOUCH_FILL", false),

  niftySymbol: process.env.NIFTY_BENCHMARK_TICKER ?? "NIFTY50",

  /** Min ms between judge (or Pinecone-gate) decisions per ticker — live only */
  judgeCooldownMs: num("JUDGE_COOLDOWN_MS", 5 * 60 * 1000),
  /** If true, judge cooldown is scaled by candidate quality score */
  adaptiveJudgeCooldownEnabled: bool("ADAPTIVE_JUDGE_COOLDOWN_ENABLED", true),
  /** Adaptive judge cooldown lower bound (high-quality setups) */
  adaptiveJudgeCooldownMinMs: num("ADAPTIVE_JUDGE_COOLDOWN_MIN_MS", 60 * 1000),
  /** Adaptive judge cooldown upper bound (low-quality setups) */
  adaptiveJudgeCooldownMaxMs: num(
    "ADAPTIVE_JUDGE_COOLDOWN_MAX_MS",
    5 * 60 * 1000,
  ),
  /** Retry cooldown for strategy:ticker pairs blocked by hard risk veto */
  riskVetoRetryCooldownMs: num("RISK_VETO_RETRY_COOLDOWN_MS", 60 * 1000),
  /** After any position exit (stop, target, forced), block re-entry on that ticker for this long */
  tickerReentryCooldownMs: num("TICKER_REENTRY_COOLDOWN_MS", 20 * 60 * 1000),
  /** If true, rank and cap candidate triggers per ticker before full decisioning */
  candidateQueueEnabled: bool("CANDIDATE_QUEUE_ENABLED", true),
  /** Max ranked triggers evaluated per ticker per scan pass */
  maxCandidatesPerTicker: num("MAX_CANDIDATES_PER_TICKER", 2),
  /** If true, allow replacing weakest open position when book is full */
  replacementEnabled: bool("REPLACEMENT_ENABLED", true),
  /** Minimum quality score edge required to replace weakest open position */
  replacementMinScoreDelta: num("REPLACEMENT_MIN_SCORE_DELTA", 0.15),
  /** Minimum judge confidence required before replacement is allowed */
  replacementMinConfidence: num("REPLACEMENT_MIN_CONFIDENCE", 0.65),
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
    10,
  ),

  /** If top Pinecone neighbor is this similar and outcome WIN, skip LLM */
  pineconeGateEnabled: process.env.PINECONE_GATE_ENABLED !== "false",
  pineconeGateMinScore: num("PINECONE_GATE_MIN_SCORE", 0.92),
  /** Consensus gate: minimum strong neighbors required before auto-approval */
  pineconeGateMinNeighbors: num("PINECONE_GATE_MIN_NEIGHBORS", 3),
  /** Consensus gate: strong neighbor score threshold */
  pineconeGateConsensusMinScore: num("PINECONE_GATE_CONSENSUS_MIN_SCORE", 0.85),
  /** Consensus gate: minimum weighted win rate across strong neighbors */
  pineconeGateMinWinRate: num("PINECONE_GATE_MIN_WIN_RATE", 0.6),
  /** Consensus gate: same-strategy neighbor requirement */
  pineconeGateRequireSameStrategy: bool(
    "PINECONE_GATE_REQUIRE_SAME_STRATEGY",
    true,
  ),
  /** Consensus gate: same-sector neighbor weight multiplier */
  pineconeGateSameSectorWeight: num("PINECONE_GATE_SAME_SECTOR_WEIGHT", 1.2),
  /** Consensus gate: same-vol-regime neighbor weight multiplier */
  pineconeGateSameRegimeWeight: num("PINECONE_GATE_SAME_REGIME_WEIGHT", 1.1),

  /** Skip OpenAI embed + Pinecone upsert when vector id already exists (weekend-optimize) */
  weekendOptimizeSkipExisting:
    process.env.WEEKEND_OPTIMIZE_SKIP_EXISTING !== "false",
  /** Resume weekend-optimize across tickers after interrupt (same IST day + same ticker set) */
  weekendOptimizeResume: process.env.WEEKEND_OPTIMIZE_RESUME !== "false",
  /** Pinecone fetch batch size for existence checks */
  weekendOptimizeFetchBatch: num("WEEKEND_OPTIMIZE_FETCH_BATCH", 100),
  /** Pinecone read unit monthly soft cap (0 disables soft-cap enforcement) */
  pineconeRuSoftLimit: num("PINECONE_RU_SOFT_LIMIT", 0),
  /** Pinecone write unit monthly soft cap (0 disables soft-cap enforcement) */
  pineconeWuSoftLimit: num("PINECONE_WU_SOFT_LIMIT", 0),
  /** If true, auto-disable Pinecone reads after RU quota/rate-limit exhaustion */
  pineconeAutoDisableReadsOnRuExhaust: bool(
    "PINECONE_AUTO_DISABLE_READS_ON_RU_EXHAUST",
    true,
  ),
  /** If true, auto-disable Pinecone writes after WU quota/rate-limit exhaustion */
  pineconeAutoDisableWritesOnWuExhaust: bool(
    "PINECONE_AUTO_DISABLE_WRITES_ON_WU_EXHAUST",
    true,
  ),
  /** If true, storage-full upserts trigger oldest-id eviction and retry */
  pineconeAutoEvictOnStorageFull: bool(
    "PINECONE_AUTO_EVICT_ON_STORAGE_FULL",
    true,
  ),
  /** Oldest IDs removed in one eviction pass when storage is full */
  pineconeStorageEvictBatch: num("PINECONE_STORAGE_EVICT_BATCH", 200),
  /** Max pages scanned while collecting eviction candidates */
  pineconeStorageEvictScanPages: num("PINECONE_STORAGE_EVICT_SCAN_PAGES", 10),
  /** Wait after delete before retrying upsert (storage reallocation lag) */
  pineconeStorageReallocateWaitMs: num(
    "PINECONE_STORAGE_REALLOCATE_WAIT_MS",
    20_000,
  ),
  /** Max eviction+retry attempts for one upsert */
  pineconeStorageMaxEvictionRetries: num(
    "PINECONE_STORAGE_MAX_EVICTION_RETRIES",
    3,
  ),
  /** Cooldown between governor state writes/log lines */
  pineconeGovernorLogCooldownMs: num(
    "PINECONE_GOVERNOR_LOG_COOLDOWN_MS",
    60_000,
  ),

  /**
   * If set, `POST /v1/emergency/square-off` requires header `X-Emergency-Key: <value>`.
   * Empty disables the route (returns 404).
   */
  emergencySquareOffSecret: process.env.EMERGENCY_SQUARE_OFF_SECRET ?? "",

  // ── Institutional risk gates ───────────────────────────────────────────────
  /** Max open positions in one sector */
  maxSectorPositions: num("MAX_SECTOR_POSITIONS", 2),
  /** Max open positions on the same side */
  maxSameSidePositions: num("MAX_SAME_SIDE_POSITIONS", 3),
  /** Max allowed rolling correlation with any open ticker */
  maxCorrelationWithOpen: num("MAX_CORRELATION_WITH_OPEN", 0.7),
  /** Calendar-day lookback used to compute daily return correlations */
  correlationLookbackDays: num("CORRELATION_LOOKBACK_DAYS", 20),
  /** Gross notional exposure cap vs account equity */
  maxGrossExposurePct: num("MAX_GROSS_EXPOSURE_PCT", 1.5),
  /** Beta-weighted notional exposure cap vs account equity */
  maxBetaExposurePct: num("MAX_BETA_EXPOSURE_PCT", 2.0),
  /** If true, shrink qty to fit gross/beta exposure headroom before hard-blocking */
  exposureFitSizingEnabled: bool("EXPOSURE_FIT_SIZING_ENABLED", true),
  /** Rolling 3-session net PnL hard stop */
  rolling3dDrawdownLimit: num("ROLLING_3D_DRAWDOWN_LIMIT", 40_000),
  /** Rolling 7-calendar-day net PnL hard stop */
  weeklyDrawdownLimit: num("WEEKLY_DRAWDOWN_LIMIT", 50_000),
  /** Consecutive realized losses before position size is throttled */
  consecutiveLossThrottle: num("CONSECUTIVE_LOSS_THROTTLE", 3),
  /** Position-size multiplier once consecutive loss throttle is active */
  lossThrottleSizeMultiplier: num("LOSS_THROTTLE_SIZE_MULTIPLIER", 0.5),
  /** If true, non-catastrophic portfolio breaches use size throttles instead of hard veto */
  riskSoftThrottlesEnabled: bool("RISK_SOFT_THROTTLES_ENABLED", true),
  /** Size multiplier when sector cap is exceeded under soft-throttle mode */
  softSectorOverflowSizeMultiplier: num(
    "SOFT_SECTOR_OVERFLOW_SIZE_MULTIPLIER",
    0.75,
  ),
  /** Size multiplier when same-side cap is exceeded under soft-throttle mode */
  softSameSideOverflowSizeMultiplier: num(
    "SOFT_SAME_SIDE_OVERFLOW_SIZE_MULTIPLIER",
    0.65,
  ),
  /** Correlation above this level is treated as catastrophic and hard-blocked */
  softCorrelationHardBlock: num("SOFT_CORRELATION_HARD_BLOCK", 0.9),
  /** Minimum size multiplier reached as correlation approaches hard-block level */
  softCorrelationMinSizeMultiplier: num(
    "SOFT_CORRELATION_MIN_SIZE_MULTIPLIER",
    0.5,
  ),

  // ── Market regime hard gates ───────────────────────────────────────────────
  marketGateEnabled: bool("MARKET_GATE_ENABLED", true),
  /** Replay only: NIFTY/breadth gate. If unset, follows `MARKET_GATE_ENABLED`. */
  backtestMarketGateEnabled: boolBacktestOverride(
    "BACKTEST_MARKET_GATE_ENABLED",
    "MARKET_GATE_ENABLED",
    true
  ),
  marketBlockLongBreakoutsNiftyPct: num(
    "MARKET_BLOCK_LONG_BREAKOUTS_NIFTY_PCT",
    -1.0,
  ),
  marketBlockLongBreakoutsBreadth: num(
    "MARKET_BLOCK_LONG_BREAKOUTS_BREADTH",
    0.3,
  ),
  marketWeakNiftyPct: num("MARKET_WEAK_NIFTY_PCT", -0.5),
  marketWeakBreadth: num("MARKET_WEAK_BREADTH", 0.4),
  marketWeakSizeMultiplier: num("MARKET_WEAK_SIZE_MULTIPLIER", 0.5),
  marketWeakConfidenceFloor: num("MARKET_WEAK_CONFIDENCE_FLOOR", 0.62),

  // ── Strategy time windows ─────────────────────────────────────────────────
  timeWindowsEnabled: bool("TIME_WINDOWS_ENABLED", true),
  noFreshEntriesAfter: str("NO_FRESH_ENTRIES_AFTER", "14:30"),
  orbEntryStart: str("ORB_ENTRY_START", "09:30"),
  orbEntryEnd: str("ORB_ENTRY_END", "11:30"),
  vwapEntryStart: str("VWAP_ENTRY_START", "10:00"),
  vwapEntryEnd: str("VWAP_ENTRY_END", "14:00"),
  meanRevEntryStart: str("MEAN_REV_ENTRY_START", "10:00"),
  meanRevEntryEnd: str("MEAN_REV_ENTRY_END", "14:30"),
  defaultEntryStart: str("DEFAULT_ENTRY_START", "09:30"),
  defaultEntryEnd: str("DEFAULT_ENTRY_END", "14:30"),

  // ── Session-aware execution policy ────────────────────────────────────────
  sessionPolicyEnabled: bool("SESSION_POLICY_ENABLED", true),
  /** Replay only: time-block policy. If unset, follows `SESSION_POLICY_ENABLED`. */
  backtestSessionPolicyEnabled: boolBacktestOverride(
    "BACKTEST_SESSION_POLICY_ENABLED",
    "SESSION_POLICY_ENABLED",
    true
  ),
  sessionOpenStrictStart: str("SESSION_OPEN_STRICT_START", "09:30"),
  sessionOpenStrictEnd: str("SESSION_OPEN_STRICT_END", "10:30"),
  sessionOpenSizeMultiplier: num("SESSION_OPEN_SIZE_MULTIPLIER", 0.8),
  sessionOpenConfidenceFloor: num("SESSION_OPEN_CONFIDENCE_FLOOR", 0.62),
  sessionMidStart: str("SESSION_MID_START", "10:30"),
  sessionMidEnd: str("SESSION_MID_END", "13:30"),
  sessionMidSizeMultiplier: num("SESSION_MID_SIZE_MULTIPLIER", 1.0),
  sessionMidConfidenceFloor: num("SESSION_MID_CONFIDENCE_FLOOR", 0.5),
  sessionLateStart: str("SESSION_LATE_START", "13:30"),
  sessionLateEnd: str("SESSION_LATE_END", "15:00"),
  sessionLateSizeMultiplier: num("SESSION_LATE_SIZE_MULTIPLIER", 0.75),
  sessionLateConfidenceFloor: num("SESSION_LATE_CONFIDENCE_FLOOR", 0.67),
  sessionLowConvictionBlockAfter: str(
    "SESSION_LOW_CONVICTION_BLOCK_AFTER",
    "15:00",
  ),
  sessionLowConvictionMinConfidence: num(
    "SESSION_LOW_CONVICTION_MIN_CONFIDENCE",
    0.72,
  ),

  // ── Trigger quality gates ─────────────────────────────────────────────────
  ema20RetestMinVolumeZ: num("EMA20_RETEST_MIN_VOLUME_Z", 0),
  vwapContinuationMinVolumeZ: num("VWAP_CONTINUATION_MIN_VOLUME_Z", 0.5),
  retestMaxBarsAfterBreak: num("RETEST_MAX_BARS_AFTER_BREAK", 20),
  orbFakeoutConfirmationBars: num("ORB_FAKEOUT_CONFIRMATION_BARS", 2),

  // ── Exit / Risk parameters ─────────────────────────────────────────────────
  /** Stop-loss distance from entry as fraction (fallback when ATR unavailable) */
  exitStopPct: num("EXIT_STOP_PCT", 0.012),
  /** Profit-target distance from entry as fraction (fallback when ATR unavailable) */
  exitTargetPct: num("EXIT_TARGET_PCT", 0.02),
  /** Profit % that activates the trailing stop (fallback when ATR unavailable) */
  exitTrailTriggerPct: num("EXIT_TRAIL_TRIGGER_PCT", 0.008),
  /** Trailing stop distance from peak as fraction (fallback when ATR unavailable) */
  exitTrailDistPct: num("EXIT_TRAIL_DIST_PCT", 0.005),
  /** Position size in shares for backtest PnL calculation */
  backtestPositionQty: num("BACKTEST_POSITION_QTY", 25),

  // ── Live / daemon strategy toggles (default on: omit or any value except "false") ──
  liveEnableOrb15m: process.env.LIVE_ENABLE_ORB_15M !== "false",
  liveEnableOrbRetest15m: process.env.LIVE_ENABLE_ORB_RETEST_15M !== "false",
  liveEnableMeanRevZ: process.env.LIVE_ENABLE_MEAN_REV_Z !== "false",
  liveEnableBigBoySweep: process.env.LIVE_ENABLE_BIG_BOY_SWEEP !== "false",
  liveEnableVwapReclaimReject:
    process.env.LIVE_ENABLE_VWAP_RECLAIM_REJECT !== "false",
  liveEnableVwapPullbackTrend:
    process.env.LIVE_ENABLE_VWAP_PULLBACK_TREND !== "false",
  liveEnablePrevDayBreakRetest:
    process.env.LIVE_ENABLE_PREV_DAY_HIGH_LOW_BREAK_RETEST !== "false",
  liveEnableEma20BreakRetest:
    process.env.LIVE_ENABLE_EMA20_BREAK_RETEST !== "false",
  liveEnableVwapReclaimContinuation:
    process.env.LIVE_ENABLE_VWAP_RECLAIM_CONTINUATION !== "false",
  liveEnableInitialBalanceBreakRetest:
    process.env.LIVE_ENABLE_INITIAL_BALANCE_BREAK_RETEST !== "false",
  liveEnableVolContractionBreakout:
    process.env.LIVE_ENABLE_VOLATILITY_CONTRACTION_BREAKOUT !== "false",
  liveEnableInsideBarBreakoutRetest:
    process.env.LIVE_ENABLE_INSIDE_BAR_BREAKOUT_WITH_RETEST !== "false",
  liveEnableOpenDrivePullback:
    process.env.LIVE_ENABLE_OPEN_DRIVE_PULLBACK !== "false",
  liveEnableOrbFakeoutReversal:
    process.env.LIVE_ENABLE_ORB_FAKEOUT_REVERSAL !== "false",
  liveEnableEmaRibbonTrend: bool("LIVE_ENABLE_EMA_RIBBON_TREND", true),
  liveEnableCandleMomentumSurge: bool(
    "LIVE_ENABLE_CANDLE_MOMENTUM_SURGE",
    true,
  ),
  liveEnableTrendFlagBreakout: bool("LIVE_ENABLE_TREND_FLAG_BREAKOUT", true),
  liveEnableVwapReversalConfirmation: bool(
    "LIVE_ENABLE_VWAP_REVERSAL_CONFIRMATION",
    true,
  ),
  liveEnableFiveMinOrbBreak: bool("LIVE_ENABLE_FIVE_MIN_ORB_BREAK", true),
  liveEnableSessionHighLowBreak: bool(
    "LIVE_ENABLE_SESSION_HIGH_LOW_BREAK",
    true,
  ),
  liveEnableEngulfingWithVolume: bool(
    "LIVE_ENABLE_ENGULFING_WITH_VOLUME",
    true,
  ),
  liveEnableDonchian20Breakout: bool(
    "LIVE_ENABLE_DONCHIAN_20_BREAKOUT",
    true,
  ),
  liveEnableThreeBarPullbackContinuation: bool(
    "LIVE_ENABLE_THREE_BAR_PULLBACK_CONTINUATION",
    true,
  ),
  liveEnableNr7ExpansionBreakout: bool(
    "LIVE_ENABLE_NR7_EXPANSION_BREAKOUT",
    true,
  ),
  liveEnableIndexLaggardCatchup: bool(
    "LIVE_ENABLE_INDEX_LAGGARD_CATCHUP",
    true,
  ),

  /** Replay-only strategy toggles; live uses `liveEnable*` above. */
  backtestEnableOrb15m: process.env.BACKTEST_ENABLE_ORB_15M !== "false",
  backtestEnableOrbRetest15m:
    process.env.BACKTEST_ENABLE_ORB_RETEST_15M !== "false",
  backtestEnableMeanRevZ: process.env.BACKTEST_ENABLE_MEAN_REV_Z !== "false",
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
  /** EMA9 vs EMA21 ribbon trend-pullback — fires more frequently than VWAP_PULLBACK_TREND */
  backtestEnableEmaRibbonTrend: bool("BACKTEST_ENABLE_EMA_RIBBON_TREND", true),
  /** Large momentum candle with volume surge — works across all vol regimes */
  backtestEnableCandleMomentumSurge: bool("BACKTEST_ENABLE_CANDLE_MOMENTUM_SURGE", true),
  /** Bull/bear flag breakout — tight consolidation after strong move then breakout */
  backtestEnableTrendFlagBreakout: bool("BACKTEST_ENABLE_TREND_FLAG_BREAKOUT", true),
  /** Confirmed VWAP reversal — waits for reversal bar after overextension (higher accuracy than MEAN_REV_Z) */
  backtestEnableVwapReversalConfirmation: bool("BACKTEST_ENABLE_VWAP_REVERSAL_CONFIRMATION", true),
  /** 5-minute ORB break (9:15–9:19 range) — tighter levels, fires earlier than ORB_15M */
  backtestEnableFiveMinOrbBreak: bool("BACKTEST_ENABLE_FIVE_MIN_ORB_BREAK", true),
  /** New session high/low with volume — pure momentum, no vol-regime gate */
  backtestEnableSessionHighLowBreak: bool("BACKTEST_ENABLE_SESSION_HIGH_LOW_BREAK", true),
  /** Engulfing candle with volume confirmation — price action signal, all regimes */
  backtestEnableEngulfingWithVolume: bool("BACKTEST_ENABLE_ENGULFING_WITH_VOLUME", true),
  /** Donchian 20-bar breakout with trend + volume filters — all regimes */
  backtestEnableDonchian20Breakout: bool("BACKTEST_ENABLE_DONCHIAN_20_BREAKOUT", true),
  /** Trend continuation after controlled 3-bar pullback — all regimes */
  backtestEnableThreeBarPullbackContinuation: bool(
    "BACKTEST_ENABLE_THREE_BAR_PULLBACK_CONTINUATION",
    true,
  ),
  /** NR7 setup bar expansion breakout with confirmation — all regimes */
  backtestEnableNr7ExpansionBreakout: bool(
    "BACKTEST_ENABLE_NR7_EXPANSION_BREAKOUT",
    true,
  ),
  /** Nifty-50 overweight catch-up (heavyweights only) — needs NIFTY50 + 1m history in Mongo */
  backtestEnableIndexLaggardCatchup: bool(
    "BACKTEST_ENABLE_INDEX_LAGGARD_CATCHUP",
    true,
  ),
  /** Min 5-session % for NIFTY (same definition as discovery pct5d) */
  indexLaggardNiftyPct5dMin: num("INDEX_LAGGARD_NIFTY_PCT5D_MIN", 0.8),
  /** Laggard must be ≤ this 5-session % (flat/weak) */
  indexLaggardTickerPct5dMax: num("INDEX_LAGGARD_TICKER_PCT5D_MAX", 0.2),
  /** Nifty **today** from open must be ≥ this % to count as “sustaining” with VWAP */
  indexLaggardNiftySessionMinFromOpenPct: num(
    "INDEX_LAGGARD_NIFTY_SESSION_MIN_FROM_OPEN_PCT",
    0.05,
  ),
  indexLaggardMinVolumeZ: num("INDEX_LAGGARD_MIN_VOLUME_Z", 0.25),
  /** When true, discovery-sync OHLC also pulls NIFTY50 + Nifty-50 top weights */
  discoverySyncIndexLaggardUniverse: bool(
    "DISCOVERY_SYNC_INDEX_LAGGARD_UNIVERSE",
    true,
  ),
  /** Exec auto-sync: always include NIFTY50 + heavyweights (deduped with watchlist) */
  liveExecSyncSupplementLaggardUniverse: bool(
    "LIVE_EXEC_SYNC_SUPPLEMENT_LAGGARD_UNIVERSE",
    true,
  ),

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
  /** Max per-trade notional as fraction of equity (0.25 = 25% of equity) */
  maxNotionalPerTradePct: num("MAX_NOTIONAL_PER_TRADE_PCT", 0.25),
  /** Min shares per trade (floor) */
  minQtyPerTrade: num("MIN_QTY_PER_TRADE", 1),
  /** Enable ATR-based dynamic exits (false = use fixed % exits) */
  atrExitsEnabled: bool("ATR_EXITS_ENABLED", true),
  /** Enable ATR-based position sizing (false = use fixed qty) */
  atrSizingEnabled: bool("ATR_SIZING_ENABLED", true),
  /** Confidence scaling factor, only used when CONFIDENCE_SIZING_ENABLED=true. */
  confidenceScaleFactor: num("CONFIDENCE_SCALE_FACTOR", 1.5),
  /** If false, LLM/Pinecone confidence approves/denies but does not increase size */
  confidenceSizingEnabled: bool("CONFIDENCE_SIZING_ENABLED", false),
  /** Upper bound for confidence-based size multiplier when enabled */
  confidenceMultiplierMax: num("CONFIDENCE_MULTIPLIER_MAX", 1.3),
  /** If true, blend raw judge confidence with empirical bucket outcomes */
  confidenceCalibrationEnabled: bool("CONFIDENCE_CALIBRATION_ENABLED", true),
  /** Lookback in days for building live confidence calibration table */
  confidenceCalibrationLookbackDays: num(
    "CONFIDENCE_CALIBRATION_LOOKBACK_DAYS",
    45,
  ),
  /** Minimum closed trades needed before calibration is applied */
  confidenceCalibrationMinSamples: num(
    "CONFIDENCE_CALIBRATION_MIN_SAMPLES",
    80,
  ),
  /** Blend weight toward empirical confidence (0=no calibration, 1=fully empirical) */
  confidenceCalibrationWeight: num("CONFIDENCE_CALIBRATION_WEIGHT", 0.5),

  // ── Partial exits ──────────────────────────────────────────────────────────
  partialExitsEnabled: bool("PARTIAL_EXITS_ENABLED", true),
  partialExit1AtrMultiple: num("PARTIAL_EXIT_1_ATR_MULTIPLE", 1.0),
  partialExit1QtyPct: num("PARTIAL_EXIT_1_QTY_PCT", 0.33),
  partialExit2AtrMultiple: num("PARTIAL_EXIT_2_ATR_MULTIPLE", 2.0),
  partialExit2QtyPct: num("PARTIAL_EXIT_2_QTY_PCT", 0.33),

  // ── Strategy auto-gate (rolling performance filter) ────────────────────
  /** Enable automatic strategy disabling based on rolling performance */
  strategyAutoGateEnabled: bool("STRATEGY_AUTO_GATE_ENABLED", true),
  /** Rolling trade window for strategy performance evaluation */
  strategyGateWindow: num("STRATEGY_GATE_WINDOW", 20),
  /** Minimum closed-trade sample before strategy auto-gate can disable */
  strategyGateMinTrades: num("STRATEGY_GATE_MIN_TRADES", 12),
  /** Minimum profit factor to keep strategy active (below this → disabled) */
  strategyGateMinPf: num("STRATEGY_GATE_MIN_PF", 0.8),
  /** Minimum win rate (0-1) to keep strategy active */
  strategyGateMinWinRate: num("STRATEGY_GATE_MIN_WIN_RATE", 0.3),
  /** If true, strategy gate uses decay-weighted PF/WR (recent trades matter more) */
  strategyGateDecayEnabled: bool("STRATEGY_GATE_DECAY_ENABLED", true),
  /** Half-life in trades for decay weighting (lower = more recent emphasis) */
  strategyGateDecayHalfLifeTrades: num(
    "STRATEGY_GATE_DECAY_HALFLIFE_TRADES",
    10,
  ),
  /** If true, disabled strategies can auto-reenable after cooldown + improvement */
  strategyReenableEnabled: bool("STRATEGY_REENABLE_ENABLED", true),
  /** Minimum days a strategy stays disabled before re-enable checks apply */
  strategyReenableCooldownDays: num("STRATEGY_REENABLE_COOLDOWN_DAYS", 2),
  /** Recent trades used for improvement trigger */
  strategyReenableRecentTrades: num("STRATEGY_REENABLE_RECENT_TRADES", 8),
  /** Re-enable trigger minimum profit factor on recent trades */
  strategyReenableMinPf: num("STRATEGY_REENABLE_MIN_PF", 1.05),
  /** Re-enable trigger minimum win rate on recent trades */
  strategyReenableMinWinRate: num("STRATEGY_REENABLE_MIN_WIN_RATE", 0.45),

  // ── Lessons feedback loop ─────────────────────────────────────────────
  /** Inject yesterday's lessons_learned into judge prompt */
  lessonsFeedbackEnabled: bool("LESSONS_FEEDBACK_ENABLED", true),

  // ── Volatility regime switch (strategy gating) ────────────────────────────
  /** If true, gate strategies by intraday realized-volatility regime (low/mid/high) */
  volRegimeSwitchEnabled: bool("VOL_REGIME_SWITCH_ENABLED", true),
  /** Number of bars used to compute realized-volatility regime */
  volRegimeLookbackBars: num("VOL_REGIME_LOOKBACK_BARS", 20),
  /** Low regime threshold: realized vol % below this is LOW */
  volRegimeLowMaxPct: num("VOL_REGIME_LOW_MAX_PCT", 0.08),
  /** High regime threshold: realized vol % at/above this is HIGH (raised from 0.22 — was too aggressive) */
  volRegimeHighMinPct: num("VOL_REGIME_HIGH_MIN_PCT", 0.35),
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
    0.25,
  ),
  /** Scales bar-range-derived volatility into slippage bps */
  backtestVolatilitySlippageCoeff: num(
    "BACKTEST_VOLATILITY_SLIPPAGE_COEFF",
    0.1,
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
