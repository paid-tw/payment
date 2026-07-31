import { assertSupports, Capability } from "./capabilities.js";
import { PaymentError } from "./errors.js";
import type { PaymentProvider } from "./provider.js";
import type {
  CreatePaymentRequest,
  GetPaymentRequest,
  NormalizedPaymentData,
  RefundPaymentRequest,
} from "./types.js";

const ALL_CAPABILITIES: readonly Capability[] = [
  Capability.CREATE_PAYMENT,
  Capability.GET_PAYMENT,
  Capability.REFUND_PAYMENT,
];

export interface MockProviderOptions {
  /** Restrict declared capabilities. Defaults to all. */
  capabilities?: Iterable<Capability>;
}

/**
 * In-memory {@link PaymentProvider} for tests. Never hits the network; supports
 * capability gating and {@link failNext} for one-shot error injection.
 */
export class MockProvider implements PaymentProvider {
  readonly name = "mock";
  readonly capabilities: ReadonlySet<Capability>;
  private readonly payments = new Map<string, NormalizedPaymentData>();
  private seq = 0;
  private queuedFailure?: PaymentError;

  constructor(options: MockProviderOptions = {}) {
    this.capabilities = new Set(options.capabilities ?? ALL_CAPABILITIES);
  }

  /** Queue a one-shot failure for the next operation. */
  failNext(error: PaymentError): void {
    this.queuedFailure = error;
  }

  private throwIfQueued(): void {
    if (this.queuedFailure) {
      const err = this.queuedFailure;
      this.queuedFailure = undefined;
      throw err;
    }
  }

  async createPayment(input: CreatePaymentRequest): Promise<{ id: string; status: string }> {
    assertSupports(this, Capability.CREATE_PAYMENT);
    this.throwIfQueued();
    this.seq += 1;
    const tradeNo = `MOCK-${this.seq}`;
    const data: NormalizedPaymentData = {
      status: "created",
      method: input.method,
      amount: input.amount,
      merTradeNo: input.orderId,
      tradeNo,
    };
    this.payments.set(input.orderId, data);
    return { id: input.orderId, status: "created" };
  }

  async getPayment(input: GetPaymentRequest): Promise<NormalizedPaymentData> {
    assertSupports(this, Capability.GET_PAYMENT);
    this.throwIfQueued();
    const key = input.merTradeNo;
    if (!key) {
      throw new PaymentError("VALIDATION", "MockProvider getPayment requires merTradeNo", "mock");
    }
    const found = this.payments.get(key);
    if (!found) {
      throw new PaymentError("NOT_FOUND", `MockProvider 查無訂單 ${key}`, "mock");
    }
    return found;
  }

  async refundPayment(input: RefundPaymentRequest): Promise<{ id: string; status: string }> {
    assertSupports(this, Capability.REFUND_PAYMENT);
    this.throwIfQueued();
    const found = this.payments.get(input.orderId);
    if (!found) {
      throw new PaymentError("NOT_FOUND", `MockProvider 查無訂單 ${input.orderId}`, "mock");
    }
    found.status = "refunded";
    return { id: input.orderId, status: "refunded" };
  }
}
