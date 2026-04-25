import { env } from "../config/env.js";
import type { BrokerClient, MarketQuoteFullRow } from "../broker/types.js";

let lastRunAtMs = 0;
let lastSnapshot: {
  at: number;
  circuitProximityBlock: boolean;
  circuitProximityReasons: string[];
} = {
  at: 0,
  circuitProximityBlock: false,
  circuitProximityReasons: [],
};

function circuitDistancePct(
  ltp: number | undefined,
  upper: number | undefined,
  lower: number | undefined
): { nearUpper: boolean; nearLower: boolean; label: string } | null {
  if (ltp === undefined || ltp <= 0) return null;
  if (upper !== undefined && upper > 0) {
    const d = ((upper - ltp) / upper) * 100;
    if (d >= 0 && d < env.circuitProximityVetoPct) {
      return { nearUpper: true, nearLower: false, label: `near UCL ${d.toFixed(2)}%` };
    }
  }
  if (lower !== undefined && lower > 0) {
    const d = ((ltp - lower) / lower) * 100;
    if (d >= 0 && d < env.circuitProximityVetoPct) {
      return { nearUpper: false, nearLower: true, label: `near LCL ${d.toFixed(2)}%` };
    }
  }
  return null;
}

/**
 * NIFTY benchmark + top-K watchlist FULL quotes (throttled) for circuit proximity gates.
 * Merged into `MarketRegimeSnapshot` by the orchestrator.
 */
export async function fetchThrottledCircuitProximity(
  broker: BrokerClient,
  watchlistTickers: string[]
): Promise<{
  circuitProximityBlock: boolean;
  circuitProximityReasons: string[];
}> {
  const now = Date.now();
  if (now - lastRunAtMs < env.fullQuoteThrottleMs) {
    return {
      circuitProximityBlock: lastSnapshot.circuitProximityBlock,
      circuitProximityReasons: [...lastSnapshot.circuitProximityReasons],
    };
  }
  lastRunAtMs = now;

  const top = watchlistTickers
    .filter((t) => t && t.toUpperCase() !== env.niftySymbol.toUpperCase())
    .slice(0, env.fullQuoteTopK);
  const tickers = [env.niftySymbol, ...top];
  const rows: MarketQuoteFullRow[] = await broker.fetchMarketQuotesFull(tickers);
  const reasons: string[] = [];
  for (const r of rows) {
    const d = circuitDistancePct(r.ltp, r.upperCircuit, r.lowerCircuit);
    if (d) {
      reasons.push(`${r.ticker}: ${d.label}`);
    }
  }
  const circuitProximityBlock = reasons.length > 0;
  lastSnapshot = { at: now, circuitProximityBlock, circuitProximityReasons: reasons };
  return { circuitProximityBlock, circuitProximityReasons: reasons };
}
