import { env } from "../config/env.js";

export interface SafetyState {
  dailyPnl: number;
  killSwitchTripped: boolean;
  killReason?: string;
}

export function createSafetyState(): SafetyState {
  return { dailyPnl: 0, killSwitchTripped: false };
}

export function killSwitch(reason: string, state: SafetyState): void {
  state.killSwitchTripped = true;
  state.killReason = reason;
  console.error("[KILL SWITCH]", reason);
}

export function checkSafety(
  state: SafetyState,
  openPositionCount: number
): boolean {
  if (state.killSwitchTripped) return false;
  if (state.dailyPnl <= -env.dailyStopLoss) {
    killSwitch("Daily Loss Limit Reached", state);
    return false;
  }
  if (openPositionCount >= env.maxConcurrentTrades) return false;
  return true;
}
