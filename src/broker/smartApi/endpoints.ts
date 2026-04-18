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
  getPosition: "/rest/secure/angelbroking/order/v1/getPosition",
  getCandleData: "/rest/secure/angelbroking/historical/v1/getCandleData",
  searchScrip: "/rest/secure/angelbroking/order/v1/searchScrip",
} as const;
