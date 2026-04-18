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

  async post(
    path: string,
    body: Record<string, unknown>,
    accessToken: string | null
  ): Promise<SmartApiJson> {
    const res = await fetch(`${SMART_API_ROOT}${path}`, {
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
    const res = await fetch(`${SMART_API_ROOT}${path}`, {
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
