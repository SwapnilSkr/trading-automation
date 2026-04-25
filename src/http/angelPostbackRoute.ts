import { env } from "../config/env.js";
import { ingestOrderPayload } from "../services/orderLifecycleService.js";

function asRecord(x: unknown): Record<string, unknown> {
  if (x !== null && typeof x === "object" && !Array.isArray(x)) {
    return x as Record<string, unknown>;
  }
  return {};
}

/**
 * SmartAPI / Angel HTTPS postback (order lifecycle). Idempotent.
 * When `ANGEL_POSTBACK_SECRET` is set, require `x-postback-secret: <value>`.
 */
export type AngelPostbackResult =
  | { status: 401; body: { ok: false; error: string } }
  | {
      status: 200;
      body: {
        ok: boolean;
        inserted?: boolean;
        idempotency_key?: string;
        error?: string;
      };
    };

export async function handleAngelPostback(
  request: Request,
  body: unknown
): Promise<AngelPostbackResult> {
  const secret = env.angelPostbackSecret;
  if (secret) {
    const h = request.headers.get("x-postback-secret");
    if (h !== secret) {
      return { status: 401, body: { ok: false, error: "Unauthorized" } };
    }
  }

  let raw: Record<string, unknown>;
  if (typeof body === "string") {
    try {
      const parsed: unknown = JSON.parse(body);
      raw = asRecord(parsed);
    } catch {
      return {
        status: 200,
        body: { ok: false, error: "Invalid JSON body" },
      };
    }
  } else {
    raw = asRecord(body);
  }

  const r = await ingestOrderPayload("postback", raw);
  return {
    status: 200,
    body: {
      ok: true,
      inserted: r.inserted,
      idempotency_key: r.idempotency_key,
    },
  };
}
