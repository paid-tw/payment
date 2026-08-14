/**
 * LINE Pay Online API v4 — hosts, paths, and credentials.
 *
 * @see https://developers-pay.line.me/zh/online-api-v4 (fetched 2026-08-13)
 */

/** LINE Pay gateway hosts. Selected by `sandbox` / `baseUrl` on the provider config. */
export const LINEPAY_ORIGINS = {
  sandbox: "https://sandbox-api-pay.line.me",
  production: "https://api-pay.line.me",
} as const;

/**
 * v4 API paths. Most embed the LINE Pay transactionId, so they are builders
 * rather than constants — the exact path string doubles as the HMAC signature
 * input ({@link signLinepayRequest}), query string excluded.
 */
export const LINEPAY_PATHS = {
  /** 付款請求 — returns the paymentUrl the buyer opens. */
  request: "/v4/payments/request",
  /** 查詢付款請求狀態 — poll while the buyer authenticates. */
  check: (transactionId: string) => `/v4/payments/requests/${transactionId}/check`,
  /** 付款授權 (confirm) — call after the buyer returns to confirmUrl. */
  confirm: (transactionId: string) => `/v4/payments/${transactionId}/confirm`,
  /** 請款 (capture) — for auth/capture-separated flows (options.payment.capture=false). */
  capture: (transactionId: string) => `/v4/payments/authorizations/${transactionId}/capture`,
  /** 取消授權 (void) — only before capture; after capture use refund. */
  void: (transactionId: string) => `/v4/payments/authorizations/${transactionId}/void`,
  /** 查詢付款明細 — GET, by transactionId and/or orderId. */
  details: "/v4/payments",
  /** 退款 — full when refundAmount is omitted, partial otherwise. */
  refund: (transactionId: string) => `/v4/payments/${transactionId}/refund`,
} as const;

/**
 * Runtime config. LINE Pay authenticates with a Channel ID + Channel Secret
 * (LINE Pay Merchant Center, or the sandbox signup at pay.line.me), which
 * doesn't map onto the shared merchantId/hashKey/hashIv shape — so this is
 * its own interface, the same escape hatch as Zingala's config.
 */
export interface LinepayProviderConfig {
  /** `X-LINE-ChannelId` header value. */
  channelId?: string;
  /** The HMAC-SHA256 signing key behind `X-LINE-Authorization`. */
  channelSecret?: string;
  /** Use the sandbox host. Ignored when {@link baseUrl} is set. */
  sandbox?: boolean;
  /** Override the origin entirely — e.g. an MSW mock or an egress proxy. */
  baseUrl?: string;
}

/**
 * Resolve the gateway origin. `baseUrl` wins (MSW / custom hosts); otherwise
 * `sandbox` selects sandbox-api-pay vs api-pay.
 */
export function resolveLinepayOrigin(config: { baseUrl?: string; sandbox?: boolean }): string {
  if (config.baseUrl) return config.baseUrl.replace(/\/+$/, "");
  return config.sandbox ? LINEPAY_ORIGINS.sandbox : LINEPAY_ORIGINS.production;
}
