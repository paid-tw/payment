import { setupServer } from "msw/node";
import type { NewebpayProviderConfig } from "../../config.js";
import { decryptTradeInfo, encryptTradeInfo } from "../../crypto.js";
import { createNewebpayPeriodProvider } from "../provider.js";

/**
 * Fixed host + test credentials for the 定期定額 MSW handlers.
 *
 * The credentials are the NDNP-1.0.7 manual's own sandbox shop (public
 * documentation values) so the manual's encrypted response blobs replay
 * verbatim as fixtures.
 */
export const BASE = "https://newebpay-period.test";
export const MERCHANT = "TEK1682407426";
export const KEY = "IaWudQJsuOT994cpHRWzv7Ge67yC1cE3"; // 32 bytes
export const IV = "C1dLm3nxZRVlmBSP"; // 16 bytes

export const ALTER_STATUS_URL = `${BASE}/MPG/period/AlterStatus`;
export const ALTER_AMT_URL = `${BASE}/MPG/period/AlterAmt`;

export const server = setupServer();

/** A period provider pointed at the mocked host. */
export function testPeriodProvider(overrides: Partial<NewebpayProviderConfig> = {}) {
  return createNewebpayPeriodProvider({
    merchantId: MERCHANT,
    hashKey: KEY,
    hashIv: IV,
    baseUrl: BASE,
    ...overrides,
  });
}

/** Parse a captured envelope request (`MerchantID_` + `PostData_`). */
export function parseEnvelopeRequest(bodyText: string) {
  const form = new URLSearchParams(bodyText);
  const postData = form.get("PostData_") ?? "";
  return {
    merchantId: form.get("MerchantID_"),
    params: Object.fromEntries(new URLSearchParams(decryptTradeInfo(postData, KEY, IV)).entries()),
  };
}

/** Encrypt a decrypted payload the way the gateway builds `Period`. */
export function encryptPeriod(payload: string): string {
  return encryptTradeInfo(payload, KEY, IV);
}
