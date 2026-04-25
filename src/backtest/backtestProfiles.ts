/**
 * Named strategy environment bundles for backtest ablation and research.
 * Live trading uses `LIVE_ENABLE_*`; replay uses `BACKTEST_ENABLE_*`.
 */
export const STRAT_ENV_KEYS = [
  "BACKTEST_ENABLE_ORB_15M",
  "BACKTEST_ENABLE_ORB_RETEST_15M",
  "BACKTEST_ENABLE_MEAN_REV_Z",
  "BACKTEST_ENABLE_BIG_BOY_SWEEP",
  "BACKTEST_ENABLE_VWAP_RECLAIM_REJECT",
  "BACKTEST_ENABLE_VWAP_PULLBACK_TREND",
  "BACKTEST_ENABLE_PREV_DAY_HIGH_LOW_BREAK_RETEST",
  "BACKTEST_ENABLE_EMA20_BREAK_RETEST",
  "BACKTEST_ENABLE_VWAP_RECLAIM_CONTINUATION",
  "BACKTEST_ENABLE_INITIAL_BALANCE_BREAK_RETEST",
  "BACKTEST_ENABLE_VOLATILITY_CONTRACTION_BREAKOUT",
  "BACKTEST_ENABLE_INSIDE_BAR_BREAKOUT_WITH_RETEST",
  "BACKTEST_ENABLE_OPEN_DRIVE_PULLBACK",
  "BACKTEST_ENABLE_ORB_FAKEOUT_REVERSAL",
] as const;

export type ProfileKey =
  | "baseline"
  | "all-strategies"
  | "regime-switch"
  | "orb15-only"
  | "orb-retest-only"
  | "meanrev-only"
  | "bigboy-only"
  | "vwap-reclaim-reject-only"
  | "vwap-pullback-only"
  | "prevday-break-retest-only"
  | "ema20-break-retest-only"
  | "vwap-reclaim-cont-only"
  | "ib-break-retest-only"
  | "vol-contraction-only"
  | "insidebar-retest-only"
  | "opendrive-pullback-only"
  | "orb-fakeout-only";

function allStrategiesOffEnv(): Record<string, string> {
  return Object.fromEntries(STRAT_ENV_KEYS.map((k) => [k, "false"]));
}

function onlyEnabled(
  key: (typeof STRAT_ENV_KEYS)[number]
): Record<string, string> {
  return { ...allStrategiesOffEnv(), [key]: "true", VOL_REGIME_SWITCH_ENABLED: "false" };
}

export interface ProfileSpec {
  key: ProfileKey;
  label: string;
  env: Record<string, string>;
}

export const PROFILE_SPECS: Record<ProfileKey, ProfileSpec> = {
  baseline: {
    key: "baseline",
    label: "Core baseline (ORB_15M + MEAN_REV_Z + BIG_BOY_SWEEP + VWAP_RECLAIM_REJECT)",
    env: {
      ...allStrategiesOffEnv(),
      BACKTEST_ENABLE_ORB_15M: "true",
      BACKTEST_ENABLE_MEAN_REV_Z: "true",
      BACKTEST_ENABLE_BIG_BOY_SWEEP: "true",
      BACKTEST_ENABLE_VWAP_RECLAIM_REJECT: "true",
      VOL_REGIME_SWITCH_ENABLED: "false",
    },
  },
  "all-strategies": {
    key: "all-strategies",
    label: "All implemented strategies enabled",
    env: {
      ...Object.fromEntries(STRAT_ENV_KEYS.map((k) => [k, "true"])),
      VOL_REGIME_SWITCH_ENABLED: "false",
    },
  },
  "regime-switch": {
    key: "regime-switch",
    label: "All strategies + volatility regime gating",
    env: {
      ...Object.fromEntries(STRAT_ENV_KEYS.map((k) => [k, "true"])),
      VOL_REGIME_SWITCH_ENABLED: "true",
    },
  },
  "orb15-only": {
    key: "orb15-only",
    label: "ORB_15M only",
    env: onlyEnabled("BACKTEST_ENABLE_ORB_15M"),
  },
  "orb-retest-only": {
    key: "orb-retest-only",
    label: "ORB_RETEST_15M only",
    env: onlyEnabled("BACKTEST_ENABLE_ORB_RETEST_15M"),
  },
  "meanrev-only": {
    key: "meanrev-only",
    label: "MEAN_REV_Z only",
    env: onlyEnabled("BACKTEST_ENABLE_MEAN_REV_Z"),
  },
  "bigboy-only": {
    key: "bigboy-only",
    label: "BIG_BOY_SWEEP only",
    env: onlyEnabled("BACKTEST_ENABLE_BIG_BOY_SWEEP"),
  },
  "vwap-reclaim-reject-only": {
    key: "vwap-reclaim-reject-only",
    label: "VWAP_RECLAIM_REJECT only",
    env: onlyEnabled("BACKTEST_ENABLE_VWAP_RECLAIM_REJECT"),
  },
  "vwap-pullback-only": {
    key: "vwap-pullback-only",
    label: "VWAP_PULLBACK_TREND only",
    env: onlyEnabled("BACKTEST_ENABLE_VWAP_PULLBACK_TREND"),
  },
  "prevday-break-retest-only": {
    key: "prevday-break-retest-only",
    label: "PREV_DAY_HIGH_LOW_BREAK_RETEST only",
    env: onlyEnabled("BACKTEST_ENABLE_PREV_DAY_HIGH_LOW_BREAK_RETEST"),
  },
  "ema20-break-retest-only": {
    key: "ema20-break-retest-only",
    label: "EMA20_BREAK_RETEST only",
    env: onlyEnabled("BACKTEST_ENABLE_EMA20_BREAK_RETEST"),
  },
  "vwap-reclaim-cont-only": {
    key: "vwap-reclaim-cont-only",
    label: "VWAP_RECLAIM_CONTINUATION only",
    env: onlyEnabled("BACKTEST_ENABLE_VWAP_RECLAIM_CONTINUATION"),
  },
  "ib-break-retest-only": {
    key: "ib-break-retest-only",
    label: "INITIAL_BALANCE_BREAK_RETEST only",
    env: onlyEnabled("BACKTEST_ENABLE_INITIAL_BALANCE_BREAK_RETEST"),
  },
  "vol-contraction-only": {
    key: "vol-contraction-only",
    label: "VOLATILITY_CONTRACTION_BREAKOUT only",
    env: onlyEnabled("BACKTEST_ENABLE_VOLATILITY_CONTRACTION_BREAKOUT"),
  },
  "insidebar-retest-only": {
    key: "insidebar-retest-only",
    label: "INSIDE_BAR_BREAKOUT_WITH_RETEST only",
    env: onlyEnabled("BACKTEST_ENABLE_INSIDE_BAR_BREAKOUT_WITH_RETEST"),
  },
  "opendrive-pullback-only": {
    key: "opendrive-pullback-only",
    label: "OPEN_DRIVE_PULLBACK only",
    env: onlyEnabled("BACKTEST_ENABLE_OPEN_DRIVE_PULLBACK"),
  },
  "orb-fakeout-only": {
    key: "orb-fakeout-only",
    label: "ORB_FAKEOUT_REVERSAL only",
    env: onlyEnabled("BACKTEST_ENABLE_ORB_FAKEOUT_REVERSAL"),
  },
};

export const PROFILE_KEYS: ProfileKey[] = Object.keys(
  PROFILE_SPECS
) as ProfileKey[];
