import { DateTime } from "luxon";
import { env } from "../config/env.js";
import { fetchOhlcRange } from "../db/repositories.js";
import { getTickerMetadata } from "../market/tickerMetadata.js";
import type { Ohlc1m } from "../types/domain.js";
import { IST } from "../time/ist.js";

export interface PortfolioPosition {
  ticker: string;
  side: "BUY" | "SELL";
  entryPrice: number;
  qty: number;
}

export interface PortfolioRiskInput {
  ticker: string;
  side: "BUY" | "SELL";
  entryPrice: number;
  qty: number;
  openPositions: PortfolioPosition[];
  at: Date;
  throttleMultiplier: number;
}

export interface PortfolioRiskEval {
  allowed: boolean;
  reasons: string[];
  sector: string;
  beta: number;
  open_position_count: number;
  same_sector_positions: number;
  same_side_positions: number;
  gross_exposure_pct: number;
  beta_exposure_pct: number;
  max_correlation?: number;
  throttle_multiplier: number;
  recommended_qty?: number;
  exposure_fit_applied?: boolean;
}

function normalizeTicker(ticker: string): string {
  return ticker.trim().toUpperCase().replace(/-EQ$/i, "");
}

function dailyCloses(bars: Ohlc1m[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const b of bars) {
    const day = DateTime.fromJSDate(b.ts, { zone: IST }).toFormat("yyyy-MM-dd");
    out.set(day, b.c);
  }
  return out;
}

function returnsByDay(closes: Map<string, number>): Map<string, number> {
  const entries = [...closes.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const out = new Map<string, number>();
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1]![1];
    const curr = entries[i]![1];
    if (prev > 0) out.set(entries[i]![0], (curr - prev) / prev);
  }
  return out;
}

function pearson(a: number[], b: number[]): number | undefined {
  if (a.length < 5 || b.length !== a.length) return undefined;
  const meanA = a.reduce((s, x) => s + x, 0) / a.length;
  const meanB = b.reduce((s, x) => s + x, 0) / b.length;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < a.length; i++) {
    const da = a[i]! - meanA;
    const db = b[i]! - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  return den === 0 ? undefined : num / den;
}

async function rollingCorrelation(
  tickerA: string,
  tickerB: string,
  at: Date
): Promise<number | undefined> {
  const end = at;
  const start = DateTime.fromJSDate(at, { zone: IST })
    .minus({ days: Math.max(5, env.correlationLookbackDays) * 3 })
    .toJSDate();
  const [barsA, barsB] = await Promise.all([
    fetchOhlcRange(tickerA, start, end),
    fetchOhlcRange(tickerB, start, end),
  ]);
  const returnsA = returnsByDay(dailyCloses(barsA));
  const returnsB = returnsByDay(dailyCloses(barsB));
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [day, retA] of returnsA) {
    const retB = returnsB.get(day);
    if (retB === undefined) continue;
    xs.push(retA);
    ys.push(retB);
  }
  return pearson(xs.slice(-env.correlationLookbackDays), ys.slice(-env.correlationLookbackDays));
}

