import "dotenv/config";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { DateTime } from "luxon";
import { env } from "../config/env.js";
import { collections, getDb } from "../db/mongo.js";
import {
  ensureIndexes,
  fetchLessonForDate,
  getNewsForDate,
  getSessionWatchlist,
  getWatchlistSnapshotForEffectiveDate,
  tradesForDay,
} from "../db/repositories.js";
import type { Ohlc1m, TradeLogDoc } from "../types/domain.js";
import { IST, istDateString, nextIndianWeekdayAfter } from "../time/ist.js";
import { runCli } from "./runCli.js";

type ActionType =
  | "SHOW_STATUS"
  | "PREPARE_DAY"
  | "REPLAY_DAY"
  | "RUN_ANALYST"
  | "RUN_DISCOVERY"
  | "SYNC_DAY"
  | "HELP";

interface ActionPlan {
  reply: string;
  actions: Array<{
    type: ActionType;
    date?: string;
    skip_judge?: boolean;
    step_minutes?: number;
    days?: number;
    top?: number;
  }>;
}

interface DailyStatus {
  date: string;
  snapshotTickers: number;
  activeTickers: number;
  activeUpdatedAt?: string;
  newsContextPresent: boolean;
  lessonPresent: boolean;
  executedTrades: number;
  exits: number;
  openTrades: number;
  pnl: number;
  ohlcCoveredTickers: number;
  ohlcTotalTickers: number;
  latestBacktestRun?: string;
}

function parseArgs(): { date: string } {
  const argv = process.argv.slice(2);
  let date = istDateString();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--date" && argv[i + 1]) date = argv[++i]!;
  }
  return { date };
}

function parseDate(date: string): DateTime {
  const d = DateTime.fromISO(date, { zone: IST });
  if (!d.isValid) throw new Error(`Invalid date: ${date} (use YYYY-MM-DD)`);
  return d;
}

function dayRange(date: string): { from: Date; to: Date } {
  const d = parseDate(date);
  return { from: d.startOf("day").toJSDate(), to: d.endOf("day").toJSDate() };
}

function previousIndianWeekday(date: string): string {
  let d = parseDate(date).minus({ days: 1 });
  while (d.weekday > 5) d = d.minus({ days: 1 });
  return d.toFormat("yyyy-MM-dd");
}

function formatStatus(s: DailyStatus): string {
  const bits = [
    `date=${s.date}`,
    `snapshot=${s.snapshotTickers}`,
    `active_watchlist=${s.activeTickers}${s.activeUpdatedAt ? `@${s.activeUpdatedAt}` : ""}`,
    `news_context=${s.newsContextPresent ? "yes" : "no"}`,
    `lesson=${s.lessonPresent ? "yes" : "no"}`,
    `trades=executed:${s.executedTrades},open:${s.openTrades},exits:${s.exits},pnl:${s.pnl.toFixed(2)}`,
    `ohlc_coverage=${s.ohlcCoveredTickers}/${s.ohlcTotalTickers}`,
    `latest_backtest=${s.latestBacktestRun ?? "none"}`,
  ];
  return bits.join(" | ");
}

