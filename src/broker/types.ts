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
  /** Per day (index / equity) */
  upperCircuit?: number;
  lowerCircuit?: number;
  week52High?: number;
  week52Low?: number;
  totBuyQuan?: number;
  totSellQuan?: number;
}

export interface BrokerPosition {
  ticker: string;
  qty: number;
  side: "LONG" | "SHORT";
  avgPrice: number;
}

/** Parsed SmartAPI getRMS payload (amounts in INR) */
export interface BrokerRmsSnapshot {
  net: number;
  availableCash: number;
}

export interface BrokerClient {
  authenticate(): Promise<void>;
  refreshSessionIfNeeded(): Promise<void>;
  fetchIntradayOhlc1m(ticker: string, from: Date, to: Date): Promise<Ohlc1m[]>;
  /** Daily bars (ONE_DAY) for performance scoring; stub returns [] */
  fetchDailyOhlc(ticker: string, from: Date, to: Date): Promise<Ohlc1m[]>;
  /** Bulk LTP/OHLC (≤50 tokens per HTTP call); stub returns [] */
  fetchMarketQuotesFull(tickers: string[]): Promise<MarketQuoteFullRow[]>;
  /** Angel getRMS — funds / margin; stub returns null */
  fetchRmsSnapshot(): Promise<BrokerRmsSnapshot | null>;
  placePaperOrder(input: {
    ticker: string;
    side: "BUY" | "SELL";
    qty: number;
    strategy: string;
    /** LIMIT / SL (LIVE + optional PAPER sim); default MARKET */
    orderKind?: "MARKET" | "LIMIT" | "SL" | "SL-M";
    limitPrice?: number;
    /** SmartAPI: ≤20 chars for postback / book traceability */
    orderTag?: string;
    /** PAPER limit-fill sim / aggressive limit: last LTP from market WS (optional) */
    lastLtpHint?: number;
  }): Promise<{ orderId: string; uniqueOrderId?: string }>;
  /** LIVE: SmartAPI `modifyOrder` (no-op in stub) */
  modifyOrder?(input: {
    variety?: string;
    orderid: string;
    tradingsymbol: string;
    symboltoken: string;
    ordertype: string;
    producttype: string;
    transactiontype: "BUY" | "SELL";
    price: number;
    quantity: number;
  }): Promise<unknown>;
  closeIntraday(ticker: string): Promise<void>;
  listOpenPositions(): Promise<BrokerPosition[]>;
  /** LIVE Angel: day order book (used for poll reconciliation) */
  getOrderBook?(): Promise<Record<string, unknown>[]>;
  getOrderDetails?(uniqueOrderId: string): Promise<Record<string, unknown> | null>;
  /**
   * JWT + feed token + client identity for SmartAPI market WebSocket 2.0
   * (`wss://smartapisocket.angelone.in/smart-stream`).
   */
  getMarketStreamCredentials?(): Promise<{
    jwt: string;
    feedToken: string;
    apiKey: string;
    clientCode: string;
  } | null>;
}
