import "dotenv/config";
import { Elysia } from "elysia";
import { env } from "./config/env.js";
import { createBroker } from "./broker/factory.js";
import { TradingOrchestrator } from "./scheduler/orchestrator.js";
import { currentRunMode, describeMode } from "./scheduler/mode.js";
import {
  getLastTickAtMs,
  markOrchestratorTick,
} from "./runtime/healthMetrics.js";

const TICK_STALE_MS = 2 * 60 * 1000;

const broker = createBroker();
const orchestrator = new TradingOrchestrator(broker);

await orchestrator.startup();

const app = new Elysia()
  .get("/health", () => {
    const lastMs = getLastTickAtMs();
    const hasTick = lastMs > 0;
    const ageMs = hasTick ? Date.now() - lastMs : Number.POSITIVE_INFINITY;
    return {
      ok: true,
      mode: describeMode(currentRunMode()),
      executionEnv: env.executionEnv,
      last_tick_at_ms: hasTick ? lastMs : null,
      last_tick_at: hasTick ? new Date(lastMs).toISOString() : null,
      tick_stale: !hasTick || ageMs > TICK_STALE_MS,
      tick_age_ms: hasTick ? ageMs : null,
    };
  })
  .listen(env.healthPort);

console.log(
  `Health http://${app.server?.hostname}:${app.server?.port}/health — trading loop every 60s`
);

async function runTick(): Promise<void> {
  await orchestrator.tick();
  markOrchestratorTick();
}

setInterval(() => {
  runTick().catch((err) => console.error("[tick]", err));
}, 60_000);

runTick().catch((err) => console.error("[tick]", err));
