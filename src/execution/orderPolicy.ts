import { env } from "../config/env.js";

/**
 * Engine-level entry order parameters (LIVE: real SmartAPI; PAPER: same policy, broker may no-op).
 * When `EXECUTE_LIMIT_ORDERS` is false, only `orderTag` is set (market orders).
 */
export function buildEntryOrderParams(args: {
  ticker: string;
  side: "BUY" | "SELL";
  strategy: string;
  entryPrice: number;
  lastLtp?: number;
}): {
  orderKind?: "MARKET" | "LIMIT" | "SL" | "SL-M";
  limitPrice?: number;
  orderTag?: string;
  lastLtpHint?: number;
} {
  const tagBase = `${args.strategy}-${args.ticker}`
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 20);
  const orderTag = tagBase || `E-${args.ticker}`.slice(0, 20);
  if (!env.executeLimitOrders) {
    return { orderTag, lastLtpHint: args.lastLtp };
  }
  const ref = args.lastLtp ?? args.entryPrice;
  const off = env.aggressiveLimitTickOffset;
  const limitPrice = Math.round((args.side === "BUY" ? ref + off : ref - off) * 100) / 100;
  return {
    orderKind: "LIMIT",
    limitPrice,
    orderTag,
    lastLtpHint: args.lastLtp,
  };
}
