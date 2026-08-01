import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { decryptData, encryptData } from "../../ecpg/aes.js";
import {
  ECPAY_BACKAUTH_PATHS,
  ECPAY_SANDBOX_NO_3D,
  type EcpayBackAuthProviderConfig,
  ECPAY_TEST_CARD,
} from "../config.js";
import { createEcpayBackAuthProvider } from "../provider.js";

/**
 * MSW host for offline BackAuth tests. Credentials match
 * {@link ECPAY_SANDBOX_NO_3D} (ECPay's public no-3D stage merchant) so recorded
 * fixtures decrypt with the same keys the live suite uses.
 */
export const BASE = "https://ecpayment-backauth.test";
export const MERCHANT = ECPAY_SANDBOX_NO_3D.merchantId;
export const HASH_KEY = ECPAY_SANDBOX_NO_3D.hashKey;
export const HASH_IV = ECPAY_SANDBOX_NO_3D.hashIv;

export const AUTH_URL = `${BASE}${ECPAY_BACKAUTH_PATHS.backAuth}`;
export const QUERY_URL = `${BASE}${ECPAY_BACKAUTH_PATHS.queryTrade}`;
export const DOACTION_URL = `${BASE}${ECPAY_BACKAUTH_PATHS.creditDoAction}`;

export function envelope(data: Record<string, unknown>, transCode = 1) {
  return {
    MerchantID: MERCHANT,
    RpHeader: { Timestamp: 1_785_547_600 },
    TransCode: transCode,
    TransMsg: transCode === 1 ? "Success" : "fail",
    Data: encryptData(data, HASH_KEY, HASH_IV),
  };
}

export async function readRequestData(request: Request): Promise<Record<string, unknown>> {
  const body = (await request.json()) as { Data?: string };
  return decryptData<Record<string, unknown>>(body.Data ?? "", HASH_KEY, HASH_IV);
}

export function respondWith(url: string, data: Record<string, unknown>) {
  return http.post(url, () => HttpResponse.json(envelope(data)));
}

export const server = setupServer();

/** Offline provider. `sandbox` is left unset so DoAction is reachable in tests. */
export function testProvider(overrides: Partial<EcpayBackAuthProviderConfig> = {}) {
  return createEcpayBackAuthProvider({
    merchantId: MERCHANT,
    hashKey: HASH_KEY,
    hashIv: HASH_IV,
    baseUrl: BASE,
    ...overrides,
  });
}

/** Provider pointed at the real no-3D stage merchant (live tests). */
export function stageProvider(overrides: Partial<EcpayBackAuthProviderConfig> = {}) {
  return createEcpayBackAuthProvider({ ...ECPAY_SANDBOX_NO_3D, ...overrides });
}

/**
 * ECPay's test card with an expiry that is always in the future — the docs require
 * MM/YYYY later than "now", so a hard-coded year would silently start failing.
 */
export function testCard() {
  const year = new Date().getUTCFullYear() + 4;
  return {
    cardNo: ECPAY_TEST_CARD.cardNo,
    expiryMonth: "12",
    expiryYear: String(year % 100).padStart(2, "0"),
    cvv: ECPAY_TEST_CARD.cvv,
  };
}
