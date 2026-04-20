import "dotenv/config";
import { spawnSync } from "node:child_process";
import { collections, getDb } from "../db/mongo.js";
import { runCli } from "./runCli.js";

const STRAT_ENV_KEYS = [
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

type ProfileKey =
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

interface Args {
  from: string;
  to: string;
  step: number;
  skipJudge: boolean;
  sync: boolean;
  forceSyncAll: boolean;
  clearFirst: boolean;
  profiles: ProfileKey[];
}

interface ProfileSpec {
  key: ProfileKey;
  label: string;
  env: Record<string, string>;
}

function allStrategiesOffEnv(): Record<string, string> {
  return Object.fromEntries(STRAT_ENV_KEYS.map((k) => [k, "false"]));
}

function onlyEnabled(key: (typeof STRAT_ENV_KEYS)[number]): Record<string, string> {
  return { ...allStrategiesOffEnv(), [key]: "true", VOL_REGIME_SWITCH_ENABLED: "false" };
}

const PROFILE_SPECS: Record<ProfileKey, ProfileSpec> = {
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

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let from = "";
  let to = "";
  let step = 15;
  let skipJudge = false;
  let sync = false;
  let forceSyncAll = false;
  let clearFirst = true;
  let profiles: ProfileKey[] = [
    "baseline",
    "orb15-only",
    "meanrev-only",
    "bigboy-only",
    "vwap-reclaim-reject-only",
    "orb-retest-only",
    "vwap-pullback-only",
    "prevday-break-retest-only",
    "ema20-break-retest-only",
    "vwap-reclaim-cont-only",
    "ib-break-retest-only",
    "vol-contraction-only",
    "insidebar-retest-only",
    "opendrive-pullback-only",
    "orb-fakeout-only",
    "regime-switch",
  ];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from" && argv[i + 1]) {
      from = argv[++i]!;
      continue;
    }
    if (a === "--to" && argv[i + 1]) {
      to = argv[++i]!;
      continue;
    }
    if (a === "--step" && argv[i + 1]) {
      step = Number(argv[++i]);
      continue;
    }
    if (a === "--skip-judge") {
      skipJudge = true;
      continue;
    }
    if (a === "--sync") {
      sync = true;
      continue;
    }
    if (a === "--force-sync-all") {
      forceSyncAll = true;
      continue;
    }
    if (a === "--no-clear-first") {
      clearFirst = false;
      continue;
    }
    if (a === "--profiles" && argv[i + 1]) {
      profiles = argv[++i]!
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
        .map((s) => {
          if (!(s in PROFILE_SPECS)) {
            throw new Error(`Unknown profile: ${s}`);
          }
          return s as ProfileKey;
        });
      continue;
    }
  }

  if (!from || !to) {
    throw new Error(`Usage:
  bun run backtest-ablation -- --from YYYY-MM-DD --to YYYY-MM-DD [options]

Options:
  --step 15
  --skip-judge
  --sync
  --force-sync-all
  --no-clear-first
  --profiles baseline,all-strategies,regime-switch,orb15-only,orb-retest-only,meanrev-only,bigboy-only,vwap-reclaim-reject-only,vwap-pullback-only,prevday-break-retest-only,ema20-break-retest-only,vwap-reclaim-cont-only,ib-break-retest-only,vol-contraction-only,insidebar-retest-only,opendrive-pullback-only,orb-fakeout-only
`);
  }

  if (!Number.isFinite(step) || step < 1) {
    throw new Error("--step must be a positive integer");
  }

  if (profiles.length === 0) {
    throw new Error("--profiles cannot be empty");
  }

  return {
    from,
    to,
    step: Math.floor(step),
    skipJudge,
    sync,
    forceSyncAll,
    clearFirst,
    profiles,
  };
}

function runAndCapture(cmd: string, args: string[], envOverride?: Record<string, string>): string {
  const res = spawnSync(cmd, args, {
    env: { ...process.env, ...(envOverride ?? {}) },
    encoding: "utf8",
  });

  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  process.stdout.write(out);

  if ((res.status ?? 1) !== 0) {
    throw new Error(`Command failed (${cmd} ${args.join(" ")}) with status ${res.status}`);
  }

  return out;
}

function extractRunId(output: string): string {
  const m = output.match(/runId:\s*"([^"]+)"/);
  if (!m?.[1]) throw new Error("Could not parse runId from backtest output");
  return m[1];
}

async function clearTradesBacktest(): Promise<void> {
  const db = await getDb();
  const r = await db.collection(collections.tradesBacktest).deleteMany({});
  console.log(`[backtest-ablation] cleared trades_backtest rows: ${r.deletedCount}`);
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.clearFirst) {
    await clearTradesBacktest();
  } else {
    console.log("[backtest-ablation] keeping existing trades_backtest rows (--no-clear-first)");
  }

  const selected = args.profiles.map((k) => PROFILE_SPECS[k]);
  const results: Array<{ profile: string; runId: string }> = [];

  for (let i = 0; i < selected.length; i++) {
    const p = selected[i]!;
    console.log(`\n[backtest-ablation] profile ${i + 1}/${selected.length}: ${p.key} (${p.label})`);

    const btArgs = [
      "run",
      "src/cli/backtest-snapshots.ts",
      "--",
      "--from",
      args.from,
      "--to",
      args.to,
      "--step",
      String(args.step),
      "--no-clear-trades",
      "--no-analyze",
    ];
    if (!args.sync) btArgs.push("--no-sync");
    if (args.forceSyncAll) btArgs.push("--force-sync-all");
    if (args.skipJudge) btArgs.push("--skip-judge");

    const btOut = runAndCapture("bun", btArgs, p.env);
    const runId = extractRunId(btOut);
    results.push({ profile: p.key, runId });

    runAndCapture("bun", [
      "run",
      "src/cli/backtest-analyze.ts",
      "--",
      "--run-id",
      runId,
    ]);
  }

  console.log("\n[backtest-ablation] completed");
  for (const r of results) {
    console.log(`  ${r.profile}: ${r.runId}`);
  }
}

runCli(main);
