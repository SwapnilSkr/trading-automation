import type { Ohlc1m } from "../types/domain.js";

/** Parsed row from SmartAPI `market/v1/quote` FULL mode (field names vary by API version). */
export interface MarketQuoteFullRow {
  ticker: string;
  open?: number;
  /** Previous close (gap reference) */
  close?: number;
  ltp?: number;
  tradeVolume?: number;
  tradingSymbol?: string;
  symbolToken?: string;
}

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
  /** Bulk LTP/OHLC (≤50 tokens per HTTP call); stub returns [] */
  fetchMarketQuotesFull(tickers: string[]): Promise<MarketQuoteFullRow[]>;
  placePaperOrder(input: {
    ticker: string;
    side: "BUY" | "SELL";
    qty: number;
    strategy: string;
  }): Promise<{ orderId: string }>;
  closeIntraday(ticker: string): Promise<void>;
  listOpenPositions(): Promise<BrokerPosition[]>;
}
