import type { ProviderRuntimeConfig } from "@paid-tw/payment";

/**
 * NewebPay gateway hosts. Only the `c` prefix differs between test and
 * production. Selected by `sandbox` / `baseUrl` on the provider config.
 */
export const NEWEBPAY_ORIGINS = {
  sandbox: "https://ccore.newebpay.com",
  production: "https://core.newebpay.com",
} as const;

/** API paths shared by the MPG and periodic factories (NDNF-1.2.3 / NDNP-1.0.7). */
export const NEWEBPAY_PATHS = {
  /** MPG 交易 [NPA-F01] — browser form post only. */
  mpg: "/MPG/mpg_gateway",
  /** 單筆交易查詢 [NPA-B02]. */
  queryTradeInfo: "/API/QueryTradeInfo",
  /** 取消授權 [NPA-B01]. */
  creditCancel: "/API/CreditCard/Cancel",
  /** 請退款 / 取消請退款 [NPA-B031~34]. */
  creditClose: "/API/CreditCard/Close",
  /** 建立定期定額委託 [NPA-B05] — browser form post (hosted card page). */
  period: "/MPG/period",
  /** 修改委託狀態 [NPA-B051]. */
  periodAlterStatus: "/MPG/period/AlterStatus",
  /** 修改委託內容 [NPA-B052]. */
  periodAlterAmt: "/MPG/period/AlterAmt",
} as const;

/**
 * Runtime config for the NewebPay factories. Same shape as the shared
 * {@link ProviderRuntimeConfig}: `merchantId` + `hashKey` (32 chars) +
 * `hashIv` (16 chars) from the NewebPay 商店資料 page.
 */
export interface NewebpayProviderConfig extends ProviderRuntimeConfig {}

/**
 * Resolve the gateway origin. `baseUrl` wins (MSW / custom hosts); otherwise
 * `sandbox` selects ccore vs core.
 */
export function resolveNewebpayOrigin(config: { baseUrl?: string; sandbox?: boolean }): string {
  if (config.baseUrl) return config.baseUrl.replace(/\/+$/, "");
  return config.sandbox ? NEWEBPAY_ORIGINS.sandbox : NEWEBPAY_ORIGINS.production;
}
