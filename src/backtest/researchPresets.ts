/**
 * Built-in key/value grids for `bun run backtest-research`.
 * String values are passed through to `process.env` (same as `.env` format).
 */

export const RESEARCH_PRESET_GRIDS: Record<string, Record<string, string[]>> = {
  /**
   * ATR stop and profit-target multiples (9 combos).
   * Works with `ATR_EXITS_ENABLED=true` (default).
   */
  atrrisk: {
    ATR_STOP_MULTIPLE: ["1.0", "1.5", "2.0"],
    ATR_TARGET_MULTIPLE: ["2.0", "2.5", "3.0"],
  },
  /**
   * Trailing stop tuning (9 combos).
   */
  trail: {
    ATR_TRAIL_TRIGGER_MULTIPLE: ["0.75", "1.0", "1.25"],
    ATR_TRAIL_DIST_MULTIPLE: ["0.5", "0.75", "1.0"],
  },
  /**
   * Replay-only session and market (NIFTY/breadth) gates (4 combos).
   */
  gates: {
    BACKTEST_SESSION_POLICY_ENABLED: ["true", "false"],
    BACKTEST_MARKET_GATE_ENABLED: ["true", "false"],
  },
  /**
   * Microstructure cost stress (9 combos).
   */
  micro: {
    BACKTEST_BASE_SLIPPAGE_BPS: ["1.0", "2.0", "3.5"],
    BACKTEST_SPREAD_BPS: ["2", "3", "5"],
  },
  /**
   * Global vol-regime gating: which strategies are allowed per regime.
   */
  "vol-regime": {
    VOL_REGIME_SWITCH_ENABLED: ["true", "false"],
  },
  /**
   * Small smoke grid for wiring checks (4 combos).
   */
  quick: {
    ATR_STOP_MULTIPLE: ["1.5", "2.0"],
    ATR_TARGET_MULTIPLE: ["2.5", "3.0"],
  },
  /**
   * Fixed-% exits (when you set `ATR_EXITS_ENABLED=false` for that run);
   * 3×3 with typical intraday R multiples expressed as %.
   */
  "fixed-pct": {
    EXIT_STOP_PCT: ["0.008", "0.012", "0.016"],
    EXIT_TARGET_PCT: ["0.015", "0.02", "0.025"],
  },
};

export const RESEARCH_PRESET_NAMES = Object.keys(
  RESEARCH_PRESET_GRIDS
).sort();
