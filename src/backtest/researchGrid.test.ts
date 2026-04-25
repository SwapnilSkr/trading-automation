import { describe, expect, test } from "bun:test";
import { cartesianEnv, mergeGrids, parseCommaValues } from "./researchGrid.js";

describe("parseCommaValues", () => {
  test("splits and trims", () => {
    expect(parseCommaValues("1, 2,3")).toEqual(["1", "2", "3"]);
  });
  test("empty", () => {
    expect(parseCommaValues("  ,  ")).toEqual([]);
  });
});

describe("mergeGrids", () => {
  test("later overrides key", () => {
    const m = mergeGrids(
      { A: ["1"] },
      { A: ["2", "3"] }
    );
    expect(m).toEqual({ A: ["2", "3"] });
  });
});

describe("cartesianEnv", () => {
  test("empty", () => {
    expect(cartesianEnv({})).toEqual([{}]);
  });
  test("two by two", () => {
    const c = cartesianEnv({
      A: ["1", "2"],
      B: ["x", "y"],
    });
    expect(c).toEqual([
      { A: "1", B: "x" },
      { A: "1", B: "y" },
      { A: "2", B: "x" },
      { A: "2", B: "y" },
    ]);
  });
  test("skips empty value arrays for keys", () => {
    const c = cartesianEnv({ A: ["1"], B: [] });
    expect(c).toEqual([{ A: "1" }]);
  });
});
