import { env } from "../config/env.js";

export interface SafetyState {
  dailyPnl: number;
  rolling3dPnl: number;
  weeklyPnl: number;
  consecutiveLosses: number;
  killSwitchTripped: boolean;
  killReason?: string;
}

export function createSafetyState(): SafetyState {
  return {
    dailyPnl: 0,
    rolling3dPnl: 0,
    weeklyPnl: 0,
    consecutiveLosses: 0,
    killSwitchTripped: false,
  };
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
  return evaluateSafety(state, openPositionCount).allowed;
}

export function evaluateSafety(
  state: SafetyState,
  openPositionCount: number
): { allowed: boolean; reasons: string[]; throttleMultiplier: number } {
  const reasons: string[] = [];
  if (state.killSwitchTripped) reasons.push(state.killReason ?? "Kill switch tripped");
  if (state.dailyPnl <= -env.dailyStopLoss) reasons.push("Daily loss limit reached");
  if (state.rolling3dPnl <= -env.rolling3dDrawdownLimit) {
    reasons.push("Rolling 3-session drawdown limit reached");
  }
  if (state.weeklyPnl <= -env.weeklyDrawdownLimit) {
    reasons.push("Weekly drawdown limit reached");
  }
  if (openPositionCount >= env.maxConcurrentTrades) {
    reasons.push("Max concurrent trades reached");
  }

  if (!state.killSwitchTripped && state.dailyPnl <= -env.dailyStopLoss) {
    killSwitch("Daily Loss Limit Reached", state);
  }

  const throttleMultiplier =
    state.consecutiveLosses >= env.consecutiveLossThrottle
      ? env.lossThrottleSizeMultiplier
      : 1;

  return {
    allowed: reasons.length === 0,
    reasons,
    throttleMultiplier,
  };
}
