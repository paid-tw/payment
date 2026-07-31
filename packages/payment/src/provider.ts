import type { Capability } from "./capabilities.js";
import type {
  CreatePaymentRequest,
  GetPaymentRequest,
  NormalizedPaymentData,
  ProviderRuntimeConfig,
  RefundPaymentRequest,
} from "./types.js";

/**
 * The contract every gateway adapter implements. Application/CLI code depends
 * only on this interface and feature-detects via {@link PaymentProvider.capabilities};
 * switching gateways means swapping the factory, nothing else.
 *
 * All methods reject with a {@link import("./errors.js").PaymentError} on failure.
 */
export interface PaymentProvider {
  /** A stable identifier, e.g. `"payuni"`, `"ecpay"`. */
  readonly name: string;

  /** The set of optional features this adapter supports. */
  readonly capabilities: ReadonlySet<Capability>;

  /**
   * Create a payment. May return a redirect form, payment URL, or server-side
   * transaction depending on the gateway — never assume "already paid".
   */
  createPayment(input: CreatePaymentRequest): Promise<unknown>;

  /** Query a payment by merchant order id and/or gateway trade no. */
  getPayment(input: GetPaymentRequest): Promise<NormalizedPaymentData>;

  /** Refund (full or partial, when the gateway supports it). */
  refundPayment(input: RefundPaymentRequest): Promise<unknown>;
}

/** Factory signature every adapter package exports (e.g. `createEcpayProvider`). */
export type ProviderFactory = (config: ProviderRuntimeConfig) => PaymentProvider;
