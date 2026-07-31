import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import type { ProviderRuntimeConfig } from "@paid-tw/payment";
import { ECPAY_SANDBOX } from "../config.js";
import { computeCheckMacValue, createEcpayProvider } from "../provider.js";
import {
  QUERY_BAD_MERTRADENO,
  QUERY_NOT_FOUND,
  QUERY_PAID,
  STAGE_PAID_MER_TRADE_NO,
  STAGE_PROBE_MER_TRADE_NO,
} from "./ecpay-fixtures.js";

/**
 * MSW host for offline tests. Credentials match {@link ECPAY_SANDBOX} (ECPay's
 * public stage merchant 3002607) so CheckMacValue goldens and recorded stage
 * fixtures verify with the same keys used on live.
 */
export const BASE = "https://ecpay.test";
export const MERCHANT = ECPAY_SANDBOX.merchantId;
export const HASH_KEY = ECPAY_SANDBOX.hashKey;
export const HASH_IV = ECPAY_SANDBOX.hashIv;

export const QUERY_URL = `${BASE}/Cashier/QueryTradeInfo/V5`;
export const DOACTION_URL = `${BASE}/CreditDetail/DoAction`;
export const AIO_CHECKOUT_URL = `${BASE}/Cashier/AioCheckOut/V5`;

/** Serialize a QueryTradeInfo response and stamp a valid CheckMacValue over it. */
export function queryResponse(fields: Record<string, string>): string {
  const withMac = { ...fields };
  withMac.CheckMacValue = computeCheckMacValue(withMac, HASH_KEY, HASH_IV);
  return new URLSearchParams(withMac).toString();
}

/**
 * Default handlers that mimic stage QueryTradeInfo behaviour for well-known
 * MerchantTradeNo values from recorded fixtures. Per-test `server.use(...)`
 * still overrides these (resetHandlers restores this set after each test).
 */
export const stageQueryHandlers = [
  http.post(QUERY_URL, async ({ request }) => {
    const body = Object.fromEntries(new URLSearchParams(await request.text()).entries());
    const merTradeNo = body.MerchantTradeNo ?? "";

    if (merTradeNo === STAGE_PAID_MER_TRADE_NO) {
      return HttpResponse.text(QUERY_PAID);
    }
    if (merTradeNo === STAGE_PROBE_MER_TRADE_NO) {
      return HttpResponse.text(QUERY_NOT_FOUND);
    }
    if (merTradeNo === "") {
      return HttpResponse.text(QUERY_BAD_MERTRADENO);
    }
    // Unknown order → same shape as stage 10200047 (re-signed with sandbox keys).
    return HttpResponse.text(
      queryResponse({
        CustomField1: "",
        CustomField2: "",
        CustomField3: "",
        CustomField4: "",
        HandlingCharge: "0",
        ItemName: "",
        MerchantID: MERCHANT,
        MerchantTradeNo: merTradeNo,
        PaymentDate: "",
        PaymentType: "",
        PaymentTypeChargeFee: "0",
        StoreID: "",
        TradeAmt: "0",
        TradeDate: "",
        TradeNo: "",
        TradeStatus: "10200047",
      }),
    );
  }),
];

export const server = setupServer(...stageQueryHandlers);

export function testProvider(overrides: Partial<ProviderRuntimeConfig> = {}) {
  return createEcpayProvider({
    merchantId: MERCHANT,
    hashKey: HASH_KEY,
    hashIv: HASH_IV,
    baseUrl: BASE,
    ...overrides,
  });
}

/** Provider pointed at real stage hosts (for live tests). */
export function stageProvider(overrides: Partial<ProviderRuntimeConfig> = {}) {
  return createEcpayProvider({
    merchantId: process.env.ECPAY_MERCHANT_ID ?? ECPAY_SANDBOX.merchantId,
    hashKey: process.env.ECPAY_HASH_KEY ?? ECPAY_SANDBOX.hashKey,
    hashIv: process.env.ECPAY_HASH_IV ?? ECPAY_SANDBOX.hashIv,
    sandbox: true,
    ...overrides,
  });
}
