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
  judgeModel: process.env.JUDGE_MODEL ?? "deepseek/deepseek-chat",
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
  maxConcurrentTrades: num("MAX_CONCURRENT_TRADES", 3),
  executionEnv: (process.env.EXECUTION_ENV ?? "PAPER") as "PAPER" | "LIVE",

  watchedTickers: (process.env.WATCHED_TICKERS ?? "RELIANCE,TCS,INFY").split(",").map((s) => s.trim()),

  /**
   * `env` — use `WATCHED_TICKERS` only.
   * `active_watchlist` — use Mongo `active_watchlist` doc `_id: current_session` (from discovery-sync).
   */
  tradingTickerSource: (process.env.TRADING_TICKER_SOURCE ?? "env") as
    | "env"
    | "active_watchlist",

  /** Extra gap between symbols during discovery (daily fetch + scrip resolve); stay ≥1000ms under Angel limits */
  discoverySymbolDelayMs: num("DISCOVERY_SYMBOL_DELAY_MS", 2000),

  healthPort: num("HEALTH_PORT", 3000),

  niftySymbol: process.env.NIFTY_BENCHMARK_TICKER ?? "NIFTY50",

  /** Min ms between judge (or Pinecone-gate) decisions per ticker — live only */
  judgeCooldownMs: num("JUDGE_COOLDOWN_MS", 15 * 60 * 1000),

  /** If top Pinecone neighbor is this similar and outcome WIN, skip LLM */
  pineconeGateEnabled: process.env.PINECONE_GATE_ENABLED !== "false",
  pineconeGateMinScore: num("PINECONE_GATE_MIN_SCORE", 0.98),

  /**
   * If set, `POST /v1/emergency/square-off` requires header `X-Emergency-Key: <value>`.
   * Empty disables the route (returns 404).
   */
  emergencySquareOffSecret: process.env.EMERGENCY_SQUARE_OFF_SECRET ?? "",
};
