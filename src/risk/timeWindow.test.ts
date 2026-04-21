import { describe, expect, test } from "bun:test";
import { evaluateTimeWindow } from "./timeWindow.js";

describe("strategy time windows", () => {
  test("allows ORB entries inside the default ORB window", () => {
    const at = new Date("2026-04-21T04:30:00.000Z"); // 10:00 IST
    expect(evaluateTimeWindow("ORB_15M", at).allowed).toBe(true);
  });

  test("blocks fresh entries after the no-fresh-entry cutoff", () => {
    const at = new Date("2026-04-21T09:01:00.000Z"); // 14:31 IST
    const ev = evaluateTimeWindow("OPEN_DRIVE_PULLBACK", at);
    expect(ev.allowed).toBe(false);
    expect(ev.reasons.some((r) => r.includes("no fresh entries"))).toBe(true);
  });
});
