import "dotenv/config";
import { DateTime } from "luxon";
import { env } from "../config/env.js";
import { ensureIndexes } from "../db/repositories.js";
import { runFunnelOptimizer } from "../services/funnelOptimizer.js";
import { IST } from "../time/ist.js";
import { runCli } from "./runCli.js";

function parseArgs(): {
  days?: number;
  apply: boolean;
  force: boolean;
} {
  const args = process.argv.slice(2);
  let days: number | undefined;
  let apply = false;
  let force = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--days" && args[i + 1]) {
      const n = Number(args[++i]);
      if (Number.isFinite(n) && n > 0) days = Math.floor(n);
      continue;
    }
    if (a === "--apply") apply = true;
    if (a === "--force") force = true;
  }
  return { days, apply, force };
}

async function main(): Promise<void> {
  const args = parseArgs();
  await ensureIndexes();
  const r = await runFunnelOptimizer({
    lookbackDays: args.days,
    apply: args.apply,
    ignoreWeeklyCap: args.force,
    executionEnv: env.executionEnv,
  });
  const from = DateTime.fromJSDate(r.from, { zone: IST }).toFormat("yyyy-MM-dd");
  const to = DateTime.fromJSDate(r.to, { zone: IST }).toFormat("yyyy-MM-dd HH:mm");
  const s = r.summary;
  console.log(
    `\n[funnel-optimize] range=${from}..${to} lookback=${r.lookbackDays}d env=${env.executionEnv}`
  );
  console.log(
    `  decisions=${s.total} executed=${s.executed} non_executed=${s.nonExecuted} exec_rate=${(s.executionRate * 100).toFixed(2)}%`
  );
  console.log(
    `  blockers: risk_veto=${s.riskVeto} cooldown_judge=${s.cooldownJudge} cooldown_risk=${s.cooldownRiskVeto} deny_other=${s.judgeDenyOrOther}`
  );
  if (s.dominantBlocker) {
    console.log(
      `  dominant: ${s.dominantBlocker} (${(s.dominantBlockerShare * 100).toFixed(1)}%)`
    );
    if (s.topRiskReason) console.log(`  top risk reason: ${s.topRiskReason}`);
  }
  if (!r.recommendation) {
    console.log("  recommendation: none (insufficient dominance or sample)");
    return;
  }
  console.log(`\n  recommendation: ${r.recommendation.reason}`);
  for (const c of r.recommendation.changes) {
    console.log(`    - ${c.key}: ${c.from} -> ${c.to} (${c.reason})`);
  }
  if (args.apply) {
    console.log(`\n  apply: ${r.applied ? "YES" : "NO"} (${r.applyReason ?? "n/a"})`);
    if (r.applied) {
      console.log("  note: restart daemon to load updated .env values.");
    }
  }
}

await runCli(main);
