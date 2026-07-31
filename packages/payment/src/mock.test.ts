import { describe, expect, it } from "vitest";
import { Capability } from "./capabilities.js";
import { isPaymentError, PaymentError } from "./errors.js";
import { MockProvider } from "./mock.js";

describe("MockProvider", () => {
  it("create → get → refund happy path", async () => {
    const p = new MockProvider();
    await p.createPayment({
      amount: 100,
      currency: "TWD",
      method: "card",
      orderId: "ORD-1",
    });
    const got = await p.getPayment({ merTradeNo: "ORD-1" });
    expect(got.amount).toBe(100);
    expect(got.status).toBe("created");
    await p.refundPayment({ orderId: "ORD-1" });
    expect((await p.getPayment({ merTradeNo: "ORD-1" })).status).toBe("refunded");
  });

  it("respects capability restrictions", async () => {
    const p = new MockProvider({ capabilities: [Capability.GET_PAYMENT] });
    await expect(
      p.createPayment({ amount: 1, currency: "TWD", method: "card", orderId: "x" }),
    ).rejects.toSatisfy(isPaymentError);
  });

  it("failNext injects one error then recovers", async () => {
    const p = new MockProvider();
    p.failNext(new PaymentError("NETWORK", "down", "mock"));
    await expect(p.getPayment({ merTradeNo: "missing" })).rejects.toSatisfy(isPaymentError);
    await expect(p.getPayment({ merTradeNo: "missing" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
