/**
 * bun run backtest-research
 *
 * Sweeps a Cartesian grid of env overrides (or named profiles, or both), runs
 * `backtest-snapshots` for each combo, and ranks results from Mongo `trades_backtest`
 * (no need to run backtest-analyze for each run).
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ensureIndexes } from "../db/repositories.js";
import { collections, getDb } from "../db/mongo.js";
import type { TradeLogDoc } from "../types/domain.js";
import { runCli } from "./runCli.js";
import { PROFILE_SPECS, type ProfileKey } from "../backtest/backtestProfiles.js";
import { RESEARCH_PRESET_GRIDS, RESEARCH_PRESET_NAMES } from "../backtest/researchPresets.js";
import { cartesianEnv, formatEnvLine, mergeGrids, parseCommaValues } from "../backtest/researchGrid.js";
import { summarizeTrades, type BacktestRunStats } from "../backtest/tradeMetrics.js";

type SortKey = "train-pf" | "oos-pf" | "train-pnl" | "oos-pnl" | "min-pf" | "train-sharpe";

interface CliArgs {
  from: string;
  to: string;
  step: number;
  skipJudge: boolean;
  judgeModel?: string;
  sync: boolean;
  forceSyncAll: boolean;
  clearFirst: boolean;
  /** null = one dimension using your current .env for strategy toggles */
  profiles: (ProfileKey | null)[];
  presetNames: string[];
  setPairs: Array<{ key: string; values: string[] }>;
  validateFrom?: string;
  validateTo?: string;
  outDir: string;
  runTag: string;
  minTrades: number;
  minPf: number;
  maxRuns: number;
  allowHuge: boolean;
  continueOnError: boolean;
  dryRun: boolean;
  sort: SortKey;
  quiet: boolean;
}

function usage(): string {
  return `Usage:
  bun run backtest-research -- --from YYYY-MM-DD --to YYYY-MM-DD [options]

Builds a grid of env overrides, runs one full snapshot replay per combination,
and writes a ranked JSON/CSV report under reports/ (default).

Strategy profiles (optional, multiplies the grid; omit = use your .env as-is for BACKTEST_ENABLE_*):
  --profiles KEY,KEY,...
    Keys: ${Object.keys(PROFILE_SPECS).join(",")}

Presets (merge into the grid; use multiple --preset in order, later overwrites on same key):
  --preset NAME
    Names: ${RESEARCH_PRESET_NAMES.join(", ")}

Custom variables (add or override; comma = several values, Cartesian with other keys):
  --set ATR_STOP_MULTIPLE=1,1.5,2
  (repeat --set for more keys)

Validation / out-of-sample (optional, doubles runs per combo):
  --validate-from YYYY-MM-DD
  --validate-to YYYY-MM-DD

Run control:
  --step 15
  --skip-judge
  --judge-model <id>
  --sync                  pass --sync to backtest-snapshots (default: --no-sync)
  --force-sync-all
  --no-clear-first        do not delete trades_backtest at start
  --continue-on-error     keep going after a failed backtest
  --dry-run               print only the run plan (count, first few)

Filters & ranking (report only, does not skip runs):
  --min-trades N          default 0
  --min-pf X              default 0
  --sort train-pf|oos-pf|train-pnl|oos-pnl|min-pf|train-sharpe
                          default: train-pf
  --max-runs N            abort if plan exceeds N (default: 200)
  --allow-huge            allow plans larger than --max-runs
  --out-dir DIR           default: reports
  --tag LABEL             file prefix, default: research
  -q, --quiet             less console noise

Examples:
  bun run backtest-research -- --from 2026-03-01 --to 2026-03-28 --preset quick --skip-judge
  bun run backtest-research -- --from 2026-03-01 --to 2026-03-14 \\
    --profiles orb15-only,meanrev-only --preset atrrisk --skip-judge
  bun run backtest-research -- --from 2026-03-01 --to 2026-03-20 \\
    --set ATR_STOP_MULTIPLE=1.5,2 --set ATR_TARGET_MULTIPLE=2.5,3 --skip-judge
`;
}

