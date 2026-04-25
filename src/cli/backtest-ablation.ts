import "dotenv/config";
import { spawnSync } from "node:child_process";
import { collections, getDb } from "../db/mongo.js";
import { runCli } from "./runCli.js";
import { PROFILE_SPECS, type ProfileKey } from "../backtest/backtestProfiles.js";

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

function runAndCapture(
  cmd: string,
  args: string[],
  envOverride?: Record<string, string>
): string {
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
    console.log(
      `\n[backtest-ablation] profile ${i + 1}/${selected.length}: ${p.key} (${p.label})`
    );

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
