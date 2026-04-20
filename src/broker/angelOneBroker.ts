import { DateTime } from "luxon";
import { env } from "../config/env.js";
import type { Ohlc1m } from "../types/domain.js";
import type {
  BrokerClient,
  BrokerPosition,
  MarketQuoteFullRow,
} from "./types.js";
import { SmartApiPaths } from "./smartApi/endpoints.js";
import { SmartApiHttp, decodeJwtExpMs, type SmartApiJson } from "./smartApi/http.js";
import { generateTotpCode } from "./smartApi/totp.js";
import { IST } from "../time/ist.js";

interface LoginData {
  jwtToken?: string;
  refreshToken?: string;
  feedToken?: string;
}

interface ScripRow {
  exchange?: string;
  tradingsymbol?: string;
  symboltoken?: string;
}

/**
 * NSE cash indices are not `*-EQ` equities; `searchScrip` + `-EQ` pick fails for them.
 * Tokens from Angel OpenAPIScripMaster / forum (e.g. NIFTY 50 → 99926000). Volume is often 0.
 */
const NSE_INDEX_RESOLUTION: Record<
  string,
  { symboltoken: string; tradingsymbol: string }
> = {
  NIFTY50: { symboltoken: "99926000", tradingsymbol: "NIFTY 50" },
  NIFTY: { symboltoken: "99926000", tradingsymbol: "NIFTY 50" },
};

/**
 * Angel One SmartAPI (REST) — aligns with official docs and JS SDK routes:
 * https://smartapi.angelone.in/docs
 * https://github.com/angel-one/smartapi-javascript/blob/main/config/api.js
 *
 * Auth is **loginByPassword** (client code + PIN + TOTP). No browser redirect.
 */
export class AngelOneBroker implements BrokerClient {
  private readonly http: SmartApiHttp;
  private jwt: string | null = null;
  private refreshToken: string | null = null;
  private jwtExpMs: number | undefined;
  private readonly symbolCache = new Map<
    string,
    { symboltoken: string; tradingsymbol: string }
  >();
  private positionsCache:
    | { atMs: number; rows: BrokerPosition[] }
    | undefined;

  constructor() {
    this.http = new SmartApiHttp(
      env.angelApiKey,
      env.angelClientLocalIp,
      env.angelClientPublicIp,
      env.angelMacAddress
    );
  }

  async authenticate(): Promise<void> {
    if (!env.angelApiKey || !env.angelClientCode || !env.angelPassword) {
      throw new Error(
        "Angel SmartAPI: set ANGEL_API_KEY, ANGEL_CLIENT_CODE, ANGEL_PASSWORD"
      );
    }
    if (!env.totpSeed) {
      throw new Error(
        "Angel SmartAPI: set TOTP_SEED (base32 from Enable TOTP in Angel app)"
      );
    }

    const totp = generateTotpCode(env.totpSeed);
    const res = await this.http.post(
      SmartApiPaths.login,
      {
        clientcode: env.angelClientCode,
        password: env.angelPassword,
        totp,
      },
      null
    );

    this.applyLoginResponse(res);
  }

  async refreshSessionIfNeeded(): Promise<void> {
    const skew = 120_000;
    if (
      this.jwt &&
      this.jwtExpMs !== undefined &&
      Date.now() < this.jwtExpMs - skew
    ) {
      return;
    }
    if (this.refreshToken) {
      const res = await this.http.post(
        SmartApiPaths.generateToken,
        { refreshToken: this.refreshToken },
        null
      );
      if (res.status === true && res.data) {
        this.applyLoginResponse(res);
        return;
      }
    }
    await this.authenticate();
  }

  private applyLoginResponse(res: SmartApiJson): void {
    if (res.status !== true || !res.data || typeof res.data !== "object") {
      const msg =
        typeof res.message === "string"
          ? res.message
          : JSON.stringify(res).slice(0, 300);
      throw new Error(`Angel login failed: ${msg}`);
    }
    const d = res.data as LoginData;
    if (!d.jwtToken) {
      throw new Error("Angel login: missing jwtToken in response");
    }
    this.jwt = d.jwtToken;
    this.refreshToken = d.refreshToken ?? this.refreshToken;
    this.jwtExpMs = decodeJwtExpMs(d.jwtToken);
  }

  private async authorized(): Promise<string> {
    await this.refreshSessionIfNeeded();
    if (!this.jwt) throw new Error("Angel: not authenticated");
    return this.jwt;
  }

