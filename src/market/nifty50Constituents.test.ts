import { describe, expect, test } from "bun:test";
import { parseNseIndexListCsv } from "./nifty50Constituents.js";

describe("parseNseIndexListCsv", () => {
  test("reads Symbol column from NSE index list", () => {
    const text = `Company,Industry,Symbol,Series,ISIN
X Ltd.,A,RELIANCE,EQ,INE
Y Ltd.,B,HDFCBANK,EQ,INE`;
    expect(parseNseIndexListCsv(text)).toEqual(["RELIANCE", "HDFCBANK"]);
  });
});
