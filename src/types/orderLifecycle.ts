import type { Document, ObjectId } from "mongodb";

/**
 * Durable idempotency key for the same broker update (postback, poll, or synthetic).
 */
export interface OrderLifecycleEventDoc extends Document {
  idempotency_key: string;
  source: "postback" | "poll" | "synthetic";
  /** Angel numeric order id when present */
  orderid?: string;
  uniqueorderid?: string;
  orderstatus?: string;
  status?: string;
  tradingsymbol?: string;
  received_at: Date;
  /** Raw payload subset for audit */
  raw: Record<string, unknown>;
  /** When linked from our trade log */
  trade_id?: ObjectId;
}

export type NormalizedOrderStatus =
  | "open"
  | "complete"
  | "rejected"
  | "cancelled"
  | "unknown";
