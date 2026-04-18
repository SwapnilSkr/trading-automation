import "dotenv/config";
import { Elysia } from "elysia";
import { env } from "./config/env.js";
import { AngelOneStubBroker } from "./broker/angelOneStub.js";
import { TradingOrchestrator } from "./scheduler/orchestrator.js";
import { currentRunMode, describeMode } from "./scheduler/mode.js";

const broker = new AngelOneStubBroker();
const orchestrator = new TradingOrchestrator(broker);

await orchestrator.startup();

const app = new Elysia()
  .get("/health", () => ({
    ok: true,
    mode: describeMode(currentRunMode()),
    executionEnv: env.executionEnv,
  }))
  .listen(env.healthPort);

console.log(
  `Health http://${app.server?.hostname}:${app.server?.port}/health — trading loop every 60s`
);

setInterval(() => {
  orchestrator.tick().catch((err) => console.error("[tick]", err));
}, 60_000);

orchestrator.tick().catch((err) => console.error("[tick]", err));
