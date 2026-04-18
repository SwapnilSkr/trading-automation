import { env } from "../config/env.js";
import type { BrokerClient } from "./types.js";
import { AngelOneBroker } from "./angelOneBroker.js";
import { AngelOneStubBroker } from "./angelOneStub.js";

/** Use SmartAPI when API key, client code, PIN, and TOTP seed are set. */
export function createBroker(): BrokerClient {
  const fullCreds =
    env.angelApiKey &&
    env.angelClientCode &&
    env.angelPassword &&
    env.totpSeed;

  if (fullCreds) {
    return new AngelOneBroker();
  }

  console.warn(
    "[Broker] Angel SmartAPI credentials incomplete — using stub (set ANGEL_API_KEY, ANGEL_CLIENT_CODE, ANGEL_PASSWORD, TOTP_SEED)"
  );
  return new AngelOneStubBroker();
}
