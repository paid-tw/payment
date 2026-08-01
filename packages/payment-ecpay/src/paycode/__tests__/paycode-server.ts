import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { ECPAY_SANDBOX } from "../../config.js";
import { decryptData, encryptData } from "../../ecpg/aes.js";
import { ECPAY_PAYCODE_PATHS, type EcpayPayCodeProviderConfig } from "../config.js";
import { createEcpayPayCodeProvider } from "../provider.js";

/**
 * MSW host for offline 幕後取號 tests. Credentials match {@link ECPAY_SANDBOX}
 * (ECPay's public stage merchant 3002607) so the AES ciphertexts in recorded
 * fixtures decrypt with the same keys the live tests use.
 */
export const BASE = "https://ecpayment.test";
export const MERCHANT = ECPAY_SANDBOX.merchantId;
export const HASH_KEY = ECPAY_SANDBOX.hashKey;
export const HASH_IV = ECPAY_SANDBOX.hashIv;

export const GEN_URL = `${BASE}${ECPAY_PAYCODE_PATHS.genPaymentCode}`;
export const QUERY_TRADE_URL = `${BASE}${ECPAY_PAYCODE_PATHS.queryTrade}`;
export const QUERY_INFO_URL = `${BASE}${ECPAY_PAYCODE_PATHS.queryPaymentInfo}`;

/** Outer envelope wrapping an already-decrypted business payload. */
export function envelope(data: Record<string, unknown>, transCode = 1) {
  return {
    MerchantID: MERCHANT,
    RpHeader: { Timestamp: 1_754_000_000 },
    TransCode: transCode,
    TransMsg: transCode === 1 ? "Success" : "fail",
    Data: encryptData(data, HASH_KEY, HASH_IV),
  };
}

/** Decrypt a request captured by an MSW handler, so tests can assert on the wire body. */
export async function readRequestData(request: Request): Promise<Record<string, unknown>> {
  const body = (await request.json()) as { Data?: string };
  return decryptData<Record<string, unknown>>(body.Data ?? "", HASH_KEY, HASH_IV);
}

export const server = setupServer();

export function testProvider(overrides: Partial<EcpayPayCodeProviderConfig> = {}) {
  return createEcpayPayCodeProvider({
    merchantId: MERCHANT,
    hashKey: HASH_KEY,
    hashIv: HASH_IV,
    baseUrl: BASE,
    ...overrides,
  });
}

/** Provider pointed at the real stage host (live tests only). */
export function stageProvider(overrides: Partial<EcpayPayCodeProviderConfig> = {}) {
  return createEcpayPayCodeProvider({
    merchantId: process.env.ECPAY_MERCHANT_ID ?? ECPAY_SANDBOX.merchantId,
    hashKey: process.env.ECPAY_HASH_KEY ?? ECPAY_SANDBOX.hashKey,
    hashIv: process.env.ECPAY_HASH_IV ?? ECPAY_SANDBOX.hashIv,
    sandbox: true,
    ...overrides,
  });
}

/** Echo a JSON handler that always answers with the given payload. */
export function respondWith(url: string, data: Record<string, unknown>) {
  return http.post(url, () => HttpResponse.json(envelope(data)));
}
