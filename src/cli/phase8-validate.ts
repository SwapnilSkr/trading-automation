import "dotenv/config";
import { DateTime } from "luxon";
import { env } from "../config/env.js";
import { runCli } from "./runCli.js";
import { buildPhase8ValidationReport } from "../services/phase8Validation.js";
import { IST } from "../time/ist.js";

function parseArgs(): {
  days?: number;
  envMode?: "PAPER" | "LIVE";
  runId?: string;
  noLatestRun: boolean;
} {
  const args = process.argv.slice(2);
  let days: number | undefined;
  let envMode: "PAPER" | "LIVE" | undefined;
  let runId: string | undefined;
  let noLatestRun = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--days" && args[i + 1]) {
      const n = Number(args[++i]!);
      if (Number.isFinite(n) && n > 0) days = Math.floor(n);
      continue;
    }
    if (a === "--env" && args[i + 1]) {
      const v = args[++i]!.toUpperCase();
      if (v === "PAPER" || v === "LIVE") envMode = v;
      continue;
    }
    if (a === "--run-id" && args[i + 1]) {
      runId = args[++i]!;
      continue;
    }
    if (a === "--no-latest-run") noLatestRun = true;
  }
  return { days, envMode, runId, noLatestRun };
}

function mark(ok: boolean): string {
  return ok ? "PASS" : "FAIL";
}

async function main(): Promise<void> {
  const args = parseArgs();
  const r = await buildPhase8ValidationReport({
    lookbackDays: args.days,
    executionEnv: args.envMode ?? env.executionEnv,
    backtestRunId: args.runId,
    useLatestBacktestRun: !args.noLatestRun,
  });
  const from = DateTime.fromJSDate(r.from, { zone: IST }).toFormat("yyyy-MM-dd");
  const to = DateTime.fromJSDate(r.to, { zone: IST }).toFormat("yyyy-MM-dd HH:mm");

  console.log(
    `\n[phase8-validate] env=${r.executionEnv} lookback=${r.lookbackDays}d range=${from}..${to}`
  );
  if (r.backtestRunId) console.log(`  replay run: ${r.backtestRunId}`);
  const k = r.kpis;
  const t = r.targets;
  const c = r.checks;
  console.log("\n  KPIs");
  console.log(
    `  decisions=${k.decisions} executed=${k.executed} exec_rate=${(k.executionRate * 100).toFixed(2)}%`
  );
  console.log(
    `  active_days=${k.activeDays} losing_days=${k.losingDays} losing_day_pct=${(k.losingDayPct * 100).toFixed(2)}%`
  );
  console.log(`  worst_daily_loss=₹${k.worstDailyLoss.toFixed(0)}`);
  console.log(
    `  replay_trades=${k.replayTrades} replay_pf=${Number.isFinite(k.replayProfitFactor) ? k.replayProfitFactor.toFixed(2) : "∞"}`
  );

  console.log("\n  Targets");
  console.log(
    `  exec_rate: ${(t.execRateMin * 100).toFixed(1)}%..${(t.execRateMax * 100).toFixed(1)}% [${mark(c.execRateOk)}]`
  );
  console.log(
    `  losing_day_pct <= ${(t.losingDayPctMax * 100).toFixed(1)}% [${mark(c.losingDayPctOk)}]`
  );
  console.log(`  replay_pf >= ${t.replayPfMin.toFixed(2)} [${mark(c.replayPfOk)}]`);
  console.log(`  worst_daily_loss <= ₹${t.maxDailyLoss.toFixed(0)} [${mark(c.maxDailyLossOk)}]`);

  console.log(`\n  OVERALL: ${r.pass ? "PASS" : "FAIL"}`);
}

await runCli(main);
