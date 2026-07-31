/** Common payment methods across Taiwan gateways. Adapters map these to wire values. */
export type PaymentMethod = "card" | "linepay" | "atm" | "cvs";

/**
 * Runtime config handed to a provider factory. Credentials and the target host
 * live on the provider instance (mirroring `@paid-tw/einvoice`). Tests inject
 * `baseUrl` to point the adapter at an MSW mock host.
 */
export interface ProviderRuntimeConfig {
  merchantId?: string;
  hashKey?: string;
  hashIv?: string;
  sandbox?: boolean;
  /** Override the gateway origin (used by tests to target an MSW host). */
  baseUrl?: string;
}

/** Provider-agnostic create request. Adapters map this onto their wire format. */
export interface CreatePaymentRequest {
  amount: number;
  currency: string;
  method: PaymentMethod;
  orderId: string;
  itemDesc?: string;
  returnUrl?: string;
  notifyUrl?: string;
}

export interface GetPaymentRequest {
  merTradeNo?: string;
  tradeNo?: string;
}

export interface RefundPaymentRequest {
  orderId: string;
  amount?: number;
}

/** Normalized payment snapshot returned by {@link import("./provider.js").PaymentProvider.getPayment}. */
export interface NormalizedPaymentData {
  status: string;
  method: string;
  amount?: number;
  paidAt?: string;
  tradeNo?: string;
  merTradeNo?: string;
  raw?: unknown;
}