function parseArgs(): CliArgs {
  const a = process.argv.slice(2);
  let from = "";
  let to = "";
  let step = 15;
  let skipJudge = false;
  let judgeModel: string | undefined;
  let sync = false;
  let forceSyncAll = false;
  let clearFirst = true;
  const profiles: (ProfileKey | null)[] = [];
  const presetNames: string[] = [];
  const setPairs: Array<{ key: string; values: string[] }> = [];
  let validateFrom: string | undefined;
  let validateTo: string | undefined;
  let outDir = "reports";
  let runTag = "research";
  let minTrades = 0;
  let minPf = 0;
  let maxRuns = 200;
  let allowHuge = false;
  let continueOnError = false;
  let dryRun = false;
  let sort: SortKey = "train-pf";
  let quiet = false;

  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--from" && a[i + 1]) {
      from = a[++i]!;
      continue;
    }
    if (a[i] === "--to" && a[i + 1]) {
      to = a[++i]!;
      continue;
    }
    if (a[i] === "--step" && a[i + 1]) {
      step = Math.max(1, Math.floor(Number(a[++i]!)) || 15);
      continue;
    }
    if (a[i] === "--skip-judge") {
      skipJudge = true;
      continue;
    }
    if (a[i] === "--judge-model" && a[i + 1]) {
      judgeModel = a[++i]!;
      continue;
    }
    if (a[i] === "--sync") {
      sync = true;
      continue;
    }
    if (a[i] === "--force-sync-all") {
      forceSyncAll = true;
      continue;
    }
    if (a[i] === "--no-clear-first") {
      clearFirst = false;
      continue;
    }
    if (a[i] === "--profiles" && a[i + 1]) {
      const raw = a[++i]!.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      for (const k of raw) {
        if (!(k in PROFILE_SPECS)) throw new Error(`Unknown profile: ${k}`);
        profiles.push(k as ProfileKey);
      }
      continue;
    }
    if (a[i] === "--preset" && a[i + 1]) {
      const name = a[++i]!.trim().toLowerCase();
      if (!RESEARCH_PRESET_GRIDS[name]) {
        throw new Error(
          `Unknown --preset ${name}. Valid: ${RESEARCH_PRESET_NAMES.join(", ")}`
        );
      }
      presetNames.push(name);
      continue;
    }
    if (a[i] === "--set" && a[i + 1]) {
      const raw = a[++i]!;
      const eq = raw.indexOf("=");
      if (eq < 1) throw new Error(`--set expects KEY=val1,val2, got: ${raw}`);
      const key = raw.slice(0, eq).trim();
      if (!key) throw new Error(`--set missing key: ${raw}`);
      const values = parseCommaValues(raw.slice(eq + 1));
      if (values.length === 0) throw new Error(`--set needs at least one value: ${raw}`);
      setPairs.push({ key, values });
      continue;
    }
    if (a[i] === "--validate-from" && a[i + 1]) {
      validateFrom = a[++i]!;
      continue;
    }
    if (a[i] === "--validate-to" && a[i + 1]) {
      validateTo = a[++i]!;
      continue;
    }
    if (a[i] === "--out-dir" && a[i + 1]) {
      outDir = a[++i]!;
      continue;
    }
    if (a[i] === "--tag" && a[i + 1]) {
      runTag = a[++i]!.replace(/[^a-zA-Z0-9_-]/g, "_");
      continue;
    }
    if (a[i] === "--min-trades" && a[i + 1]) {
      minTrades = Math.max(0, Math.floor(Number(a[++i]!) || 0));
      continue;
    }
    if (a[i] === "--min-pf" && a[i + 1]) {
      minPf = Number(a[++i]!);
      continue;
    }
    if (a[i] === "--max-runs" && a[i + 1]) {
      maxRuns = Math.max(1, Math.floor(Number(a[++i]!) || 200));
      continue;
    }
    if (a[i] === "--allow-huge") {
      allowHuge = true;
      continue;
    }
    if (a[i] === "--continue-on-error") {
      continueOnError = true;
      continue;
    }
    if (a[i] === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (a[i] === "--sort" && a[i + 1]) {
      const s = a[++i]! as SortKey;
      if (
        !["train-pf", "oos-pf", "train-pnl", "oos-pnl", "min-pf", "train-sharpe"].includes(
          s
        )
      ) {
        throw new Error("Invalid --sort (see help)");
      }
      sort = s;
      continue;
    }
    if (a[i] === "-q" || a[i] === "--quiet") {
      quiet = true;
      continue;
    }
  }

  if (!from || !to) {
    throw new Error(usage());
  }
  if (validateFrom && !validateTo) {
    throw new Error("--validate-from requires --validate-to");
  }
  if (!validateFrom && validateTo) {
    throw new Error("--validate-to requires --validate-from");
  }
  if (setPairs.length > 0) {
    const byKey = new Set<string>();
    for (const p of setPairs) {
      if (byKey.has(p.key)) {
        throw new Error(`--set: duplicate key ${p.key} (use one --set with comma list)`);
      }
      byKey.add(p.key);
    }
  }

  return {
    from,
    to,
    step,
    skipJudge,
    judgeModel,
    sync,
    forceSyncAll,
    clearFirst,
    profiles: profiles.length > 0 ? profiles : [null],
    presetNames,
    setPairs,
    validateFrom,
    validateTo,
    outDir,
    runTag,
    minTrades,
    minPf,
    maxRuns,
    allowHuge,
    continueOnError,
    dryRun,
    sort,
    quiet,
  };
}

