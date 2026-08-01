/**
 * 中租零卡分期 (Zingala / 中租迪和) — endpoints and credentials.
 *
 * @see 中租零卡分期 API 串接技術手冊 1.1.14 (2023/11). Not a public document; there is
 * no developer portal, so every claim in this package is either cited to a manual
 * version or recorded from UAT — see `__tests__/cassettes/`.
 */

export const ZINGALA_ORIGINS = {
  /** 測試環境 (UAT). */
  sandbox: "https://uatapi.chaileaseholding.com",
  /** 正式環境. */
  production: "https://api.chaileaseholding.com",
} as const;

/**
 * Every path is prefixed `/api_zero_card`.
 *
 * ⚠️ `getFee` moved from `payments/get_fee` to **`vender/get_fee`** in manual 1.1.7
 * (2022/03). "vender" is 中租's spelling, kept so these strings grep to the manual.
 */
export const ZINGALA_PATHS = {
  /** 預約交易 — the e-commerce entry point; returns a URL for the consumer. */
  reserveEc: "/api_zero_card/payments/reserve_ec",
  /** 現場交易 — POS, takes a barcode the consumer shows from the app. */
  reservePos: "/api_zero_card/payments/reserve_pos",
  /** 手動請款. No partial capture. */
  capture: "/api_zero_card/payments/capture",
  /** 取消交易 / 退款. */
  refund: "/api_zero_card/payments/refund",
  /** 查詢交易 — batch, up to 100 ids per call. */
  inquiry: "/api_zero_card/payments/inquiry",
  /** 檢核是否為零卡會員. */
  checkIsMember: "/api_zero_card/customer/check_is_member",
  /** 電商推薦會員資料 — ⚠️ ships consumer profiling data, see the README. */
  recommendMember: "/api_zero_card/customer/recommend_member",
  /** 下載審核通知函 — returns `application/octet-stream`, not JSON. */
  downloadApprovalNotice: "/api_zero_card/vender/download_aprvnotice_pdf",
  /** 查詢期數利率 (manual 1.1.4, moved to `vender/` in 1.1.7). */
  getFee: "/api_zero_card/vender/get_fee",
  /** 取得金融機構代碼表 (manual 1.1.5). */
  getBankBranch: "/api_zero_card/vender/get_bank_branch",
} as const;

export type ZingalaPath = (typeof ZINGALA_PATHS)[keyof typeof ZINGALA_PATHS];

/**
 * Credentials, as 中租 issues them. Three secrets, not four.
 *
 * The manual never states which key signs the `Digest` header — its notify sample only
 * prints `Sample DATA_AESKEY (Secret Key)` underneath the example. Verified against UAT
 * on 2026-08-02: it is {@link ZingalaConfig.aesKey}, so the AES key doubles as the HMAC
 * secret and there is no separate signing key to ask 中租 for.
 */
export interface ZingalaConfig {
  /** `0Card-Merchant-Id` header — 商家編號. */
  merchantId: string;
  /** `0Card-API-Key` header — API 連線金鑰. */
  apiKey: string;
  /** 32 chars. Decrypts `info_customer_json` **and** signs `Digest`. */
  aesKey: string;
  /** 16 chars. */
  aesIv: string;
  /** Use the UAT origin. Ignored when {@link baseUrl} is set. */
  sandbox?: boolean;
  /** Override the origin entirely — e.g. UAT behind an internal proxy. */
  baseUrl?: string;
  /**
   * 總公司/平台商代號 `top_vender_id`, sent on every call that accepts it. Only needed
   * when the 撥款對象 differs from the company behind {@link merchantId}.
   */
  topVenderId?: string;
}

/** 手續費負擔對象: 商家負擔(零利率) or 消費者負擔(利息外加). */
export type ZingalaFeeBearer = "vendor" | "consumer";

export function resolveZingalaOrigin(config: ZingalaConfig): string {
  if (config.baseUrl) return config.baseUrl.replace(/\/+$/, "");
  return config.sandbox ? ZINGALA_ORIGINS.sandbox : ZINGALA_ORIGINS.production;
}

/**
 * Sandbox if the flag says so **or** the resolved origin is the UAT host — the same
 * shape as the ECPay adapters, so a `{ sandbox: true, baseUrl: proxy }` setup is not
 * silently reclassified as production.
 */
export function isZingalaSandbox(config: ZingalaConfig): boolean {
  return config.sandbox === true || resolveZingalaOrigin(config) === ZINGALA_ORIGINS.sandbox;
}
