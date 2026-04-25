import { env } from "../config/env.js";
import { AngelOneBroker } from "../broker/angelOneBroker.js";
import type { BrokerClient } from "../broker/types.js";

const WS_BASE = "wss://smartapisocket.angelone.in/smart-stream";
const NSE_CM = 1;
const PING = "ping";
const PONG = "pong";

/**
 * LTP packet (mode 1): paise as int32 LE at offset 43 (SmartAPI WebSocket 2.0 docs).
 */
function parseLtpFromPacket(buf: Buffer): { token: string; ltp: number } | null {
  if (buf.length < 47) return null;
  const mode = buf.readUInt8(0);
  if (mode !== 1) return null;
  const tokenBytes = buf.subarray(2, 27);
  const z = tokenBytes.indexOf(0);
  const token = tokenBytes
    .subarray(0, z >= 0 ? z : tokenBytes.length)
    .toString("utf8")
    .trim();
  if (!token) return null;
  const paise = buf.readInt32LE(43);
  const ltp = paise / 100;
  return Number.isFinite(ltp) && ltp > 0 ? { token, ltp } : null;
}

class AngelMarketLtpStream {
  private readonly ltpByToken = new Map<string, number>();
  private tokenToTicker = new Map<string, string>();
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectMs = env.marketWsReconnectBaseMs;
  private tickersKey = "";
  private activeCreds:
    | {
        jwt: string;
        feedToken: string;
        apiKey: string;
        clientCode: string;
      }
    | null = null;

  constructor(private readonly broker: AngelOneBroker) {}

  getLtp(ticker: string): number | undefined {
    const t = ticker.replace(/-EQ$/i, "").toUpperCase();
    for (const [tok, u] of this.tokenToTicker) {
      if (u === t) {
        const p = this.ltpByToken.get(tok);
        if (p !== undefined) return p;
      }
    }
    return undefined;
  }

  async syncWatchlist(tickers: string[]): Promise<void> {
    const uniq = [...new Set(tickers.map((t) => t.replace(/-EQ$/i, "").trim()))].filter(
      Boolean
    );
    const key = uniq.sort().join(",");
    if (key === this.tickersKey && this.ws) {
      const s = this.ws.readyState;
      if (s === WebSocket.OPEN || s === WebSocket.CONNECTING) return;
    }
    this.tickersKey = key;

    await this.broker.refreshSessionIfNeeded();
    const creds = await this.broker.getMarketStreamCredentials();
    if (!creds) {
      console.warn("[market-ws] no credentials (feed token) — LTP stream disabled");
      return;
    }
    this.activeCreds = creds;

    this.tokenToTicker.clear();
    for (const t of uniq) {
      const { symboltoken } = await this.broker.resolveEquitySymbolToken(t);
      this.tokenToTicker.set(String(symboltoken), t.toUpperCase());
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.openSocket(creds);
  }

  private openSocket(creds: {
    jwt: string;
    feedToken: string;
    apiKey: string;
    clientCode: string;
  }): void {
    const { feedToken, apiKey, clientCode } = creds;
    const q = new URLSearchParams({
      clientCode,
      feedToken,
      apiKey,
    });
    const url = `${WS_BASE}?${q.toString()}`;
    // Server-side clients: query auth (same as browser clients per SmartAPI WebSocket2 doc).
    // Some SDKs also send header auth; query-only keeps Bun/TS `WebSocket` construction portable.
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.reconnectMs = env.marketWsReconnectBaseMs;
      const tokens = [...this.tokenToTicker.keys()];
      const mode = Math.min(3, Math.max(1, env.marketWsSubscriptionMode));
      for (let i = 0; i < tokens.length; i += env.marketWsMaxTokensPerBatch) {
        const batch = tokens.slice(i, i + env.marketWsMaxTokensPerBatch);
        const msg = {
          correlationID: `s${i}-${Date.now()}`,
          action: 1,
          params: {
            mode,
            tokenList: [{ exchangeType: NSE_CM, tokens: batch }],
          },
        };
        ws.send(JSON.stringify(msg));
      }
    });

    ws.addEventListener("message", (ev: MessageEvent) => {
      if (typeof ev.data === "string") {
        if (ev.data === PING) ws.send(PONG);
        return;
      }
      const buf = Buffer.from(ev.data as ArrayBuffer);
      const parsed = parseLtpFromPacket(buf);
      if (parsed) this.ltpByToken.set(parsed.token, parsed.ltp);
    });

    ws.addEventListener("close", () => {
      if (this.ws === ws) this.ws = null;
      this.scheduleReconnect();
    });
    ws.addEventListener("error", () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
  }

  private scheduleReconnect(): void {
    if (!this.activeCreds) return;
    if (this.reconnectTimer) return;
    const delay = this.reconnectMs;
    this.reconnectMs = Math.min(
      env.marketWsMaxReconnectMs,
      Math.floor(this.reconnectMs * 1.5)
    );
    const c = this.activeCreds;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
      this.openSocket(c);
    }, delay);
  }
}

let instance: AngelMarketLtpStream | null = null;

/**
 * SmartAPI market WebSocket LTP cache (NSE cash). Stub / missing feed token → no-op.
 *
 * **ExecutionEngine touchpoint:** `checkLiveExits` receives `lastLtp` from here (via
 * `getLastLtpFromStream`) so stop/target checks use an effective intrabar range that includes
 * the latest print, not only the last closed 1m bar’s high/low.
 */
export async function ensureMarketLtpStream(
  broker: BrokerClient,
  tickers: string[]
): Promise<void> {
  if (!env.marketWsEnabled) return;
  if (!(broker instanceof AngelOneBroker)) return;
  if (!instance) instance = new AngelMarketLtpStream(broker);
  await instance.syncWatchlist(tickers);
}

export function getLastLtpFromStream(ticker: string): number | undefined {
  return instance?.getLtp(ticker);
}
