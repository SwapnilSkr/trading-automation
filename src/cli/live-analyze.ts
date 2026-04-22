/**
 * bun run live-analyze [-- --date YYYY-MM-DD]
 *
 * Analyze live/paper `trades` for an IST date (default: today IST).
 */
import "dotenv/config";
import { DateTime } from "luxon";
import { IST } from "../time/ist.js";
import { runCli } from "./runCli.js";
import { runLiveAnalyzeForDate } from "../services/eveningJobs.js";

function parseArgs(): { date?: string } {
  const args = process.argv.slice(2);
  let date: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--date" && args[i + 1]) date = args[++i]!;
  }
  return { date };
}

async function main(): Promise<void> {
  const { date } = parseArgs();
  const day = date ? DateTime.fromISO(date, { zone: IST }) : DateTime.now().setZone(IST);
  if (!day.isValid) throw new Error(`Invalid --date: ${date}`);
  await runLiveAnalyzeForDate(day.toFormat("yyyy-MM-dd"), console.log);
}

runCli(main);
