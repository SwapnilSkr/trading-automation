import type { ObjectId } from "mongodb";
import {
  findOpenTradeIdByBrokerOrderId,
  insertOrderLifecycleEventIfNew,
  updateTradeBrokerFields,
} from "../db/repositories.js";
import type { OrderLifecycleEventDoc } from "../types/orderLifecycle.js";

function str(x: unknown): string | undefined {
  if (x === undefined || x === null) return undefined;
  return String(x).trim() || undefined;
}

/**
 * Build idempotency key so the same broker notification is not stored twice.
 */
export function buildOrderEventIdempotencyKey(
  source: OrderLifecycleEventDoc["source"],
  raw: Record<string, unknown>
): string {
  const uq = str(raw.uniqueorderid) ?? str(raw.uniqueOrderId);
  const oid = str(raw.orderid) ?? str(raw.orderId);
  const upd = str(raw.updatetime) ?? str(raw.orderupdatetime) ?? str(raw.exchorderupdatetime);
  const st = str(raw.orderstatus) ?? str(raw.status);
  const base = uq ?? oid ?? "unknown";
  return `${source}::${base}::${upd ?? ""}::${st ?? ""}`.slice(0, 512);
}

export function normalizeBrokerStatus(
  orderstatus?: string,
  status?: string
): string {
  const s = (orderstatus ?? status ?? "").toLowerCase();
  if (!s) return "unknown";
  if (s.includes("reject")) return "rejected";
  if (s.includes("cancel")) return "cancelled";
  if (s.includes("complete") || s === "filled" || s === "fully filled")
    return "complete";
  if (s.includes("open") || s.includes("pending") || s.includes("trigger"))
    return "open";
  return s;
}

/**
 * Ingest one order payload (postback, poll row, or synthetic). Idempotent.
 */
export async function ingestOrderPayload(
  source: OrderLifecycleEventDoc["source"],
  raw: Record<string, unknown>,
  options?: { tradeId?: ObjectId }
): Promise<{ inserted: boolean; idempotency_key: string }> {
  const idempotency_key = buildOrderEventIdempotencyKey(source, raw);
  const orderid = str(raw.orderid) ?? str(raw.orderId);
  const uniqueorderid = str(raw.uniqueorderid) ?? str(raw.uniqueOrderId);
  const orderstatus =
    str(raw.orderstatus) ?? str(raw.orderStatus) ?? str(raw.status);
  const tradingsymbol = str(raw.tradingsymbol) ?? str(raw.tradingSymbol);

  const doc: OrderLifecycleEventDoc = {
    idempotency_key,
    source,
    orderid,
    uniqueorderid,
    orderstatus,
    status: str(raw.status),
    tradingsymbol,
    received_at: new Date(),
    raw,
    ...(options?.tradeId ? { trade_id: options.tradeId } : {}),
  };

  const inserted = await insertOrderLifecycleEventIfNew(doc);
  if (!inserted) return { inserted: false, idempotency_key };

  const tid = await findOpenTradeIdByBrokerOrderId(orderid, uniqueorderid);
  if (tid) {
    const st = normalizeBrokerStatus(orderstatus, str(raw.status));
    await updateTradeBrokerFields(tid, {
      angel_orderid: orderid,
      angel_uniqueorderid: uniqueorderid,
      broker_order_status: st,
    });
  }

  return { inserted: true, idempotency_key };
}

/** PAPER: model an instant “complete” fill with no exchange. */
export async function recordSyntheticPaperOrder(args: {
  orderId: string;
  uniqueOrderId?: string;
  tradingsymbol?: string;
  tradeId?: ObjectId;
}): Promise<void> {
  const raw: Record<string, unknown> = {
    orderid: args.orderId,
    uniqueorderid: args.uniqueOrderId,
    orderstatus: "complete",
    status: "complete",
    tradingsymbol: args.tradingsymbol,
    text: "synthetic PAPER fill (no exchange order)",
  };
  await ingestOrderPayload("synthetic", raw, { tradeId: args.tradeId });
  if (args.tradeId) {
    await updateTradeBrokerFields(args.tradeId, {
      angel_orderid: args.orderId,
      angel_uniqueorderid: args.uniqueOrderId,
      broker_order_status: "complete",
    });
  }
}
