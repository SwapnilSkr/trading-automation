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
import { handleAngelPostback } from "./http/angelPostbackRoute.js";

const TICK_STALE_MS = 2 * 60 * 1000;

const broker = createBroker();
const orchestrator = new TradingOrchestrator(broker);

await orchestrator.startup();

const app = new Elysia()
  .post("/v1/angel/postback", async ({ request, body, set }) => {
    const r = await handleAngelPostback(request, body);
    set.status = r.status;
    return r.body;
  })
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
  .post("/v1/emergency/square-off", async ({ request, set }) => {
    const configured = env.emergencySquareOffSecret;
    if (!configured) {
      set.status = 404;
      return { ok: false, error: "Emergency route disabled (set EMERGENCY_SQUARE_OFF_SECRET)" };
    }
    const key = request.headers.get("x-emergency-key") ?? "";
    if (key !== configured) {
      set.status = 401;
      return { ok: false, error: "Unauthorized" };
    }

    await broker.authenticate();
    await broker.refreshSessionIfNeeded();
    const positions = await broker.listOpenPositions();
    const closed: string[] = [];
    const errors: { ticker: string; message: string }[] = [];

    for (const p of positions) {
      try {
        await broker.closeIntraday(p.ticker);
        closed.push(p.ticker);
      } catch (e) {
        errors.push({
          ticker: p.ticker,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }

    setImmediate(() => {
      console.error(
        "[EMERGENCY] square-off finished — exiting (pm2 may restart; run pm2 stop if needed)"
      );
      process.exit(errors.length > 0 ? 1 : 0);
    });

    return {
      ok: errors.length === 0,
      executionEnv: env.executionEnv,
      closed,
      errors,
      note:
        "Process exit scheduled. If PM2 autorestarts this app, run `pm2 stop <name>` to stay flat.",
    };
  })
  .listen(env.healthPort);

console.log(
  `Health http://${app.server?.hostname}:${app.server?.port}/health — trading loop every 60s`
);

async function runTick(): Promise<void> {
  if (tickInFlight) {
    console.warn("[tick] previous tick still running — skipping this cycle");
    return;
  }
  tickInFlight = true;
  try {
    await orchestrator.tick();
    markOrchestratorTick();
  } finally {
    tickInFlight = false;
  }
}

let tickInFlight = false;

setInterval(() => {
  runTick().catch((err) => console.error("[tick]", err));
}, 60_000);

runTick().catch((err) => console.error("[tick]", err));
