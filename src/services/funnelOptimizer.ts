import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DateTime } from "luxon";
import { env } from "../config/env.js";
import {
  fetchFunnelTuningState,
  fetchTradesInRange,
  insertFunnelOptimizerReport,
  upsertFunnelTuningState,
} from "../db/repositories.js";
import type { TradeLogDoc } from "../types/domain.js";
import { IST, nowIST } from "../time/ist.js";

export interface FunnelSummary {
  total: number;
  executed: number;
  nonExecuted: number;
  executionRate: number;
  riskVeto: number;
  cooldownJudge: number;
  cooldownRiskVeto: number;
  judgeDenyOrOther: number;
  dominantBlocker?: "risk_veto" | "cooldown_judge" | "cooldown_risk_veto" | "judge_deny_or_other";
  dominantBlockerShare: number;
  topRiskReason?: string;
}

export interface EnvTuneChange {
  key: string;
  from: string;
  to: string;
  reason: string;
}

export interface FunnelRecommendation {
  id: string;
  reason: string;
  changes: EnvTuneChange[];
}

export interface FunnelOptimizerResult {
  lookbackDays: number;
  from: Date;
  to: Date;
  summary: FunnelSummary;
  recommendation?: FunnelRecommendation;
  applied: boolean;
  applyReason?: string;
}

function weekKey(dt = nowIST()): string {
  return `${dt.weekYear}-W${String(dt.weekNumber).padStart(2, "0")}`;
}

function classifyRiskReason(raw: string): string {
  const r = raw.toLowerCase();
  if (r.includes("same-side")) return "same_side";
  if (r.includes("sector")) return "sector";
  if (r.includes("correlation")) return "correlation";
  if (
    r.includes("gross exposure") ||
    r.includes("beta exposure") ||
    r.includes("exposure headroom")
  ) {
    return "exposure";
  }
  if (r.includes("outside") || r.includes("no fresh entries")) return "time_window";
  if (r.includes("nifty") || r.includes("breadth")) return "market";
  if (r.includes("drawdown") || r.includes("daily loss") || r.includes("kill switch")) {
    return "drawdown";
  }
  return "other";
}

function parseHHMM(hhmm: string): number {
  const [h, m] = hhmm.split(":").map((x) => Number(x));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return h * 60 + m;
}

