import { DateTime } from "luxon";
import { env } from "../config/env.js";
import { IST } from "../time/ist.js";

export interface SessionPolicyEval {
  phase: "OPEN_STRICT" | "MIDDAY" | "LATE" | "OFF_HOURS";
  size_multiplier: number;
  confidence_floor: number;
  reasons: string[];
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

export function evaluateSessionPolicy(at: Date): SessionPolicyEval {
  if (!env.sessionPolicyEnabled) {
    return {
      phase: "MIDDAY",
      size_multiplier: 1,
      confidence_floor: 0,
      reasons: [],
    };
  }

  const nowMin = minuteOf(at);
  const reasons: string[] = [];

  const openStart = parseMinute(env.sessionOpenStrictStart);
  const openEnd = parseMinute(env.sessionOpenStrictEnd);
  if (nowMin >= openStart && nowMin <= openEnd) {
    reasons.push(
      `open strict ${env.sessionOpenStrictStart}-${env.sessionOpenStrictEnd}`
    );
    return {
      phase: "OPEN_STRICT",
      size_multiplier: env.sessionOpenSizeMultiplier,
      confidence_floor: env.sessionOpenConfidenceFloor,
      reasons,
    };
  }

  const midStart = parseMinute(env.sessionMidStart);
  const midEnd = parseMinute(env.sessionMidEnd);
  if (nowMin >= midStart && nowMin <= midEnd) {
    return {
      phase: "MIDDAY",
      size_multiplier: env.sessionMidSizeMultiplier,
      confidence_floor: env.sessionMidConfidenceFloor,
      reasons,
    };
  }

  const lateStart = parseMinute(env.sessionLateStart);
  const lateEnd = parseMinute(env.sessionLateEnd);
  if (nowMin >= lateStart && nowMin <= lateEnd) {
    reasons.push(`late session ${env.sessionLateStart}-${env.sessionLateEnd}`);
    if (nowMin >= parseMinute(env.sessionLowConvictionBlockAfter)) {
      reasons.push(
        `low-conviction blocked after ${env.sessionLowConvictionBlockAfter}`
      );
      return {
        phase: "LATE",
        size_multiplier: env.sessionLateSizeMultiplier,
        confidence_floor: Math.max(
          env.sessionLateConfidenceFloor,
          env.sessionLowConvictionMinConfidence
        ),
        reasons,
      };
    }
    return {
      phase: "LATE",
      size_multiplier: env.sessionLateSizeMultiplier,
      confidence_floor: env.sessionLateConfidenceFloor,
      reasons,
    };
  }

  return {
    phase: "OFF_HOURS",
    size_multiplier: 1,
    confidence_floor: 0,
    reasons,
  };
}
