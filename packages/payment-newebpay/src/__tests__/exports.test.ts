import { describe, expect, it } from "vitest";
import * as entry from "../index.js";

/** Guards the public entry point — a broken re-export ships a dead package. */
describe("@paid-tw/payment-newebpay exports", () => {
  it("exposes both factories and the notify verifiers", () => {
    expect(entry).toHaveProperty("createNewebpayProvider");
    expect(entry).toHaveProperty("createNewebpayPeriodProvider");
    expect(entry).toHaveProperty("verifyNewebpayPaymentNotify");
    expect(entry).toHaveProperty("verifyNewebpayGetCodeNotify");
    expect(entry).toHaveProperty("verifyPeriodCreateNotify");
    expect(entry).toHaveProperty("verifyPeriodCycleNotify");
    expect(entry).toHaveProperty("coerceNewebpayNotifyBody");
  });

  it("exposes the crypto primitives and config", () => {
    expect(entry).toHaveProperty("encryptTradeInfo");
    expect(entry).toHaveProperty("decryptTradeInfo");
    expect(entry).toHaveProperty("tradeSha");
    expect(entry).toHaveProperty("checkValue");
    expect(entry).toHaveProperty("checkCode");
    expect(entry).toHaveProperty("buildQuery");
    expect(entry).toHaveProperty("NEWEBPAY_ORIGINS");
    expect(entry).toHaveProperty("NEWEBPAY_PATHS");
    expect(entry).toHaveProperty("resolveNewebpayOrigin");
    expect(entry).toHaveProperty("NEWEBPAY_MPG_VERSION");
    expect(entry).toHaveProperty("NEWEBPAY_PERIOD_VERSIONS");
  });

  it("exposes the error-code table and mappers", () => {
    expect(entry).toHaveProperty("NEWEBPAY_ERROR_MESSAGES");
    expect(entry).toHaveProperty("mapNewebpayErrorCode");
    expect(entry).toHaveProperty("newebpayErrorMessage");
    expect(entry).toHaveProperty("mapNewebpayPaymentType");
    expect(entry.mapNewebpayErrorCode("TRA10021")).toBe("NOT_FOUND");
    expect(entry.mapNewebpayErrorCode("PER10061")).toBe("CONFLICT");
    expect(entry.mapNewebpayErrorCode("MPG01015")).toBe("VALIDATION");
  });

  it("both factories produce providers with the documented names", () => {
    const config = { merchantId: "M", hashKey: "K".repeat(32), hashIv: "V".repeat(16) };
    expect(entry.createNewebpayProvider(config).name).toBe("newebpay");
    expect(entry.createNewebpayPeriodProvider(config).name).toBe("newebpay-period");
  });
});