function fmtHHMM(minute: number): string {
  const m = Math.max(0, Math.min(23 * 60 + 59, minute));
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function summarizeTradesForOptimizer(trades: TradeLogDoc[]): FunnelSummary {
  let executed = 0;
  let riskVeto = 0;
  let cooldownJudge = 0;
  let cooldownRiskVeto = 0;
  let judgeDenyOrOther = 0;
  const riskReasonCounts = new Map<string, number>();

  for (const t of trades) {
    if (t.order_executed === true) {
      executed += 1;
      continue;
    }
    const reason = t.ai_reasoning ?? "";
    if (reason.startsWith("RISK_VETO:")) {
      riskVeto += 1;
      const tail = reason.slice("RISK_VETO:".length).trim();
      for (const part of tail.split(";").map((x) => x.trim()).filter(Boolean)) {
        const key = classifyRiskReason(part);
        riskReasonCounts.set(key, (riskReasonCounts.get(key) ?? 0) + 1);
      }
      continue;
    }
    if (reason.startsWith("COOLDOWN_JUDGE:")) {
      cooldownJudge += 1;
      continue;
    }
    if (reason.startsWith("COOLDOWN_RISK_VETO:")) {
      cooldownRiskVeto += 1;
      continue;
    }
    judgeDenyOrOther += 1;
  }

  const total = trades.length;
  const nonExecuted = Math.max(0, total - executed);
  const blockers: Array<
    ["risk_veto" | "cooldown_judge" | "cooldown_risk_veto" | "judge_deny_or_other", number]
  > = [
    ["risk_veto", riskVeto],
    ["cooldown_judge", cooldownJudge],
    ["cooldown_risk_veto", cooldownRiskVeto],
    ["judge_deny_or_other", judgeDenyOrOther],
  ];
  const dominant = [...blockers].sort((a, b) => b[1] - a[1])[0];
  const dominantBlocker = dominant?.[1]
    ? (dominant[0] as FunnelSummary["dominantBlocker"])
    : undefined;
  const dominantShare = nonExecuted > 0 && dominant ? dominant[1] / nonExecuted : 0;
  const topRiskReason = [...riskReasonCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  return {
    total,
    executed,
    nonExecuted,
    executionRate: total > 0 ? executed / total : 0,
    riskVeto,
    cooldownJudge,
    cooldownRiskVeto,
    judgeDenyOrOther,
    dominantBlocker,
    dominantBlockerShare: dominantShare,
    topRiskReason,
  };
}

export function buildFunnelRecommendation(
  summary: FunnelSummary
): FunnelRecommendation | undefined {
  if (summary.total < Math.max(1, env.funnelOptimizerMinDecisions)) return undefined;
  if (!summary.dominantBlocker) return undefined;
  if (summary.dominantBlockerShare < env.funnelOptimizerDominancePct) return undefined;

  if (summary.dominantBlocker === "cooldown_judge") {
    if (env.adaptiveJudgeCooldownEnabled) {
      const from = env.adaptiveJudgeCooldownMaxMs;
      const to = Math.round(
        clamp(from * 0.85, env.adaptiveJudgeCooldownMinMs + 30_000, from)
      );
      if (to === from) return undefined;
      return {
        id: "cooldown-judge-max-reduce",
        reason:
          "Judge cooldown dominates non-executed flow; reduce adaptive upper bound for faster retries.",
        changes: [
          {
            key: "ADAPTIVE_JUDGE_COOLDOWN_MAX_MS",
            from: String(from),
            to: String(to),
            reason: "Reduce cooldown bottleneck while keeping lower bound unchanged.",
          },
        ],
      };
    }
    const from = env.judgeCooldownMs;
    const to = Math.round(clamp(from * 0.85, 60_000, from));
    if (to === from) return undefined;
    return {
      id: "cooldown-judge-fixed-reduce",
      reason: "Fixed judge cooldown dominates flow; reduce wait to increase retry throughput.",
      changes: [
        {
          key: "JUDGE_COOLDOWN_MS",
          from: String(from),
          to: String(to),
          reason: "Lower fixed judge cooldown.",
        },
      ],
    };
  }

  if (summary.dominantBlocker === "cooldown_risk_veto") {
    const from = env.riskVetoRetryCooldownMs;
    const to = Math.round(clamp(from * 0.8, 20_000, from));
    if (to === from) return undefined;
    return {
      id: "cooldown-risk-veto-reduce",
      reason: "Risk-veto cooldown dominates retries; reduce cooldown to re-check improved context sooner.",
      changes: [
        {
          key: "RISK_VETO_RETRY_COOLDOWN_MS",
          from: String(from),
          to: String(to),
          reason: "Shorten retry lock after veto.",
        },
      ],
    };
  }

  if (summary.dominantBlocker === "risk_veto") {
    const top = summary.topRiskReason;
    if (top === "same_side") {
      const from = env.softSameSideOverflowSizeMultiplier;
      const to = Number(clamp(from + 0.05, from, 0.9).toFixed(2));
      if (to === from) return undefined;
      return {
        id: "risk-soft-same-side",
        reason:
          "Same-side crowding is the dominant veto reason; lighten soft penalty before touching hard caps.",
        changes: [
          {
            key: "SOFT_SAME_SIDE_OVERFLOW_SIZE_MULTIPLIER",
            from: String(from),
            to: String(to),
            reason: "Allow slightly larger reduced-size entries under crowding.",
          },
        ],
      };
    }
    if (top === "sector") {
      const from = env.softSectorOverflowSizeMultiplier;
      const to = Number(clamp(from + 0.05, from, 0.9).toFixed(2));
      if (to === from) return undefined;
      return {
        id: "risk-soft-sector",
        reason:
          "Sector crowding dominates vetoes; lighten sector soft-throttle before increasing hard sector caps.",
        changes: [
          {
            key: "SOFT_SECTOR_OVERFLOW_SIZE_MULTIPLIER",
            from: String(from),
            to: String(to),
            reason: "Permit slightly larger reduced-size entries in crowded sectors.",
          },
        ],
      };
    }
    if (top === "correlation") {
      const from = env.softCorrelationMinSizeMultiplier;
      const to = Number(clamp(from + 0.05, from, 0.8).toFixed(2));
      if (to === from) return undefined;
      return {
        id: "risk-soft-correlation",
        reason:
          "Correlation vetoes dominate; increase minimum size multiplier in soft-correlation band.",
        changes: [
          {
            key: "SOFT_CORRELATION_MIN_SIZE_MULTIPLIER",
            from: String(from),
            to: String(to),
            reason: "Reduce aggressiveness of correlation soft-throttle.",
          },
        ],
      };
    }
    if (top === "time_window") {
      const fromFresh = env.noFreshEntriesAfter;
      const toFresh = fmtHHMM(
        Math.min(parseHHMM(fromFresh) + 15, parseHHMM("15:00"))
      );
      if (toFresh === fromFresh) return undefined;
      return {
        id: "risk-time-window-relax",
        reason:
          "Time-window vetoes dominate; extend no-fresh-entry cutoff by 15 minutes.",
        changes: [
          {
            key: "NO_FRESH_ENTRIES_AFTER",
            from: fromFresh,
            to: toFresh,
            reason: "Widen late-entry window slightly.",
          },
        ],
      };
    }
  }

  if (summary.dominantBlocker === "judge_deny_or_other") {
    const from = env.sessionOpenConfidenceFloor;
    const to = Number(clamp(from - 0.02, 0.55, from).toFixed(2));
    if (to === from) return undefined;
    return {
      id: "confidence-floor-open-soften",
      reason:
        "Judge/other denials dominate; slightly soften open-session confidence floor to recover throughput.",
      changes: [
        {
          key: "SESSION_OPEN_CONFIDENCE_FLOOR",
          from: String(from),
          to: String(to),
          reason: "Reduce strictness slightly while retaining time-block policy.",
        },
      ],
    };
  }

  return undefined;
}

function applyEnvChanges(path: string, changes: EnvTuneChange[]): void {
  const abs = resolve(path);
  const original = readFileSync(abs, "utf8");
  const lines = original.split("\n");

  const indices = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Z0-9_]+)=/.exec(lines[i] ?? "");
    if (!m) continue;
    indices.set(m[1]!, i);
  }

  for (const c of changes) {
    const idx = indices.get(c.key);
    const nextLine = `${c.key}=${c.to}`;
    if (idx === undefined) {
      lines.push(nextLine);
      continue;
    }
    lines[idx] = nextLine;
  }

  writeFileSync(abs, lines.join("\n"));
}

