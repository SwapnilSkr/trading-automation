import { describe, expect, test } from "bun:test";
import { evaluateSessionPolicy } from "./sessionPolicy.js";

describe("session policy", () => {
  test("applies open strict policy near market open", () => {
    const at = new Date("2026-04-21T04:15:00.000Z"); // 09:45 IST
    const ev = evaluateSessionPolicy(at);
    expect(ev.phase).toBe("OPEN_STRICT");
    expect(ev.size_multiplier).toBeLessThan(1);
    expect(ev.confidence_floor).toBeGreaterThan(0.5);
  });

  test("applies late policy after 13:30 IST", () => {
    const at = new Date("2026-04-21T08:30:00.000Z"); // 14:00 IST
    const ev = evaluateSessionPolicy(at);
    expect(ev.phase).toBe("LATE");
    expect(ev.size_multiplier).toBeLessThanOrEqual(1);
  });
});
