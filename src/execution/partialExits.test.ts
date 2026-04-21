import { describe, expect, test } from "bun:test";
import {
  partialTargetHit,
  partialTargetPrice,
  plannedPartialQty,
  pnlForExit,
} from "./partialExits.js";

describe("partial exit helpers", () => {
  test("computes long and short target prices", () => {
    expect(partialTargetPrice("BUY", 100, 2, 1)).toBe(102);
    expect(partialTargetPrice("SELL", 100, 2, 1)).toBe(98);
  });

  test("leaves at least one share for the runner", () => {
    expect(plannedPartialQty(10, 10, 0.33)).toBe(3);
    expect(plannedPartialQty(3, 1, 0.33)).toBe(0);
    expect(plannedPartialQty(2, 2, 0.33)).toBe(0);
  });

  test("detects targets and computes side-aware pnl", () => {
    expect(partialTargetHit("BUY", 103, 99, 102)).toBe(true);
    expect(partialTargetHit("SELL", 103, 97, 98)).toBe(true);
    expect(pnlForExit("BUY", 100, 102, 3).pnl).toBe(6);
    expect(pnlForExit("SELL", 100, 98, 3).pnl).toBe(6);
  });
});
