import { describe, expect, it } from "vitest";
import { isPaymentError, PaymentError } from "./errors.js";

describe("PaymentError", () => {
  it("is detected by the brand guard (not instanceof alone)", () => {
    const err = new PaymentError("NOT_FOUND", "missing", "ecpay", {
      rawCode: "10200047",
      rawMessage: "查無交易資料",
    });
    expect(isPaymentError(err)).toBe(true);
    expect(err.code).toBe("NOT_FOUND");
    expect(err.provider).toBe("ecpay");
    expect(err.rawCode).toBe("10200047");
  });

  it("toJSON omits raw payload", () => {
    const err = new PaymentError("PROVIDER", "boom", "payuni", { raw: { secret: true } });
    expect(err.toJSON()).toEqual({
      name: "PaymentError",
      provider: "payuni",
      code: "PROVIDER",
      message: "boom",
      rawCode: undefined,
      rawMessage: undefined,
    });
    expect(err.raw).toEqual({ secret: true });
  });

  it("rejects non-errors", () => {
    expect(isPaymentError(null)).toBe(false);
    expect(isPaymentError(new Error("x"))).toBe(false);
  });
});