  async fetchIntradayOhlc1m(
    ticker: string,
    from: Date,
    to: Date
  ): Promise<Ohlc1m[]> {
    const token = await this.authorized();
    const { symboltoken, tradingsymbol } = await this.resolveEquitySymbol(
      ticker,
      token
    );

    const zone = IST;
    let cursor = DateTime.fromJSDate(from, { zone }).startOf("minute");
    const end = DateTime.fromJSDate(to, { zone }).endOf("minute");
    const all: Ohlc1m[] = [];

    while (cursor <= end) {
      const chunkEnd = DateTime.min(
        cursor.plus({ days: 1 }).startOf("day").minus({ minutes: 1 }),
        end
      );
      const fromStr = cursor.toFormat("yyyy-MM-dd HH:mm");
      const toStr = chunkEnd.toFormat("yyyy-MM-dd HH:mm");

      const res = await this.http.post(
        SmartApiPaths.getCandleData,
        {
          exchange: env.angelExchange,
          symboltoken,
          interval: "ONE_MINUTE",
          fromdate: fromStr,
          todate: toStr,
        },
        token
      );

      if (res.status !== true) {
        const msg =
          typeof res.message === "string" ? res.message : JSON.stringify(res);
        console.warn(`[Angel] getCandleData ${fromStr}–${toStr}: ${msg}`);
      } else {
        all.push(...parseCandlePayload(res.data, ticker, tradingsymbol));
      }

      if (env.angelApiThrottleMs > 0) {
        await new Promise((r) => setTimeout(r, env.angelApiThrottleMs));
      }

      cursor = chunkEnd.plus({ minutes: 1 });
    }

    return dedupeSortOhlc(all);
  }

  /**
   * Single `getCandleData` call for ONE_DAY (minimizes requests vs minute walk).
   */
  async fetchDailyOhlc(
    ticker: string,
    from: Date,
    to: Date
  ): Promise<Ohlc1m[]> {
    const token = await this.authorized();
    const { symboltoken, tradingsymbol } = await this.resolveEquitySymbol(
      ticker,
      token
    );
    const zone = IST;
    const fromStr = DateTime.fromJSDate(from, { zone })
      .startOf("day")
      .toFormat("yyyy-MM-dd HH:mm");
    const toStr = DateTime.fromJSDate(to, { zone })
      .endOf("day")
      .toFormat("yyyy-MM-dd HH:mm");

    const res = await this.http.post(
      SmartApiPaths.getCandleData,
      {
        exchange: env.angelExchange,
        symboltoken,
        interval: "ONE_DAY",
        fromdate: fromStr,
        todate: toStr,
      },
      token
    );

    if (res.status !== true) {
      const msg =
        typeof res.message === "string" ? res.message : JSON.stringify(res);
      console.warn(
        `[Angel] getCandleData ONE_DAY ${ticker} ${fromStr}–${toStr}: ${msg}`
      );
      return [];
    }

    const rows = parseCandlePayload(res.data, ticker, tradingsymbol);
    if (env.angelApiThrottleMs > 0) {
      await new Promise((r) => setTimeout(r, env.angelApiThrottleMs));
    }
    return dedupeSortOhlc(rows);
  }

  async fetchMarketQuotesFull(tickers: string[]): Promise<MarketQuoteFullRow[]> {
    const uniq = [
      ...new Set(
        tickers.map((t) => t.replace(/-EQ$/i, "").trim().toUpperCase())
      ),
    ].filter(Boolean);
    if (uniq.length === 0) return [];

    const token = await this.authorized();
    const tokenToTicker = new Map<string, string>();
    for (const t of uniq) {
      const { symboltoken } = await this.resolveEquitySymbol(t, token);
      tokenToTicker.set(symboltoken, t);
    }

    const tokens = [...tokenToTicker.keys()];
    const batches: string[][] = [];
    for (let i = 0; i < tokens.length; i += 50) {
      batches.push(tokens.slice(i, i + 50));
    }

    const out: MarketQuoteFullRow[] = [];
    for (let bi = 0; bi < batches.length; bi++) {
      const batch = batches[bi]!;
      const res = await this.http.post(
        SmartApiPaths.marketQuote,
        {
          mode: "FULL",
          exchangeTokens: { [env.angelExchange]: batch },
        },
        token
      );

      if (res.status !== true) {
        const msg =
          typeof res.message === "string" ? res.message : JSON.stringify(res);
        console.warn(`[Angel] marketQuote: ${msg}`);
      } else {
        out.push(...parseQuoteFetched(res.data, tokenToTicker));
      }

      if (bi < batches.length - 1 && env.quoteBatchDelayMs > 0) {
        await new Promise((r) => setTimeout(r, env.quoteBatchDelayMs));
      }
    }
    return out;
  }

