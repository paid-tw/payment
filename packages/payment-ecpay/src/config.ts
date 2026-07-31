import type { ProviderRuntimeConfig } from "@paid-tw/payment";

/**
 * ECPay payment gateway hosts (All-in-One Cashier).
 * Selected by `sandbox` / `baseUrl` on the provider config.
 */
export const ECPAY_ORIGINS = {
  sandbox: "https://payment-stage.ecpay.com.tw",
  production: "https://payment.ecpay.com.tw",
} as const;

/**
 * Runtime config for {@link import("./provider.js").createEcpayProvider}.
 * Extends the shared {@link ProviderRuntimeConfig} with ECPay-only fields.
 */
export interface EcpayProviderConfig extends ProviderRuntimeConfig {
  /**
   * 商家檢查碼 — required for {@link import("./provider.js").EcpayProvider.queryCreditTrade}.
   * Found in vendor console: 信用卡收單 → 信用卡授權資訊.
   */
  creditCheckCode?: string | number;
}

/**
 * ECPay's **public shared stage merchant** for payment integration tests.
 *
 * Published by ECPay for "模擬銀行 3D 驗證 / 中租無卡分期" testing — these are
 * not secrets. Safe to embed in fixtures and default live tests.
 *
 * | Field | Value |
 * | --- | --- |
 * | MerchantID | `3002607` |
 * | HashKey | `pwFHCqoQZGmho4w6` |
 * | HashIV | `EkRm7iFT261dpevs` |
 * | 統編 | `00000000` |
 * | 後台帳號 | `stagetest3` / `test1234` (vendor portal only; not used by the SDK) |
 *
 * Manual card test (stage cashier): `4311-9522-2222-2222`, 3D OTP `1234`.
 *
 * Never use these credentials in production.
 */
export const ECPAY_SANDBOX = {
  merchantId: "3002607",
  hashKey: "pwFHCqoQZGmho4w6",
  hashIv: "EkRm7iFT261dpevs",
  sandbox: true as const,
} as const;

/** Vendor-portal login for the public stage merchant (human QA only). */
export const ECPAY_SANDBOX_PORTAL = {
  merchantId: ECPAY_SANDBOX.merchantId,
  taxId: "00000000",
  username: "stagetest3",
  password: "test1234",
  /** Stage vendor portal (login in a browser; not an API credential). */
  portalUrl: "https://vendor-stage.ecpay.com.tw",
} as const;

/**
 * Resolve the gateway origin. `baseUrl` wins (MSW / custom hosts); otherwise
 * `sandbox` selects stage vs production.
 */
export function resolveEcpayOrigin(config: {
  baseUrl?: string;
  sandbox?: boolean;
}): string {
  if (config.baseUrl) return config.baseUrl.replace(/\/+$/, "");
  return (config.sandbox ? ECPAY_ORIGINS.sandbox : ECPAY_ORIGINS.production).replace(
    /\/+$/,
    "",
  );
}
