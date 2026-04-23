/**
 * On-demand: refresh Nifty-50 “heavyweight” proxy list (NSE membership + Angel marketQuote).
 *
 *   bun run src/cli/resolve-heavyweights.ts
 */
import "dotenv/config";
import { createBroker } from "../broker/factory.js";
import {
  getCachedNifty50Heavyweights,
  resolveNifty50HeavyweightsLive,
} from "../market/niftyHeavyweights.js";
import { runCli } from "./runCli.js";

async function main(): Promise<void> {
  const broker = createBroker();
  await broker.authenticate();
  const tickers = await resolveNifty50HeavyweightsLive(broker);
  const meta = getCachedNifty50Heavyweights();
  console.log(JSON.stringify({ tickers, source: meta?.source, count: tickers.length }, null, 2));
}

runCli(main);
