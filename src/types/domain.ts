import type { Document } from "mongodb";

export type StrategyId =
  | "ORB_15M"
  | "ORB_RETEST_15M"
  | "MEAN_REV_Z"
  | "BIG_BOY_SWEEP"
  | "VWAP_RECLAIM_REJECT"
  | "VWAP_PULLBACK_TREND"
  | "PREV_DAY_HIGH_LOW_BREAK_RETEST"
  | "EMA20_BREAK_RETEST"
  | "VWAP_RECLAIM_CONTINUATION"
  | "INITIAL_BALANCE_BREAK_RETEST"
  | "VOLATILITY_CONTRACTION_BREAKOUT"
  | "INSIDE_BAR_BREAKOUT_WITH_RETEST"
  | "OPEN_DRIVE_PULLBACK"
  | "ORB_FAKEOUT_REVERSAL";

export type TradeOutcome = "WIN" | "LOSS" | "BREAKEVEN";

export interface Ohlc1m extends Document {
  ticker: string;
  ts: Date;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface TechnicalSnapshot {
  rsi?: number;
  vwap_dist?: number;
  volume_z?: number;
  z_score_vwap?: number;
  orb_high?: number;
  orb_low?: number;
  pdh?: number;
  pdl?: number;
  [key: string]: number | undefined;
}

export interface TradeLogDoc extends Document {
  ticker: string;
  entry_time: Date;
  /** Executed trade direction (set on live/backtest entries that were actually placed) */
  side?: "BUY" | "SELL";
  /** Fill price used as entry basis for exit PnL */
  entry_price?: number;
  /** True when an order was executed; false for logged non-entry decisions */
  order_executed?: boolean;
  exit_time?: Date;
  strategy: StrategyId;
  env: "PAPER" | "LIVE";
  technical_snapshot: TechnicalSnapshot;
  ai_confidence: number;
  ai_reasoning: string;
  /** Set on rows written to `trades_backtest` */
  backtest_run_id?: string;
  result?: {
    /** Net PnL after slippage and charges */
    pnl: number;
    /** Total slippage cost in rupees (entry + exit) */
    slippage: number;
    outcome: TradeOutcome;
    pnl_percent?: number;
    /** Gross PnL before charges */
    gross_pnl?: number;
    /** Total modeled fees/taxes */
    charges?: number;
  };
}

/** Time-stamped headlines for replay (`news_archive` collection or JSON file) */
export interface NewsArchiveDoc extends Document {
  ts: Date;
  headlines: string[];
  source?: string;
}

export interface LessonLearnedDoc extends Document {
  date: string;
  summary: string;
  detail?: string;
  metrics?: Record<string, number>;
}

export interface NewsContextDoc extends Document {
  date: string;
  headlines: string[];
  source?: string;
  updated_at?: Date;
}

export interface PatternMeta {
  outcome: string;
  pnl_percent: number;
  date: string;
  ticker?: string;
  strategy?: string;
}

/** Mongo `active_watchlist` — session performers from discovery-sync */
export interface ActiveWatchlistDoc extends Document {
  _id: string;
  tickers: string[];
  updated_at: Date;
  source?: string;
  performers?: PerformerScoreRow[];
}

export interface PerformerScoreRow {
  ticker: string;
  score: number;
  pct5d: number;
  volRatio: number;
}

/** Dated watchlist for no-lookahead backtests (`watchlist_snapshots`) */
export interface WatchlistSnapshotDoc extends Document {
  /** IST session date this list applies to (YYYY-MM-DD) */
  effective_date: string;
  tickers: string[];
  source: string;
  performers?: PerformerScoreRow[];
  preopen_meta?: Record<string, unknown>;
  created_at: Date;
}