function runSnapshots(
  from: string,
  to: string,
  step: number,
  options: {
    noSync: boolean;
    forceSyncAll: boolean;
    skipJudge: boolean;
    judgeModel?: string;
  },
  envOverride: Record<string, string>
): { ok: boolean; output: string; runId?: string; error?: string } {
  const args = [
    "run",
    "src/cli/backtest-snapshots.ts",
    "--",
    "--from",
    from,
    "--to",
    to,
    "--step",
    String(step),
    "--no-analyze",
    "--no-clear-trades",
  ];
  if (options.noSync) args.push("--no-sync");
  if (options.forceSyncAll) args.push("--force-sync-all");
  if (options.skipJudge) args.push("--skip-judge");
  if (options.judgeModel) {
    args.push("--judge-model", options.judgeModel);
  }

  const res = spawnSync("bun", args, {
    env: { ...process.env, ...envOverride } as NodeJS.ProcessEnv,
    encoding: "utf8",
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  if ((res.status ?? 1) !== 0) {
    return { ok: false, output: out, error: `exit code ${res.status}` };
  }
  const m = out.match(/runId:\s*"([^"]+)"/);
  if (!m?.[1]) {
    return { ok: false, output: out, error: "could not parse runId" };
  }
  return { ok: true, output: out, runId: m[1] };
}

async function loadStats(runId: string): Promise<BacktestRunStats> {
  const db = await getDb();
  const rows = await db
    .collection<TradeLogDoc>(collections.tradesBacktest)
    .find({ backtest_run_id: runId })
    .toArray();
  return summarizeTrades(rows);
}

function buildGrid(args: CliArgs): Record<string, string[]> {
  const presetGrids: Record<string, string[]>[] = [];
  for (const name of args.presetNames) {
    presetGrids.push(RESEARCH_PRESET_GRIDS[name]!);
  }
  const fromSet: Record<string, string[]> = {};
  for (const s of args.setPairs) {
    fromSet[s.key] = s.values;
  }
  if (args.presetNames.length === 0 && args.setPairs.length === 0) {
    return {};
  }
  return mergeGrids(...presetGrids, fromSet);
}

function sortValue(
  row: {
    train: BacktestRunStats;
    oos?: BacktestRunStats;
  },
  key: SortKey
): number {
  const t = row.train;
  const o = row.oos;
  if (key === "train-pf")
    return Number.isFinite(t.profitFactor) ? t.profitFactor : t.profitFactor > 0 ? 1e9 : 0;
  if (key === "oos-pf")
    return o
      ? Number.isFinite(o.profitFactor) ? o.profitFactor : o.profitFactor > 0 ? 1e9 : 0
      : -1e9;
  if (key === "train-pnl") return t.totalPnl;
  if (key === "oos-pnl") return o ? o.totalPnl : -1e18;
  if (key === "min-pf") {
    const a = t.profitFactor;
    const b = o?.profitFactor;
    const fa = Number.isFinite(a) ? a : 0;
    const fb = b !== undefined
      ? Number.isFinite(b) ? b : 0
      : fa;
    return o !== undefined ? Math.min(fa, fb) : fa;
  }
  if (key === "train-sharpe") return t.sharpeEstimate;
  return t.totalPnl;
}

function asFinitePf(pf: number): string {
  return Number.isFinite(pf) ? pf.toFixed(2) : "∞";
}

interface ResearchResultRow {
  runIndex: number;
  profile: string;
  envLine: string;
  env: Record<string, string>;
  trainFrom: string;
  trainTo: string;
  trainRunId: string;
  train: BacktestRunStats;
  validateFrom?: string;
  validateTo?: string;
  validateRunId?: string;
  oos?: BacktestRunStats;
  error?: string;
}

async function main(): Promise<void> {
  if (process.argv.slice(2).some((x) => x === "--help" || x === "-h")) {
    console.log(usage());
    return;
  }
  const args = parseArgs();
  if (
    args.presetNames.length === 0 &&
    args.setPairs.length === 0 &&
    args.profiles.length === 1 &&
    args.profiles[0] === null
  ) {
    throw new Error(
      "Nothing to research: add --profiles, and/or one or more --preset NAME, and/or --set KEY=val1,val2. Example: --preset quick"
    );
  }

  const grid = buildGrid(args);
  const combos = cartesianEnv(grid);
  const totalPlanned = args.profiles.length * combos.length;
  if (args.validateFrom) totalPlanned * 2; // eslint doesn't like; just inform user

  const oosMult = args.validateFrom ? 2 : 1;
  const runCount = args.profiles.length * combos.length * oosMult;
  if (runCount > args.maxRuns && !args.allowHuge) {
    throw new Error(
      `Research plan: ${args.profiles.length} profiles × ${combos.length} env combos${
        args.validateFrom ? " ×2 (OOS)" : ""
      } = ${runCount} backtest spawns, exceeds --max-runs ${args.maxRuns}. Use --max-runs or --allow-huge.`
    );
  }

  if (args.dryRun) {
    console.log(
      `[backtest-research] DRY-RUN: ${args.profiles.length} profiles × ${combos.length} env combos; ${args.validateFrom ? 2 : 1} backtest(s) per combo; total spawns: ${runCount}`
    );
    for (const p of args.profiles) {
      const label = p === null ? "default(.env)" : p;
      console.log(`  profile: ${label}`);
    }
    console.log("  first env combos (up to 5):");
    for (let j = 0; j < Math.min(5, combos.length); j++) {
      const line = formatEnvLine(combos[j]!);
      console.log(
        `    ${j + 1}. ${line || "(no extra keys — only your .env / --profiles bundle)"}`
      );
    }
    return;
  }

  await ensureIndexes();
  if (args.clearFirst) {
    const db = await getDb();
    const r = await db.collection(collections.tradesBacktest).deleteMany({});
    if (!args.quiet) {
      console.log(`[backtest-research] cleared trades_backtest: ${r.deletedCount}`);
    }
  } else {
    console.log(
      "[backtest-research] --no-clear-first: existing trades_backtest kept (other runs' rows still in DB)"
    );
  }

  const results: ResearchResultRow[] = [];
  let runIndex = 0;
  const totalCombos = args.profiles.length * combos.length;
  for (const profileKey of args.profiles) {
    const profLabel =
      profileKey === null ? "default" : profileKey;
    const profEnv: Record<string, string> =
      profileKey === null ? {} : { ...PROFILE_SPECS[profileKey]!.env };

    for (const combo of combos) {
      runIndex += 1;
      const envOverride: Record<string, string> = { ...profEnv, ...combo };
      const envLine = formatEnvLine({ ...profEnv, ...combo });
      if (!args.quiet) {
        console.log(
          `\n[backtest-research] --- ${runIndex}/${totalCombos} profile=${profLabel} ---`
        );
        console.log(`[backtest-research] env: ${envLine || "(no overlay)"}`);
      }

      const childOpts = {
        noSync: !args.sync,
        forceSyncAll: args.forceSyncAll,
        skipJudge: args.skipJudge,
        judgeModel: args.judgeModel,
      };

      const train = runSnapshots(
        args.from,
        args.to,
        args.step,
        childOpts,
        envOverride
      );
      if (!train.ok || !train.runId) {
        const err = train.error ?? "unknown";
        results.push({
          runIndex: runIndex,
          profile: profLabel,
          envLine,
          env: { ...combo },
          trainFrom: args.from,
          trainTo: args.to,
          trainRunId: "",
          train: summarizeTrades([]),
          error: err,
        });
        if (!args.continueOnError) throw new Error(err + "\n" + train.output);
        continue;
      }

      const trainId = train.runId;
      const trainStats = await loadStats(trainId);
      if (!args.quiet) {
        console.log(
          `[backtest-research] train runId=${trainId} trades=${trainStats.trades} PF=${asFinitePf(trainStats.profitFactor)} PnL=₹${trainStats.totalPnl.toFixed(0)}`
        );
      }

      let validateId: string | undefined;
      let oosStats: BacktestRunStats | undefined;
      if (args.validateFrom && args.validateTo) {
        const oos = runSnapshots(
          args.validateFrom,
          args.validateTo,
          args.step,
          childOpts,
          envOverride
        );
        if (!oos.ok || !oos.runId) {
          const err = oos.error ?? "OOS run failed";
          results.push({
            runIndex,
            profile: profLabel,
            envLine,
            env: { ...combo },
            trainFrom: args.from,
            trainTo: args.to,
            trainRunId: trainId,
            train: trainStats,
            validateFrom: args.validateFrom,
            validateTo: args.validateTo,
            error: err,
          });
          if (!args.continueOnError) throw new Error(err + "\n" + oos.output);
          continue;
        }
        validateId = oos.runId;
        oosStats = await loadStats(validateId);
        if (!args.quiet) {
          console.log(
            `[backtest-research] OOS runId=${validateId} trades=${oosStats.trades} PF=${asFinitePf(oosStats.profitFactor)} PnL=₹${oosStats.totalPnl.toFixed(0)}`
          );
        }
      }

      results.push({
        runIndex,
        profile: profLabel,
        envLine,
        env: { ...combo },
        trainFrom: args.from,
        trainTo: args.to,
        trainRunId: trainId,
        train: trainStats,
        validateFrom: args.validateFrom,
        validateTo: args.validateTo,
        validateRunId: validateId,
        oos: oosStats,
      });
    }
  }

  const passFilter = (r: ResearchResultRow) =>
    !r.error &&
    r.train.trades >= args.minTrades &&
    (() => {
      const pf = r.train.profitFactor;
      const f = Number.isFinite(pf) ? pf : 0;
      return f >= args.minPf;
    })();

  const sorted = [...results]
    .filter(passFilter)
    .sort(
      (a, b) =>
        sortValue(b, args.sort) - sortValue(a, args.sort)
    );

  if (!args.quiet) {
    console.log(
      "\n[backtest-research] RANKED (passes --min-trades and --min-pf on *train* segment)"
    );
    if (args.minTrades > 0 || args.minPf > 0) {
      console.log(
        `  filters: minTrades>=${args.minTrades} minPf>=${args.minPf} (train only)`
      );
    }
    for (const r of sorted.slice(0, 30)) {
      const o = r.oos;
      const oosP = o
        ? `OOS: PF=${asFinitePf(o.profitFactor)} n=${o.trades} ₹${o.totalPnl.toFixed(0)}`
        : "";
      console.log(
        `  #${r.runIndex} ${r.profile} | train PF=${asFinitePf(r.train.profitFactor)} n=${r.train.trades} ₹${r.train.totalPnl.toFixed(0)} | ${r.envLine} | ${r.trainRunId} ${oosP}`.trim()
      );
    }
    if (sorted.length > 30) {
      console.log(`  ... ${sorted.length - 30} more in JSON/CSV`);
    }
  }

  if (!existsSync(args.outDir)) {
    mkdirSync(args.outDir, { recursive: true });
  }
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const base = join(args.outDir, `${args.runTag}-${ts}`);
  const allRows = { meta: { args, grid, combos, sort: args.sort }, results };
  writeFileSync(base + ".json", JSON.stringify(allRows, null, 2), "utf8");

  const lines = [
    "runIndex,profile,envSummary,trainFrom,trainTo,trainRunId,trainTrades,trainPnl,trainPF,validateFrom,validateTo,validateRunId,oosTrades,oosPnl,oosPF,error",
  ];
  for (const r of results) {
    const o = r.oos;
    lines.push(
      [
        r.runIndex,
        r.profile,
        JSON.stringify(r.envLine),
        r.trainFrom,
        r.trainTo,
        r.trainRunId,
        r.train.trades,
        r.train.totalPnl.toFixed(2),
        asFinitePf(r.train.profitFactor),
        r.validateFrom ?? "",
        r.validateTo ?? "",
        r.validateRunId ?? "",
        o ? o.trades : "",
        o ? o.totalPnl.toFixed(2) : "",
        o ? asFinitePf(o.profitFactor) : "",
        r.error ?? "",
      ].join(",")
    );
  }
  writeFileSync(base + ".csv", lines.join("\n"), "utf8");
  if (!args.quiet) {
    console.log(`\n[backtest-research] wrote ${base}.json and ${base}.csv`);
  }
}

runCli(main);