export async function evaluatePortfolioRisk(
  input: PortfolioRiskInput
): Promise<PortfolioRiskEval> {
  const ticker = normalizeTicker(input.ticker);
  const meta = getTickerMetadata(ticker);
  const positions = input.openPositions.map((p) => ({
    ...p,
    ticker: normalizeTicker(p.ticker),
  }));
  const reasons: string[] = [];

  const sameTicker = positions.some((p) => p.ticker === ticker);
  if (sameTicker) reasons.push(`${ticker} already has an open position`);

  const sameSectorPositions = positions.filter(
    (p) => getTickerMetadata(p.ticker).sector === meta.sector
  ).length;
  if (sameSectorPositions >= env.maxSectorPositions) {
    reasons.push(`sector cap ${meta.sector}: ${sameSectorPositions}/${env.maxSectorPositions}`);
  }

  const sameSidePositions = positions.filter((p) => p.side === input.side).length;
  if (sameSidePositions >= env.maxSameSidePositions) {
    reasons.push(`same-side cap ${input.side}: ${sameSidePositions}/${env.maxSameSidePositions}`);
  }

  const existingGrossNotional = positions.reduce(
    (s, p) => s + Math.abs(p.entryPrice * p.qty),
    0
  );
  const existingBetaNotional = positions.reduce((s, p) => {
    const pMeta = getTickerMetadata(p.ticker);
    const notional = Math.abs(p.entryPrice * p.qty);
    return s + notional * Math.abs(pMeta.beta);
  }, 0);

  const proposedQty = Math.max(0, Math.floor(input.qty));
  let effectiveQty = proposedQty;
  let recommendedQty: number | undefined;
  let exposureFitApplied = false;

  if (env.exposureFitSizingEnabled && proposedQty > 0 && input.entryPrice > 0) {
    const grossCap = Math.max(1, env.accountEquity * env.maxGrossExposurePct);
    const betaCap = Math.max(1, env.accountEquity * env.maxBetaExposurePct);
    const grossHeadroom = Math.max(0, grossCap - existingGrossNotional);
    const betaHeadroom = Math.max(0, betaCap - existingBetaNotional);
    const allowedByGross = Math.floor(grossHeadroom / input.entryPrice);
    const betaUnit = input.entryPrice * Math.max(1e-9, Math.abs(meta.beta));
    const allowedByBeta = Math.floor(betaHeadroom / betaUnit);
    const fitQty = Math.max(0, Math.min(proposedQty, allowedByGross, allowedByBeta));
    if (fitQty < proposedQty) {
      recommendedQty = fitQty;
      if (fitQty >= env.minQtyPerTrade) {
        effectiveQty = fitQty;
        exposureFitApplied = true;
      }
    }
  }

  let grossNotional = existingGrossNotional + Math.abs(input.entryPrice * effectiveQty);
  let betaNotional = existingBetaNotional + Math.abs(input.entryPrice * effectiveQty) * Math.abs(meta.beta);

  const grossExposurePct = grossNotional / Math.max(1, env.accountEquity);
  const betaExposurePct = betaNotional / Math.max(1, env.accountEquity);
  if (proposedQty < env.minQtyPerTrade) {
    reasons.push(`qty below minimum: ${proposedQty}<${env.minQtyPerTrade}`);
  }
  if (recommendedQty !== undefined && recommendedQty < env.minQtyPerTrade) {
    reasons.push(
      `insufficient exposure headroom (fit qty ${recommendedQty}<${env.minQtyPerTrade})`
    );
  }
  if (grossExposurePct > env.maxGrossExposurePct) {
    reasons.push(`gross exposure ${(grossExposurePct * 100).toFixed(0)}% > ${(env.maxGrossExposurePct * 100).toFixed(0)}%`);
  }
  if (betaExposurePct > env.maxBetaExposurePct) {
    reasons.push(`beta exposure ${(betaExposurePct * 100).toFixed(0)}% > ${(env.maxBetaExposurePct * 100).toFixed(0)}%`);
  }

  let maxCorrelation: number | undefined;
  if (positions.length > 0) {
    const corrs = await Promise.all(
      positions
        .filter((p) => p.ticker !== ticker)
        .map((p) => rollingCorrelation(ticker, p.ticker, input.at))
    );
    const valid = corrs.filter((c): c is number => c !== undefined);
    if (valid.length > 0) {
      maxCorrelation = Math.max(...valid);
      if (maxCorrelation > env.maxCorrelationWithOpen) {
        reasons.push(`correlation ${maxCorrelation.toFixed(2)} > ${env.maxCorrelationWithOpen.toFixed(2)}`);
      }
    }
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    sector: meta.sector,
    beta: meta.beta,
    open_position_count: positions.length,
    same_sector_positions: sameSectorPositions,
    same_side_positions: sameSidePositions,
    gross_exposure_pct: grossExposurePct,
    beta_exposure_pct: betaExposurePct,
    max_correlation: maxCorrelation,
    throttle_multiplier: input.throttleMultiplier,
    recommended_qty: recommendedQty,
    exposure_fit_applied: exposureFitApplied,
  };
}
