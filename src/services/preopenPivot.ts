import { callJudgeModel } from "../ai/judge.js";
import { env } from "../config/env.js";
import type { BrokerClient } from "../broker/types.js";
import {
  averageDailyVolumeBefore,
  upsertSessionWatchlist,
  upsertWatchlistSnapshot,
} from "../db/repositories.js";
import type {
  ActiveWatchlistDoc,
  WatchlistSnapshotDoc,
} from "../types/domain.js";
import { istDateString, nowIST } from "../time/ist.js";

function parseJudgePick(reasoning: string): string[] | null {
  const t = reasoning.trim();
  const tryParse = (s: string) => {
    try {
      const j = JSON.parse(s) as { pick?: unknown };
      if (!Array.isArray(j.pick)) return null;
      return j.pick.map((x) => String(x).replace(/-EQ$/i, "").toUpperCase());
    } catch {
      return null;
    }
  };
  const direct = tryParse(t);
  if (direct) return direct;
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) return tryParse(fence[1].trim());
  return null;
}

export interface PreopenPivotResult {
  effectiveDate: string;
  tickers: string[];
  filtered: {
    ticker: string;
    gapPct: number;
    volRatio: number;
  }[];
}

/**
 * Quote NSE names near open, keep gap + participation filters, optional judge JSON pick.
 */
export async function runPreopenPivot(
  broker: BrokerClient,
  candidates: string[]
): Promise<PreopenPivotResult | null> {
  const cap = Math.min(candidates.length, env.preopenMaxCandidates);
  const list = candidates.slice(0, cap);
  if (list.length === 0) return null;

  const sessionOpen = nowIST().set({ hour: 9, minute: 15, second: 0 }).toJSDate();
  const quotes = await broker.fetchMarketQuotesFull(list);

  const scored: { ticker: string; gapPct: number; volRatio: number }[] = [];

  for (const q of quotes) {
    const prev = q.close;
    const open = q.open ?? q.ltp;
    const vol = q.tradeVolume;
    if (
      prev === undefined ||
      open === undefined ||
      prev === 0 ||
      vol === undefined
    ) {
      continue;
    }
    const gapPct = ((open - prev) / prev) * 100;
    if (Math.abs(gapPct) < env.preopenMinAbsGapPct) continue;

    const avgDay = await averageDailyVolumeBefore(q.ticker, sessionOpen, 5);
    if (avgDay === undefined || avgDay <= 0) continue;
    const volRatio = vol / avgDay;
    if (volRatio < env.preopenMinVolVsAvg) continue;

    scored.push({ ticker: q.ticker, gapPct, volRatio });
  }

  scored.sort(
    (a, b) =>
      Math.abs(b.gapPct) * b.volRatio - Math.abs(a.gapPct) * a.volRatio
  );

  let tickers = scored.map((s) => s.ticker).slice(0, env.preopenMaxPicks);

  if (
    env.preopenJudgeEnabled &&
    tickers.length > 1 &&
    env.openRouterApiKey()
  ) {
    const hint = scored
      .slice(0, 12)
      .map(
        (s) =>
          `${s.ticker} gap=${s.gapPct.toFixed(2)}% sessionVol/avg5d=${s.volRatio.toFixed(2)}`
      )
      .join("\n");
    const judge = await callJudgeModel({
      strategy: "PREOPEN_PICK",
      ticker: "NSE_PREOPEN",
      triggerHint: `${hint}\n\nPre-open / early auction context. Return ONLY compact JSON: {"pick":["SYM1","SYM2"]} with up to 5 symbols you judge as trend/breakout candidates vs likely gap-fill. Symbols must be from the list above.`,
    });
    const picked = parseJudgePick(judge.reasoning);
    if (picked?.length) {
      const allowed = new Set(scored.map((s) => s.ticker));
      tickers = picked.filter((p) => allowed.has(p)).slice(0, 5);
      if (tickers.length === 0) {
        tickers = scored.map((s) => s.ticker).slice(0, env.preopenMaxPicks);
      }
    }
  }

  if (tickers.length === 0) return null;

  const effectiveDate = istDateString(nowIST());
  const sessionDoc: ActiveWatchlistDoc = {
    _id: "current_session",
    tickers,
    updated_at: new Date(),
    source: "preopen_pivot",
    performers: scored.slice(0, tickers.length).map((s) => ({
      ticker: s.ticker,
      score: Math.abs(s.gapPct) * s.volRatio,
      pct5d: s.gapPct,
      volRatio: s.volRatio,
    })),
  };
  await upsertSessionWatchlist(sessionDoc);

  const snap: WatchlistSnapshotDoc = {
    effective_date: effectiveDate,
    tickers,
    source: "preopen_pivot",
    performers: sessionDoc.performers,
    preopen_meta: { filtered: scored },
    created_at: new Date(),
  };
  await upsertWatchlistSnapshot(snap);

  return { effectiveDate, tickers, filtered: scored };
}
