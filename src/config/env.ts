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

  dailyStopLoss: num("DAILY_STOP_LOSS", 25_000),
  maxConcurrentTrades: num("MAX_CONCURRENT_TRADES", 3),
  executionEnv: (process.env.EXECUTION_ENV ?? "PAPER") as "PAPER" | "LIVE",

  watchedTickers: (process.env.WATCHED_TICKERS ?? "RELIANCE,TCS,INFY").split(",").map((s) => s.trim()),

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
