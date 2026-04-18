import { DateTime } from "luxon";
import {
  IST,
  isIndianWeekday,
  minutesSinceMidnightIST,
  nowIST,
} from "../time/ist.js";

export type RunMode =
  | "INIT"
  | "OBSERVATION"
  | "EXECUTION"
  | "SQUARE_OFF"
  | "SYNC"
  | "POST_MORTEM"
  | "IDLE";

/**
 * Maps current IST clock to coarse regime (see Alpha Architect schedule).
 */
export function currentRunMode(now: DateTime = nowIST()): RunMode {
  if (!isIndianWeekday(now)) {
    return "IDLE";
  }

  const m = minutesSinceMidnightIST(now);

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
  return `${mode} @ ${nowIST().toFormat("HH:mm:ss")} IST`;
}
