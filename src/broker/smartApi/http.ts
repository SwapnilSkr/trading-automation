import { env } from "../../config/env.js";
import { SMART_API_ROOT } from "./endpoints.js";
import {
  noteSmartApiRateLimit,
  retryJitterMs,
  scheduleSmartApiCall,
} from "./rateLimiter.js";

export interface SmartApiJson {
  status?: boolean;
  message?: string;
  errorcode?: string;
  data?: unknown;
  [key: string]: unknown;
}

export function decodeJwtExpMs(jwt: string): number | undefined {
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return undefined;
    const payload = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf8")
    ) as { exp?: number };
    return payload.exp !== undefined ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * When Angel returns 403/429 (rate limit) the body is sometimes plain text, not JSON.
 * Throwing here bypasses getCandleData chunk-level retries. Return `status: false` instead.
 */
function smartApiJsonFromResponse(res: Response, text: string): SmartApiJson {
  try {
    return JSON.parse(text) as SmartApiJson;
  } catch {
    const st = res.status;
    const retriable =
      st === 403 ||
      st === 429 ||
      st === 408 ||
      (st >= 500 && st <= 504);
    if (retriable) {
      const msg = text.replace(/\s+/g, " ").trim().slice(0, 400);
      return {
        status: false,
        message: `HTTP ${st}${msg ? `: ${msg}` : ""}`,
      };
    }
    throw new Error(`SmartAPI non-JSON (${st}): ${text.slice(0, 200)}`);
  }
}

export class SmartApiHttp {
  constructor(
    private readonly apiKey: string,
    private readonly localIp: string,
    private readonly publicIp: string,
    private readonly mac: string
  ) {}

  private baseHeaders(accessToken: string | null): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-UserType": "USER",
      "X-SourceID": "WEB",
      "X-ClientLocalIP": this.localIp,
      "X-ClientPublicIP": this.publicIp,
      "X-MACAddress": this.mac,
      "X-PrivateKey": this.apiKey,
    };
    if (accessToken) {
      h.Authorization = `Bearer ${accessToken}`;
    }
    return h;
  }

  private async fetchWith403Retry(
    url: string,
    init: RequestInit
  ): Promise<Response> {
    const max403 = Math.max(0, env.angelHttp403Retries);
    const max429 = Math.max(0, env.angelHttp429Retries);
    const maxAttempts = Math.max(max403, max429);
    const base = Math.max(1, env.angelHttp403RetryBaseMs);
    let last: Response | undefined;

    for (let attempt = 0; attempt <= maxAttempts; attempt++) {
      last = await fetch(url, init);
      const is403 = last.status === 403;
      const is429 = last.status === 429;
      const capped =
        (is403 && attempt >= max403) || (is429 && attempt >= max429);
      if ((!is403 && !is429) || capped) {
        return last;
      }
      const delay = base * 2 ** attempt + retryJitterMs();
      noteSmartApiRateLimit(attempt, last.status);
      console.warn(
        `[Angel] SmartAPI HTTP ${last.status} — retry ${attempt + 1}/${Math.max(max403, max429)} in ${delay}ms`
      );
      await sleep(delay);
    }
    return last!;
  }

  async post(
    path: string,
    body: Record<string, unknown>,
    accessToken: string | null
  ): Promise<SmartApiJson> {
    return scheduleSmartApiCall(() =>
      this.postUnqueued(path, body, accessToken)
    );
  }

  private async postUnqueued(
    path: string,
    body: Record<string, unknown>,
    accessToken: string | null
  ): Promise<SmartApiJson> {
    const res = await this.fetchWith403Retry(`${SMART_API_ROOT}${path}`, {
      method: "POST",
      headers: this.baseHeaders(accessToken),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return smartApiJsonFromResponse(res, text);
  }

  async get(path: string, accessToken: string | null): Promise<SmartApiJson> {
    return scheduleSmartApiCall(() => this.getUnqueued(path, accessToken));
  }

  private async getUnqueued(
    path: string,
    accessToken: string | null
  ): Promise<SmartApiJson> {
    const res = await this.fetchWith403Retry(`${SMART_API_ROOT}${path}`, {
      method: "GET",
      headers: this.baseHeaders(accessToken),
    });
    const text = await res.text();
    return smartApiJsonFromResponse(res, text);
  }
}
