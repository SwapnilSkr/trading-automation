import { DateTime } from "luxon";
import { env } from "../config/env.js";
import type { StrategyId } from "../types/domain.js";
import { IST } from "../time/ist.js";

export interface TimeWindowEval {
  allowed: boolean;
  reasons: string[];
  window: string;
}

function parseMinute(hhmm: string): number {
  const [h, m] = hhmm.split(":").map((x) => Number(x));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return h * 60 + m;
}

function minuteOf(date: Date): number {
  const dt = DateTime.fromJSDate(date, { zone: IST });
  return dt.hour * 60 + dt.minute;
}

function windowFor(strategy: StrategyId): { start: string; end: string; label: string } {
  if (
    strategy === "ORB_15M" ||
    strategy === "ORB_RETEST_15M" ||
    strategy === "INITIAL_BALANCE_BREAK_RETEST" ||
    strategy === "ORB_FAKEOUT_REVERSAL" ||
    strategy === "INDEX_LAGGARD_CATCHUP"
  ) {
    return { start: env.orbEntryStart, end: env.orbEntryEnd, label: "ORB" };
  }
  if (
    strategy === "VWAP_RECLAIM_REJECT" ||
    strategy === "VWAP_PULLBACK_TREND" ||
    strategy === "VWAP_RECLAIM_CONTINUATION" ||
    strategy === "EMA20_BREAK_RETEST"
  ) {
    return { start: env.vwapEntryStart, end: env.vwapEntryEnd, label: "VWAP/EMA" };
  }
  if (strategy === "MEAN_REV_Z") {
    return { start: env.meanRevEntryStart, end: env.meanRevEntryEnd, label: "MEAN_REV" };
  }
  return { start: env.defaultEntryStart, end: env.defaultEntryEnd, label: "DEFAULT" };
}

export function evaluateTimeWindow(strategy: StrategyId, at: Date): TimeWindowEval {
  if (!env.timeWindowsEnabled) {
    return { allowed: true, reasons: [], window: "disabled" };
  }

  const nowMin = minuteOf(at);
  const noFreshAfter = parseMinute(env.noFreshEntriesAfter);
  const w = windowFor(strategy);
  const start = parseMinute(w.start);
  const end = Math.min(parseMinute(w.end), noFreshAfter);
  const reasons: string[] = [];

  if (nowMin < start || nowMin > end) {
    reasons.push(`${strategy} outside ${w.label} window ${w.start}-${w.end}`);
  }
  if (nowMin > noFreshAfter) {
    reasons.push(`no fresh entries after ${env.noFreshEntriesAfter}`);
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    window: `${w.label}:${w.start}-${w.end}`,
  };
}
