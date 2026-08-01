import type { ProviderRuntimeConfig } from "@paid-tw/payment";

/**
 * Credit-query endpoints live on `ecpayment`, the same host as 幕後取號 and 幕後授權.
 *
 * @see https://developers.ecpay.com.tw/45925
 */
export const ECPAY_CREDIT_ORIGINS = {
  sandbox: "https://ecpayment-stage.ecpay.com.tw",
  production: "https://ecpayment.ecpay.com.tw",
} as const;

export const ECPAY_CREDIT_PATHS = {
  /**
   * 查詢信用卡單筆明細紀錄. Documented **twice** — as ECPG doc 9088 and 幕後授權 doc
   * 45925 — pointing at the same endpoint, so one implementation serves both.
   */
  creditDetailQueryTrade: "/1.0.0/CreditDetail/QueryTrade",
  /** 查詢信用卡發卡行. Note the path segment is `/Credit/`, not `/Cashier/`. */
  queryCardInfo: "/1.0.0/Credit/QueryCardInfo",
} as const;

/**
 * Credentials + host selection for the credit queries.
 *
 * `baseUrl` here means **the `ecpayment` origin**, which matters when reusing a
 * provider config: the 幕後授權 adapter already talks to `ecpayment`, so its `baseUrl`
 * can be passed straight through, but the 站內付 2.0 adapter's `baseUrl` points at
 * `ecpg` and must **not** be forwarded.
 */
export interface EcpayCreditQueryConfig extends ProviderRuntimeConfig {
  platformId?: string;
}

export function resolveCreditOrigin(config: { baseUrl?: string; sandbox?: boolean }): string {
  if (config.baseUrl) return config.baseUrl.replace(/\/+$/, "");
  return (config.sandbox ? ECPAY_CREDIT_ORIGINS.sandbox : ECPAY_CREDIT_ORIGINS.production).replace(
    /\/+$/,
    "",
  );
}

/**
 * ECPay's **third** public stage merchant: the 閘道商 (gateway) account, published in
 * doc 45895. Not secrets.
 *
 * Required for {@link import("./queries.js").queryEcpayCardInfo} — 查詢發卡行 is
 * 閘道商-only («本功能限閘道商可以申請使用»), and the ordinary stage merchants get
 * `RtnCode 5000095 "Only support gateway merchantID"`. Verified 2026-08-01.
 *
 * | Field | Value |
 * | --- | --- |
 * | MerchantID | `3085779` |
 * | HashKey | `y6869NBszTuvhSRx` |
 * | HashIV | `BMm7FmX91dE8rpdw` |
 * | 後台帳號 | `gatewaytest02` / `test1234` |
 *
 * Never use in production.
 */
export const ECPAY_SANDBOX_GATEWAY = {
  merchantId: "3085779",
  hashKey: "y6869NBszTuvhSRx",
  hashIv: "BMm7FmX91dE8rpdw",
  sandbox: true as const,
} as const;