  private async resolveEquitySymbol(
    baseTicker: string,
    token: string
  ): Promise<{ symboltoken: string; tradingsymbol: string }> {
    const key = `${env.angelExchange}:${baseTicker.toUpperCase()}`;
    const hit = this.symbolCache.get(key);
    if (hit) return hit;

    const baseNorm = baseTicker.replace(/-EQ$/i, "").toUpperCase();
    if (env.angelExchange === "NSE") {
      const idx = NSE_INDEX_RESOLUTION[baseNorm];
      if (idx) {
        const resolved = {
          symboltoken: idx.symboltoken,
          tradingsymbol: idx.tradingsymbol,
        };
        this.symbolCache.set(key, resolved);
        return resolved;
      }
    }

    const res = await this.http.post(
      SmartApiPaths.searchScrip,
      {
        exchange: env.angelExchange,
        searchscrip: baseTicker.replace(/-EQ$/i, ""),
      },
      token
    );

    if (res.status !== true || !Array.isArray(res.data)) {
      throw new Error(
        `Angel searchScrip failed for ${baseTicker}: ${JSON.stringify(res).slice(0, 200)}`
      );
    }

    const rows = res.data as ScripRow[];
    const eq =
      rows.find((r) => r.tradingsymbol?.toUpperCase().endsWith("-EQ")) ??
      rows.find((r) => r.symboltoken && r.tradingsymbol) ??
      rows[0];
    if (!eq?.symboltoken) {
      throw new Error(
        `Angel: no scrip match for ${baseTicker} (try index token in OpenAPIScripMaster if benchmark)`
      );
    }

    const resolved = {
      symboltoken: String(eq.symboltoken),
      tradingsymbol: eq.tradingsymbol ?? baseTicker,
    };
    this.symbolCache.set(key, resolved);
    return resolved;
  }

  async placePaperOrder(input: {
    ticker: string;
    side: "BUY" | "SELL";
    qty: number;
    strategy: string;
  }): Promise<{ orderId: string }> {
    if (env.executionEnv !== "LIVE") {
      const id = `paper-${Date.now()}-${input.ticker}`;
      console.log("[Angel] EXECUTION_ENV!=LIVE — skip exchange order", {
        ...input,
        orderId: id,
      });
      return { orderId: id };
    }

    const token = await this.authorized();
    const { symboltoken, tradingsymbol } = await this.resolveEquitySymbol(
      input.ticker,
      token
    );

    const res = await this.http.post(
      SmartApiPaths.placeOrder,
      {
        variety: "NORMAL",
        tradingsymbol,
        symboltoken,
        transactiontype: input.side,
        exchange: env.angelExchange,
        ordertype: "MARKET",
        producttype: "INTRADAY",
        duration: "DAY",
        quantity: input.qty,
        price: 0,
      },
      token
    );

    if (res.status !== true) {
      const msg =
        typeof res.message === "string" ? res.message : JSON.stringify(res);
      throw new Error(`Angel placeOrder failed: ${msg}`);
    }

    const data = res.data as { orderid?: string; orderId?: string };
    const orderId = String(data?.orderid ?? data?.orderId ?? "");
    if (!orderId) {
      throw new Error(`Angel placeOrder: missing order id in ${JSON.stringify(data)}`);
    }
    return { orderId };
  }

  async closeIntraday(ticker: string): Promise<void> {
    if (env.executionEnv !== "LIVE") {
      console.log("[Angel] EXECUTION_ENV!=LIVE — skip broker square-off", {
        ticker,
      });
      return;
    }
    const token = await this.authorized();
    const positions = await this.listOpenPositionsCached(token);
    const base = ticker.toUpperCase().replace(/-EQ$/i, "");
    const pos = positions.find(
      (p) =>
        p.ticker.toUpperCase().replace(/-EQ$/i, "") === base ||
        p.ticker.toUpperCase() === ticker.toUpperCase()
    );
    if (!pos || pos.qty === 0) return;

    const side: "BUY" | "SELL" = pos.side === "LONG" ? "SELL" : "BUY";
    await this.placePaperOrder({
      ticker: pos.ticker.replace(/-EQ$/i, ""),
      side,
      qty: pos.qty,
      strategy: "SQUARE_OFF",
    });
    // Position state changed; force refresh on the next query.
    this.positionsCache = undefined;
  }

