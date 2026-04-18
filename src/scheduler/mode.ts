import { DateTime } from "luxon";
import { IST, isIndianWeekday, nowIST } from "../time/ist.js";

export type RunMode =
  | "INIT"
  | "OBSERVATION"
  | "EXECUTION"
  | "SQUARE_OFF"
  | "SYNC"
  | "POST_MORTEM"
  | "IDLE";

function minutesSinceMidnight(dt: DateTime): number {
  return dt.hour * 60 + dt.minute;
}

/**
 * Maps current IST clock to coarse regime (see Alpha Architect schedule).
 */
export function currentRunMode(now: DateTime = nowIST()): RunMode {
  if (!isIndianWeekday(now)) {
    return "IDLE";
  }

  const m = minutesSinceMidnight(now);

  if (m < 9 * 60) return "IDLE";
  if (m < 9 * 60 + 15) return "INIT";
  if (m < 9 * 60 + 30) return "OBSERVATION";
  if (m < 15 * 60 + 15) return "EXECUTION";
  if (m < 15 * 60 + 30) return "SQUARE_OFF";
  if (m < 15 * 60 + 45) return "IDLE";
  if (m < 17 * 60) return "SYNC";
  if (m < 18 * 60) return "IDLE";
  if (m < 21 * 60) return "POST_MORTEM";
  return "IDLE";
}

export function describeMode(mode: RunMode): string {
  return `${mode} @ ${DateTime.now().setZone(IST).toFormat("HH:mm:ss")} IST`;
}