async function loadStatus(date: string): Promise<DailyStatus> {
  const db = await getDb();
  const { from, to } = dayRange(date);
  const snapshot = await getWatchlistSnapshotForEffectiveDate(date);
  const active = await getSessionWatchlist();
  const news = await getNewsForDate(date);
  const lesson = await fetchLessonForDate(date);
  const trades = await tradesForDay(date);
  const executed = trades.filter((t) => t.order_executed !== false);
  const exits = executed.filter((t) => t.result).length;
  const open = executed.filter((t) => !t.result).length;
  const pnl = executed.reduce((s, t) => s + (t.result?.pnl ?? 0), 0);

  const tickers =
    snapshot?.tickers?.length
      ? snapshot.tickers
      : active?.tickers?.length
        ? active.tickers
        : env.watchedTickers;

  let covered = 0;
  if (tickers.length > 0) {
    const rows = await db
      .collection<Ohlc1m>(collections.ohlc1m)
      .aggregate<{ _id: string; bars: number }>([
        { $match: { ticker: { $in: tickers }, ts: { $gte: from, $lte: to } } },
        { $group: { _id: "$ticker", bars: { $sum: 1 } } },
      ])
      .toArray();
    covered = rows.filter((r) => r.bars >= 30).length;
  }

  const latestBacktest = await db
    .collection<TradeLogDoc>(collections.tradesBacktest)
    .find({ entry_time: { $gte: from, $lte: to }, backtest_run_id: { $exists: true } })
    .sort({ entry_time: -1 })
    .limit(1)
    .toArray();

  return {
    date,
    snapshotTickers: snapshot?.tickers?.length ?? 0,
    activeTickers: active?.tickers?.length ?? 0,
    activeUpdatedAt: active
      ? DateTime.fromJSDate(active.updated_at, { zone: IST }).toFormat(
          "yyyy-MM-dd HH:mm"
        )
      : undefined,
    newsContextPresent: Boolean(news),
    lessonPresent: Boolean(lesson),
    executedTrades: executed.length,
    exits,
    openTrades: open,
    pnl,
    ohlcCoveredTickers: covered,
    ohlcTotalTickers: tickers.length,
    latestBacktestRun: latestBacktest[0]?.backtest_run_id,
  };
}

function extractJsonObject(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence?.[1]) return fence[1].trim();
  const start = trimmed.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === "\"") inStr = false;
      continue;
    }
    if (ch === "\"") {
      inStr = true;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return trimmed.slice(start, i + 1);
    }
  }
  return undefined;
}

