import { env } from "../../config/env.js";
import { SMART_API_ROOT } from "./endpoints.js";

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

export class SmartApiHttp {
  /** Single-flight queue: at most one SmartAPI request in flight at a time */
  private chain: Promise<unknown> = Promise.resolve();
  /** Earliest time the next request may start (after min-gap following previous completion) */
  private nextAllowedAtMs = 0;

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

  /**
   * Serialize every SmartAPI call and optionally enforce a quiet period after each response.
   */
  private schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const gap = env.angelHttpMinGapMs;
      const wait = Math.max(0, this.nextAllowedAtMs - Date.now());
      if (wait > 0) {
        await sleep(wait);
      }
      try {
        return await fn();
      } finally {
        this.nextAllowedAtMs = Date.now() + gap;
      }
    });
    this.chain = run.then(() => {}).catch(() => {});
    return run as Promise<T>;
  }

  private async fetchWith403Retry(
    url: string,
    init: RequestInit
  ): Promise<Response> {
    const max = env.angelHttp403Retries;
    const base = env.angelHttp403RetryBaseMs;
    let last: Response | undefined;
    for (let attempt = 0; attempt <= max; attempt++) {
      last = await fetch(url, init);
      if (last.status !== 403 || attempt >= max) {
        return last;
      }
      const delay = base * 2 ** attempt;
      console.warn(
        `[Angel] SmartAPI HTTP 403 — retry ${attempt + 1}/${max} in ${delay}ms`
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
    return this.schedule(() => this.postUnqueued(path, body, accessToken));
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
    let json: SmartApiJson;
    try {
      json = JSON.parse(text) as SmartApiJson;
    } catch {
      throw new Error(`SmartAPI non-JSON (${res.status}): ${text.slice(0, 200)}`);
    }
    return json;
  }

  async get(path: string, accessToken: string | null): Promise<SmartApiJson> {
    return this.schedule(() => this.getUnqueued(path, accessToken));
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
    let json: SmartApiJson;
    try {
      json = JSON.parse(text) as SmartApiJson;
    } catch {
      throw new Error(`SmartAPI non-JSON (${res.status}): ${text.slice(0, 200)}`);
    }
    return json;
  }
}
