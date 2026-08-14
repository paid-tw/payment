import { describe, expect, it } from "vitest";
import * as entry from "../index.js";

/** Guards the public entry point — a broken re-export ships a dead package. */
describe("@paid-tw/payment-linepay exports", () => {
  it("exposes the factory and the crypto primitives", () => {
    expect(entry).toHaveProperty("createLinepayProvider");
    expect(entry).toHaveProperty("signLinepayRequest");
    expect(entry).toHaveProperty("linepayNonce");
    expect(entry).toHaveProperty("parseLinepayJson");
  });

  it("exposes config and constants", () => {
    expect(entry).toHaveProperty("LINEPAY_ORIGINS");
    expect(entry).toHaveProperty("LINEPAY_PATHS");
    expect(entry).toHaveProperty("resolveLinepayOrigin");
    expect(entry).toHaveProperty("LINEPAY_CURRENCIES");
  });

  it("exposes the result-code table and mappers", () => {
    expect(entry).toHaveProperty("LINEPAY_RESULT_MESSAGES");
    expect(entry).toHaveProperty("mapLinepayErrorCode");
    expect(entry).toHaveProperty("linepayErrorMessage");
    expect(entry.mapLinepayErrorCode("1150")).toBe("NOT_FOUND");
    expect(entry.mapLinepayErrorCode("1172")).toBe("CONFLICT");
    expect(entry.mapLinepayErrorCode("1106")).toBe("AUTH");
    expect(entry.mapLinepayErrorCode("2101")).toBe("VALIDATION");
    expect(entry.mapLinepayErrorCode("9000")).toBe("PROVIDER");
    expect(entry.linepayErrorMessage("1902")).toContain("臨時錯誤");
  });

  it("the factory produces a provider with the documented name", () => {
    const provider = entry.createLinepayProvider({ channelId: "c", channelSecret: "s" });
    expect(provider.name).toBe("linepay");
    expect(provider.capabilities.has("CREATE_PAYMENT")).toBe(true);
    expect(provider.capabilities.has("GET_PAYMENT")).toBe(true);
    expect(provider.capabilities.has("REFUND_PAYMENT")).toBe(true);
  });
});
