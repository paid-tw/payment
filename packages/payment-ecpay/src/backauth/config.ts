import type { ProviderRuntimeConfig } from "@paid-tw/payment";

/**
 * 信用卡幕後授權 hosts — the same origin as 非信用卡幕後取號, a sibling product on
 * ECPay's `ecpayment` gateway (distinct from AIO's `payment` and ECPG's `ecpg`).
 *
 * @see https://developers.ecpay.com.tw/45876
 */
export const ECPAY_BACKAUTH_ORIGINS = {
  sandbox: "https://ecpayment-stage.ecpay.com.tw",
  production: "https://ecpayment.ecpay.com.tw",
} as const;

export const ECPAY_BACKAUTH_PATHS = {
  /** 信用卡卡號交易授權 — takes a raw PAN. */
  backAuth: "/1.0.0/Cashier/BackAuth",
  /** 查詢訂單. */
  queryTrade: "/1.0.0/Cashier/QueryTrade",
  /**
   * 信用卡請退款 (關帳 / 退刷 / 取消 / 放棄).
   *
   * ⚠️ **Production only.** ECPay states outright that the stage environment cannot
   * provide a real authorization and therefore does not expose this endpoint
   * (「測試環境：因無法提供實際授權，故無法使用此API」), so the adapter refuses to call
   * it against a sandbox origin rather than letting it 404.
   */
  creditDoAction: "/1.0.0/Credit/DoAction",
} as const;

export interface EcpayBackAuthProviderConfig extends ProviderRuntimeConfig {
  /** Optional PlatformID for partner platforms / 閘道商. */
  platformId?: string;
}

export function resolveBackAuthOrigin(config: { baseUrl?: string; sandbox?: boolean }): string {
  if (config.baseUrl) return config.baseUrl.replace(/\/+$/, "");
  return (
    config.sandbox ? ECPAY_BACKAUTH_ORIGINS.sandbox : ECPAY_BACKAUTH_ORIGINS.production
  ).replace(/\/+$/, "");
}

/**
 * ECPay's **second** public stage merchant, the one with 3D verification switched
 * **off** (doc 45895). Published by ECPay, not secrets.
 *
 * Needed because {@link import("../config.js").ECPAY_SANDBOX} (3002607) has 3D on,
 * so every BackAuth call there returns a `ThreeDURL` and never a direct
 * authorization — you cannot exercise the settled path with it.
 *
 * | Field | Value |
 * | --- | --- |
 * | MerchantID | `2000132` |
 * | HashKey | `5294y06JbISpM5x9` |
 * | HashIV | `v77hoKGq4kWxNNIS` |
 * | 統編 | `53538851` |
 * | 後台帳號 | `stagetest1234` / `test1234` |
 *
 * Never use in production.
 */
export const ECPAY_SANDBOX_NO_3D = {
  merchantId: "2000132",
  hashKey: "5294y06JbISpM5x9",
  hashIv: "v77hoKGq4kWxNNIS",
  sandbox: true as const,
} as const;

/**
 * ECPay's published stage test card (doc 45895). Not a real card.
 *
 * `CardValidMM`/`YY` must be **later than the current month**, so tests should
 * generate them rather than hard-coding a year that will expire.
 *
 * ⚠️ This number **fails the Luhn check**, which is why the adapter validates only
 * length and digits — adding a Luhn guard would reject ECPay's own test card.
 */
export const ECPAY_TEST_CARD = {
  cardNo: "4311952222222222",
  cvv: "222",
} as const;
