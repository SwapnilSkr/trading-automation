import { env } from "../config/env.js";
import type { BrokerClient } from "../broker/types.js";
import { ingestOrderPayload } from "./orderLifecycleService.js";

let lastPollAtMs = 0;

/**
 * LIVE-only: poll the SmartAPI order book and merge into the same idempotent lifecycle store.
 * Configured with `ORDER_RECONCILIATION_POLL_MS` (>0).
 */
export async function maybePollOrderReconciliation(
  broker: BrokerClient
): Promise<void> {
  if (env.executionEnv !== "LIVE" || env.orderReconciliationPollMs <= 0) return;
  if (!broker.getOrderBook) return;
  const now = Date.now();
  if (now - lastPollAtMs < env.orderReconciliationPollMs) return;
  lastPollAtMs = now;
  try {
    const rows = await broker.getOrderBook();
    for (const row of rows) {
      await ingestOrderPayload("poll", row as Record<string, unknown>);
    }
  } catch (e) {
    console.error("[order-reconciliation] getOrderBook poll failed", e);
  }
}
