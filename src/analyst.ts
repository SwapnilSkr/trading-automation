/**
 * Evening post-mortem entrypoint (PM2 cron recommended).
 */
import "dotenv/config";
import { callJudgeModel } from "./ai/judge.js";
import { ensureIndexes, tradesForDay, upsertLesson } from "./db/repositories.js";
import { istDateString, nowIST } from "./time/ist.js";

async function main(): Promise<void> {
  await ensureIndexes();
  const date = istDateString(nowIST().minus({ days: 0 }));
  const trades = await tradesForDay(date);
  const summaryLines = trades.map(
    (t) =>
      `${t.ticker} ${t.strategy} conf=${t.ai_confidence.toFixed(2)} ${t.ai_reasoning.slice(0, 120)}`
  );

  const judge = await callJudgeModel({
    strategy: "POST_MORTEM",
    ticker: "PORTFOLIO",
    triggerHint: `Today's trades (${trades.length}):\n${summaryLines.join("\n")}`,
  });

  await upsertLesson({
    date,
    summary: judge.reasoning.slice(0, 2000),
    detail: JSON.stringify(
      trades.map((t) => ({
        ticker: t.ticker,
        strategy: t.strategy,
        conf: t.ai_confidence,
      })),
      null,
      0
    ),
  });

  console.log("[Analyst] Lesson saved for", date);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
