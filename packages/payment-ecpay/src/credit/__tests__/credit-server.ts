import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { decryptData, encryptData } from "../../ecpg/aes.js";
import {
  ECPAY_CREDIT_PATHS,
  type EcpayCreditQueryConfig,
  ECPAY_SANDBOX_GATEWAY,
} from "../config.js";

/**
 * MSW host for the credit queries. Uses the published 閘道商 stage credentials so the
 * fixtures recorded from that merchant decrypt with the same keys the live suite uses.
 */
export const BASE = "https://ecpayment-credit.test";
export const MERCHANT = ECPAY_SANDBOX_GATEWAY.merchantId;
export const HASH_KEY = ECPAY_SANDBOX_GATEWAY.hashKey;
export const HASH_IV = ECPAY_SANDBOX_GATEWAY.hashIv;

export const DETAIL_URL = `${BASE}${ECPAY_CREDIT_PATHS.creditDetailQueryTrade}`;
export const CARD_INFO_URL = `${BASE}${ECPAY_CREDIT_PATHS.queryCardInfo}`;

export const config: EcpayCreditQueryConfig = {
  merchantId: MERCHANT,
  hashKey: HASH_KEY,
  hashIv: HASH_IV,
  baseUrl: BASE,
};

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

/** Capture the decrypted request body a handler received. */
export function capture(url: string, data: Record<string, unknown>) {
  const seen: { body?: Record<string, unknown> } = {};
  server.use(
    http.post(url, async ({ request }) => {
      seen.body = await readRequestData(request);
      return HttpResponse.json(envelope(data));
    }),
  );
  return seen;
}

export const server = setupServer();
