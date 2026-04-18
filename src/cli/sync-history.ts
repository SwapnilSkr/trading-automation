import "dotenv/config";
import { AngelOneStubBroker } from "../broker/angelOneStub.js";
import { ensureIndexes } from "../db/repositories.js";
import { syncIntradayHistory } from "../services/marketSync.js";

async function main(): Promise<void> {
  await ensureIndexes();
  const broker = new AngelOneStubBroker();
  await broker.authenticate();
  await syncIntradayHistory(broker);
  console.log("[sync-history] done (stub broker returns no rows until API wired)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
