import {
  assertSupports,
  type Capability,
  type NormalizedPaymentData,
  type PaymentProvider,
  type ProviderRuntimeConfig,
} from "@paid-tw/payment";

/** No capabilities yet — every entry point rejects with UNSUPPORTED. */
const CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>();

/**
 * NewebPay (藍新金流) adapter — scaffolded against the shared {@link PaymentProvider}
 * contract but not yet implemented. Fill in once the real API behaviour is
 * recorded (see the einvoice repo's MSW-fixture workflow).
 */
export function createNewebpayProvider(_config: ProviderRuntimeConfig): PaymentProvider {
  return {
    name: "newebpay",
    capabilities: CAPABILITIES,
    async createPayment() {
      assertSupports("newebpay", CAPABILITIES, "CREATE_PAYMENT");
      throw new Error("unreachable");
    },
    async getPayment(): Promise<NormalizedPaymentData> {
      assertSupports("newebpay", CAPABILITIES, "GET_PAYMENT");
      throw new Error("unreachable");
    },
    async refundPayment() {
      assertSupports("newebpay", CAPABILITIES, "REFUND_PAYMENT");
      throw new Error("unreachable");
    },
  };
}
