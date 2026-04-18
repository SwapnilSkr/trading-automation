import type { Ohlc1m } from "../types/domain.js";

export interface BrokerPosition {
  ticker: string;
  qty: number;
  side: "LONG" | "SHORT";
  avgPrice: number;
}

export interface BrokerClient {
  authenticate(): Promise<void>;
  refreshSessionIfNeeded(): Promise<void>;
  fetchIntradayOhlc1m(ticker: string, from: Date, to: Date): Promise<Ohlc1m[]>;
  /** Daily bars (ONE_DAY) for performance scoring; stub returns [] */
  fetchDailyOhlc(ticker: string, from: Date, to: Date): Promise<Ohlc1m[]>;
  placePaperOrder(input: {
    ticker: string;
    side: "BUY" | "SELL";
    qty: number;
    strategy: string;
  }): Promise<{ orderId: string }>;
  closeIntraday(ticker: string): Promise<void>;
  listOpenPositions(): Promise<BrokerPosition[]>;
}