  async listOpenPositions(): Promise<BrokerPosition[]> {
    if (env.executionEnv !== "LIVE") {
      return [];
    }
    const token = await this.authorized();
    return this.listOpenPositionsCached(token);
  }

  private async listOpenPositionsCached(
    token: string
  ): Promise<BrokerPosition[]> {
    const now = Date.now();
    const ttlMs = 10_000;
    if (this.positionsCache && now - this.positionsCache.atMs < ttlMs) {
      return this.positionsCache.rows;
    }
    const rows = await this.listOpenPositionsFromApi(token);
    this.positionsCache = { atMs: now, rows };
    return rows;
  }

  private async listOpenPositionsFromApi(
    token: string
  ): Promise<BrokerPosition[]> {
    const res = await this.http.get(SmartApiPaths.getPosition, token);
    if (res.status !== true || !Array.isArray(res.data)) {
      return [];
    }
    const out: BrokerPosition[] = [];
    for (const row of res.data as Record<string, string>[]) {
      const net = Number(row.netqty ?? row.netQty ?? 0);
      if (!Number.isFinite(net) || net === 0) continue;
      const sym = String(row.tradingsymbol ?? "");
      const avg = Number(row.avgnetprice ?? row.buyavgprice ?? row.avgPrice ?? 0);
      out.push({
        ticker: sym.replace(/-EQ$/i, ""),
        qty: Math.abs(net),
        side: net > 0 ? "LONG" : "SHORT",
        avgPrice: avg,
      });
    }
    return out;
  }
}

function quoteNum(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function extractQuoteFetchedArray(data: unknown): unknown[] {
  if (data === null || typeof data !== "object") return [];
  const d = data as Record<string, unknown>;
  if (Array.isArray(d.fetched)) return d.fetched;
  const inner = d.data;
  if (
    inner !== null &&
    typeof inner === "object" &&
    Array.isArray((inner as Record<string, unknown>).fetched)
  ) {
    return (inner as { fetched: unknown[] }).fetched;
  }
  return [];
}

function parseQuoteFetched(
  data: unknown,
  tokenToTicker: Map<string, string>
): MarketQuoteFullRow[] {
  const fetched = extractQuoteFetchedArray(data);
  const rows: MarketQuoteFullRow[] = [];
  for (const item of fetched) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const st = String(o.symbolToken ?? o.symboltoken ?? "");
    const sym = String(o.tradingSymbol ?? o.tradingsymbol ?? "").replace(
      /-EQ$/i,
      ""
    );
    const ticker = (st && tokenToTicker.get(st)) || sym;
    if (!ticker) continue;
    rows.push({
      ticker,
      open: quoteNum(o.open),
      close: quoteNum(o.close),
      ltp: quoteNum(o.ltp) ?? quoteNum(o.last_traded_price),
      tradeVolume:
        quoteNum(o.tradeVolume) ??
        quoteNum(o.totTrdVol) ??
        quoteNum(o.volume),
      tradingSymbol: String(o.tradingSymbol ?? o.tradingsymbol ?? ""),
      symbolToken: st,
    });
  }
  return rows;
}

function parseCandlePayload(
  data: unknown,
  ticker: string,
  _tradingsymbol: string
): Ohlc1m[] {
  const raw =
    data !== null &&
    typeof data === "object" &&
    "candles" in (data as object) &&
    Array.isArray((data as { candles: unknown }).candles)
      ? (data as { candles: unknown[] }).candles
      : Array.isArray(data)
        ? data
        : [];

  const out: Ohlc1m[] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const ts = new Date(String(row[0]));
    const o = Number(row[1]);
    const h = Number(row[2]);
    const l = Number(row[3]);
    const c = Number(row[4]);
    const v = Number(row[5]);
    if (!Number.isFinite(o + h + l + c)) continue;
    out.push({ ticker, ts, o, h, l, c, v: Number.isFinite(v) ? v : 0 });
  }
  return out;
}

function dedupeSortOhlc(rows: Ohlc1m[]): Ohlc1m[] {
  const map = new Map<number, Ohlc1m>();
  for (const r of rows) {
    map.set(r.ts.getTime(), r);
  }
  return [...map.values()].sort((a, b) => a.ts.getTime() - b.ts.getTime());
}
