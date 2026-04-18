import "dotenv/config";
import { createBroker } from "../broker/factory.js";
import { ensureIndexes } from "../db/repositories.js";
import { syncIntradayHistory } from "../services/marketSync.js";

async function main(): Promise<void> {
  await ensureIndexes();
  const broker = createBroker();
  await broker.authenticate();
  await syncIntradayHistory(broker);
  console.log("[sync-history] done (stub broker returns no rows until API wired)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
