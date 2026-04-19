import { closeMongo } from "../db/mongo.js";

/**
 * Close MongoDB if a connection was opened; log but do not throw.
 */
export async function shutdownMongoCli(): Promise<void> {
  try {
    await closeMongo();
  } catch (e) {
    console.warn("[cli] Mongo shutdown:", e);
  }
}

/**
 * Run a CLI entrypoint: always close Mongo, then exit with 0 or 1.
 * Avoid calling process.exit() from inside main() so cleanup runs.
 */
export function runCli(main: () => Promise<void>): void {
  void (async () => {
    let code = 0;
    try {
      await main();
    } catch (e) {
      console.error(e);
      code = 1;
    } finally {
      await shutdownMongoCli();
    }
    process.exit(code);
  })();
}
