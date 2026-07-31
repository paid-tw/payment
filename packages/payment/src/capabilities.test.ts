import { describe, expect, it } from "vitest";
import { assertSupports, Capability, supports } from "./capabilities.js";
import { isPaymentError } from "./errors.js";
import { MockProvider } from "./mock.js";

describe("capabilities", () => {
  it("supports works on a set or a provider", () => {
    const set = new Set<Capability>([Capability.GET_PAYMENT]);
    expect(supports(set, Capability.GET_PAYMENT)).toBe(true);
    expect(supports(set, Capability.CREATE_PAYMENT)).toBe(false);

    const mock = new MockProvider({ capabilities: [Capability.GET_PAYMENT] });
    expect(supports(mock, Capability.GET_PAYMENT)).toBe(true);
    expect(supports(mock, Capability.REFUND_PAYMENT)).toBe(false);
  });

  it("assertSupports throws UNSUPPORTED PaymentError", () => {
    const set = new Set<Capability>();
    try {
      assertSupports("newebpay", set, Capability.CREATE_PAYMENT);
      expect.unreachable();
    } catch (err) {
      expect(isPaymentError(err)).toBe(true);
      if (isPaymentError(err)) {
        expect(err.code).toBe("UNSUPPORTED");
        expect(err.provider).toBe("newebpay");
      }
    }

    const mock = new MockProvider({ capabilities: [] });
    try {
      assertSupports(mock, Capability.GET_PAYMENT);
      expect.unreachable();
    } catch (err) {
      expect(isPaymentError(err)).toBe(true);
    }
  });
});
