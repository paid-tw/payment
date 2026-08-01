import type { ProviderRuntimeConfig } from "@paid-tw/payment";

/**
 * 非信用卡幕後取號 hosts. Note this is a *third* ECPay origin, distinct from both
 * AIO (`payment.ecpay.com.tw`) and 站內付 2.0 (`ecpg.ecpay.com.tw`).
 *
 * @see https://developers.ecpay.com.tw/28005
 */
export const ECPAY_PAYCODE_ORIGINS = {
  sandbox: "https://ecpayment-stage.ecpay.com.tw",
  production: "https://ecpayment.ecpay.com.tw",
} as const;

/**
 * Endpoint paths under {@link ECPAY_PAYCODE_ORIGINS}. All are POST + JSON with the
 * shared AES envelope.
 */
export const ECPAY_PAYCODE_PATHS = {
  /** 幕後取號 — ATM / CVS / BARCODE. */
  genPaymentCode: "/1.0.0/Cashier/GenPaymentCode",
  /** 查詢訂單 — order + payment state. */
  queryTrade: "/1.0.0/Cashier/QueryTrade",
  /** 查詢 ATM/CVS/BARCODE 取號結果 — re-read the code we got at 取號 time. */
  queryPaymentInfo: "/1.0.0/Cashier/QueryPaymentInfo",
  /** 超商代碼轉三段式條碼 — turn a CVS 繳費代碼 into scannable barcode segments. */
  queryCvsBarcode: "/1.0.0/Cashier/QueryCVSBarcode",
  /** 下載撥款對帳檔 — **answers CSV, not the AES envelope**. */
  queryTradeMedia: "/1.0.0/Cashier/QueryTradeMedia",
} as const;

export interface EcpayPayCodeProviderConfig extends ProviderRuntimeConfig {
  /** Optional PlatformID for partner platforms. */
  platformId?: string;
}

/**
 * Resolve the gateway origin. `baseUrl` wins (MSW / custom hosts); otherwise
 * `sandbox` selects stage vs production.
 */
export function resolvePayCodeOrigin(config: { baseUrl?: string; sandbox?: boolean }): string {
  if (config.baseUrl) return config.baseUrl.replace(/\/+$/, "");
  return (
    config.sandbox ? ECPAY_PAYCODE_ORIGINS.sandbox : ECPAY_PAYCODE_ORIGINS.production
  ).replace(/\/+$/, "");
}
