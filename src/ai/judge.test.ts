import { describe, expect, test } from "bun:test";
import { parseJudgeText } from "./judge.js";

describe("parseJudgeText", () => {
  test("plain JSON object", () => {
    const r = parseJudgeText(
      '{"approve":true,"confidence":0.72,"reasoning":"ok"}'
    );
    expect(r.approve).toBe(true);
    expect(r.confidence).toBeCloseTo(0.72);
    expect(r.reasoning).toBe("ok");
  });

  test("JSON value is a string holding the object (glm-style double encoding)", () => {
    const wrapped = JSON.stringify(
      '{"approve":false,"confidence":0.52,"reasoning":"ORB fakeout reversal"}'
    );
    const r = parseJudgeText(wrapped);
    expect(r.approve).toBe(false);
    expect(r.confidence).toBeCloseTo(0.52);
    expect(r.reasoning).toBe("ORB fakeout reversal");
  });

  test("leading quote + spaced inner JSON (as seen in some provider payloads)", () => {
    const r = parseJudgeText(
      '"{ \\"approve\\":false, \\"confidence\\":0.52, \\"reasoning\\":\\"x\\" }"'
    );
    expect(r.approve).toBe(false);
    expect(r.confidence).toBeCloseTo(0.52);
    expect(r.reasoning).toBe("x");
  });

  test("markdown fence", () => {
    const r = parseJudgeText(
      '```json\n{"approve":true,"confidence":0.1,"reasoning":"fenced"}\n```'
    );
    expect(r.approve).toBe(true);
    expect(r.confidence).toBeCloseTo(0.1);
    expect(r.reasoning).toBe("fenced");
  });

  test("trailing comma in object", () => {
    const r = parseJudgeText(
      '{"approve":true,"confidence":0.8,"reasoning":"t",}'
    );
    expect(r.confidence).toBeCloseTo(0.8);
    expect(r.reasoning).toBe("t");
  });

  test("confidence 0-100 scale", () => {
    const r = parseJudgeText(
      '{"approve":true,"confidence":65,"reasoning":"pct"}'
    );
    expect(r.confidence).toBeCloseTo(0.65);
  });
});
