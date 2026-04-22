/**
 * Evening post-mortem entrypoint (PM2 cron recommended).
 * Two focused judge calls: winners (incl. breakeven + open) vs losers.
 *
 * Reads `trades` for today’s IST date from Mongo (same data whether the daemon restarted or not).
 * Metrics and prompts use executed entries only (`order_executed !== false`).
 * Always upserts `lessons_learned` for that date (even if there were no executed trades).
 */
import "dotenv/config";
import { runAnalystForDate } from "./services/eveningJobs.js";
import { istDateString, nowIST } from "./time/ist.js";
import { runCli } from "./cli/runCli.js";

function parseArgs(): { date: string } {
  const argv = process.argv.slice(2);
  let date = istDateString(nowIST().minus({ days: 0 }));
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--date" && argv[i + 1]) {
      date = argv[++i]!;
    }
  }
  return { date };
}

async function main(): Promise<void> {
  const { date } = parseArgs();
  await runAnalystForDate(date, console.log);
}

runCli(main);
