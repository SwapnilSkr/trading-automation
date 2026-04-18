import { env } from "../config/env.js";
import type { Ohlc1m } from "../types/domain.js";
import type { BrokerClient, BrokerPosition } from "./types.js";

/**
 * Angel One SmartAPI integration placeholder.
 * Wire real REST/WebSocket calls using official SDK when credentials are available.
 */
export class AngelOneStubBroker implements BrokerClient {
  private authed = false;

  async authenticate(): Promise<void> {
    if (!env.angelApiKey || !env.totpSeed) {
      console.warn(
        "[AngelOneStub] Missing ANGEL_API_KEY / TOTP_SEED — skipping live auth"
      );
    }
    this.authed = true;
  }

  async refreshSessionIfNeeded(): Promise<void> {
    await this.authenticate();
  }

  async fetchIntradayOhlc1m(
    _ticker: string,
    _from: Date,
    _to: Date
  ): Promise<Ohlc1m[]> {
    /** Replace with historical API; empty allows scheduler to run without data */
    return [];
  }

  async placePaperOrder(input: {
    ticker: string;
    side: "BUY" | "SELL";
    qty: number;
    strategy: string;
  }): Promise<{ orderId: string }> {
    const id = `paper-${Date.now()}-${input.ticker}`;
    console.log("[AngelOneStub] PAPER order", { ...input, orderId: id });
    return { orderId: id };
  }

  async closeIntraday(ticker: string): Promise<void> {
    console.log("[AngelOneStub] square-off", ticker);
  }

  async listOpenPositions(): Promise<BrokerPosition[]> {
    return [];
  }
}