async function callOpsModel(
  userText: string,
  status: DailyStatus,
  memory: string[]
): Promise<ActionPlan> {
  const key = env.openRouterApiKey();
  if (!key) {
    return {
      reply: "OPENROUTER_API_KEY missing. I can still run direct commands if you type explicit requests.",
      actions: [],
    };
  }

  const system = `You are an ops copilot for an intraday trading automation stack.
Decide concrete operational actions using provided status + user request.
Return ONLY JSON with shape:
{"reply":"short text","actions":[{"type":"SHOW_STATUS|PREPARE_DAY|REPLAY_DAY|RUN_ANALYST|RUN_DISCOVERY|SYNC_DAY|HELP","date":"YYYY-MM-DD","skip_judge":true,"step_minutes":15,"days":5,"top":10}]}
Rules:
- Default date = current status date.
- Use PREPARE_DAY when user asks to resume/start safely.
- Use REPLAY_DAY when user asks to backtest/replay missed day.
- Use RUN_ANALYST for post-mortem/lesson generation.
- Use RUN_DISCOVERY to rebuild watchlist snapshot/discovery.
- Keep action list short and deterministic.
- Never invent commands outside allowed action types.`;

  const user = [
    `[STATUS] ${formatStatus(status)}`,
    `[RECENT_MEMORY] ${memory.slice(-6).join(" || ") || "none"}`,
    `[USER_REQUEST] ${userText}`,
  ].join("\n");

  const res = await fetch(`${env.openRouterBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: env.opsAiModel,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.1,
      max_tokens: 500,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    return {
      reply: `LLM planning failed (${res.status}). ${t.slice(0, 180)}`,
      actions: [],
    };
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = data.choices?.[0]?.message?.content ?? "{}";
  const jsonText = extractJsonObject(raw);
  if (!jsonText) return { reply: raw.slice(0, 300), actions: [] };
  try {
    const parsed = JSON.parse(jsonText) as ActionPlan;
    const actions = Array.isArray(parsed.actions) ? parsed.actions : [];
    return { reply: String(parsed.reply ?? ""), actions };
  } catch {
    return { reply: raw.slice(0, 300), actions: [] };
  }
}

function runBun(args: string[]): void {
  const r = spawnSync("bun", ["run", ...args], { stdio: "inherit" });
  if ((r.status ?? 1) !== 0) {
    throw new Error(`Command failed: bun run ${args.join(" ")} (status=${r.status})`);
  }
}

async function executeAction(action: ActionPlan["actions"][number], baseDate: string): Promise<void> {
  const date = action.date ?? baseDate;
  parseDate(date);
  switch (action.type) {
    case "SHOW_STATUS":
      return;
    case "PREPARE_DAY": {
      const asOf = previousIndianWeekday(date);
      if (date === istDateString()) {
        runBun(["discovery-sync", "--", "--to", asOf, "--effective-for", date, "--top", String(action.top ?? 10), "--days", String(action.days ?? 5)]);
      } else {
        runBun(["discovery-sync", "--", "--to", asOf, "--effective-for", date, "--top", String(action.top ?? 10), "--days", String(action.days ?? 5), "--snapshot-only"]);
      }
      return;
    }
    case "REPLAY_DAY": {
      const step = action.step_minutes && action.step_minutes > 0 ? action.step_minutes : 15;
      const extra = action.skip_judge === false ? [] : ["--skip-judge"];
      runBun([
        "backtest-snapshots",
        "--",
        "--from",
        date,
        "--to",
        date,
        "--step",
        String(step),
        ...extra,
      ]);
      return;
    }
    case "RUN_ANALYST":
      runBun(["analyst", "--", "--date", date]);
      return;
    case "RUN_DISCOVERY": {
      const effective = nextIndianWeekdayAfter(parseDate(date)).toFormat("yyyy-MM-dd");
      runBun([
        "discovery-sync",
        "--",
        "--to",
        date,
        "--effective-for",
        effective,
        "--days",
        String(action.days ?? 5),
        "--top",
        String(action.top ?? 10),
      ]);
      return;
    }
    case "SYNC_DAY": {
      const active = await getSessionWatchlist();
      const tickers =
        active?.tickers?.length
          ? active.tickers.join(",")
          : env.watchedTickers.join(",");
      runBun([
        "sync-history",
        "--",
        "--from",
        date,
        "--to",
        date,
        "--tickers",
        tickers,
      ]);
      return;
    }
    case "HELP":
      return;
    default:
      return;
  }
}

function printHelp(): void {
  console.log("\n[ops-ai] examples:");
  console.log("  - prepare today so i can resume now");
  console.log("  - replay 2026-04-18 with skip judge");
  console.log("  - run analyst for 2026-04-18");
  console.log("  - show status");
  console.log("  - run discovery for yesterday");
  console.log("  - sync today bars");
  console.log("  slash commands: /status /date YYYY-MM-DD /help /exit");
}

async function interactive(startDate: string): Promise<void> {
  const rl = createInterface({ input, output });
  let currentDate = startDate;
  const memory: string[] = [];
  console.log(`[ops-ai] model=${env.opsAiModel} date=${currentDate}`);
  console.log("[ops-ai] type /help for examples");
  try {
    while (true) {
      const status = await loadStatus(currentDate);
      let raw = "";
      try {
        raw = (await rl.question("\nops-ai> ")).trim();
      } catch (e) {
        const code = (e as { code?: string })?.code;
        if (code === "ERR_USE_AFTER_CLOSE") break;
        throw e;
      }
      if (!raw) continue;
      if (raw === "/exit" || raw === "exit" || raw === "quit") break;
      if (raw === "/help") {
        printHelp();
        continue;
      }
      if (raw === "/status") {
        console.log(`[ops-ai] ${formatStatus(status)}`);
        continue;
      }
      if (raw.startsWith("/date ")) {
        const d = raw.slice(6).trim();
        parseDate(d);
        currentDate = d;
        console.log(`[ops-ai] date set to ${currentDate}`);
        continue;
      }

      const plan = await callOpsModel(raw, status, memory);
      if (plan.reply) console.log(`[ops-ai] ${plan.reply}`);
      if (!plan.actions.length) {
        console.log("[ops-ai] no action plan returned");
        memory.push(`user:${raw}`);
        memory.push(`assistant:${plan.reply || "no-actions"}`);
        continue;
      }

      for (const action of plan.actions) {
        const effectiveDate = action.date ?? currentDate;
        console.log(`[ops-ai] action=${action.type} date=${effectiveDate}`);
        await executeAction(action, currentDate);
      }

      const after = await loadStatus(currentDate);
      console.log(`[ops-ai] status ${formatStatus(after)}`);
      memory.push(`user:${raw}`);
      memory.push(`assistant:${plan.reply || "ok"} actions=${plan.actions.map((a) => a.type).join(",")}`);
    }
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const { date } = parseArgs();
  parseDate(date);
  await ensureIndexes();
  await interactive(date);
}

runCli(main);