export async function runFunnelOptimizer(options?: {
  lookbackDays?: number;
  apply?: boolean;
  envPath?: string;
  executionEnv?: TradeLogDoc["env"];
  ignoreWeeklyCap?: boolean;
}): Promise<FunnelOptimizerResult> {
  const days = Math.max(1, options?.lookbackDays ?? env.funnelOptimizerLookbackDays);
  const to = nowIST().toJSDate();
  const from = nowIST().minus({ days }).toJSDate();
  const executionEnv = options?.executionEnv ?? env.executionEnv;
  const trades = await fetchTradesInRange(from, to, executionEnv);
  const summary = summarizeTradesForOptimizer(trades);
  const recommendation = buildFunnelRecommendation(summary);

  let applied = false;
  let applyReason: string | undefined;
  if (options?.apply && recommendation && recommendation.changes.length > 0) {
    const wk = weekKey();
    const state = await fetchFunnelTuningState();
    const sameWeek = state?.week_key === wk;
    const appliedCount = sameWeek ? state?.applied_count ?? 0 : 0;
    const limit = Math.max(0, env.funnelOptimizerMaxChangesPerWeek);
    if (!options?.ignoreWeeklyCap && appliedCount >= limit) {
      applyReason = `weekly cap reached (${appliedCount}/${limit})`;
    } else {
      applyEnvChanges(options?.envPath ?? ".env", recommendation.changes);
      await upsertFunnelTuningState({
        week_key: wk,
        applied_count: appliedCount + 1,
        last_applied_at: new Date(),
        last_action: recommendation.id,
      });
      applied = true;
      applyReason = `applied ${recommendation.changes.length} change(s)`;
    }
  }

  await insertFunnelOptimizerReport({
    generated_at: new Date(),
    lookback_days: days,
    from,
    to,
    total: summary.total,
    executed: summary.executed,
    execution_rate: summary.executionRate,
    dominant_blocker: summary.dominantBlocker,
    blocker_share: summary.dominantBlockerShare,
    recommendation: recommendation?.reason,
    changes: recommendation?.changes.map((c) => ({
      key: c.key,
      from: c.from,
      to: c.to,
    })),
  });

  return {
    lookbackDays: days,
    from,
    to,
    summary,
    recommendation,
    applied,
    applyReason,
  };
}
