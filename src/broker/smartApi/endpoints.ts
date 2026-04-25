/**
 * Paths match Angel One’s official JS SDK config:
 * https://github.com/angel-one/smartapi-javascript/blob/main/config/api.js
 * Base URL: https://apiconnect.angelone.in (see SmartAPI docs)
 */
export const SMART_API_ROOT = "https://apiconnect.angelone.in";

export const SmartApiPaths = {
  login: "/rest/auth/angelbroking/user/v1/loginByPassword",
  generateToken: "/rest/auth/angelbroking/jwt/v1/generateTokens",
  logout: "/rest/secure/angelbroking/user/v1/logout",
  placeOrder: "/rest/secure/angelbroking/order/v1/placeOrder",
  modifyOrder: "/rest/secure/angelbroking/order/v1/modifyOrder",
  getOrderBook: "/rest/secure/angelbroking/order/v1/getOrderBook",
  /** Path prefix; append URL-encoded `UniqueOrderId` (GET) */
  orderDetails: "/rest/secure/angelbroking/order/v1/details",
  getPosition: "/rest/secure/angelbroking/order/v1/getPosition",
  /** Funds / margin (RMS) — GET */
  getRms: "/rest/secure/angelbroking/user/v1/getRMS",
  getCandleData: "/rest/secure/angelbroking/historical/v1/getCandleData",
  /** Bulk quote — max ~50 tokens per request, respect ~1 rps */
  marketQuote: "/rest/secure/angelbroking/market/v1/quote",
  searchScrip: "/rest/secure/angelbroking/order/v1/searchScrip",
} as const;
