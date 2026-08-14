import { describe, expect, it } from "vitest";
import { linepayNonce, parseLinepayJson, signLinepayRequest } from "../crypto.js";

describe("signLinepayRequest", () => {
  /**
   * Golden vectors, computed once with node:crypto against the documented
   * formula Base64(HMAC-SHA256(secret, secret + apiPath + payload + nonce)).
   * They pin the concatenation ORDER — swapping any two parts changes the MAC.
   */
  const SECRET = "test-channel-secret";
  const NONCE = "8b7e9a3c-1f2d-4e5a-9b8c-7d6e5f4a3b2c";

  it("signs a POST body", () => {
    const body = JSON.stringify({ amount: 100, currency: "TWD", orderId: "order-1" });
    expect(signLinepayRequest(SECRET, "/v4/payments/request", body, NONCE)).toBe(
      "hyqiuIB61I/B4NUP9vd9wU2JEEUUEk3Tw0uVwsiFBVY=",
    );
  });

  it("signs a GET query string", () => {
    const query = "orderId=order-1&transactionId=2023042201206549310";
    expect(signLinepayRequest(SECRET, "/v4/payments", query, NONCE)).toBe(
      "mSb/9LnnbhNxxXJcechAiAAlu5ICcRrA5/E+iFtA7oE=",
    );
  });

  it("is byte-sensitive to the payload", () => {
    const a = signLinepayRequest(SECRET, "/v4/payments/request", "{}", NONCE);
    const b = signLinepayRequest(SECRET, "/v4/payments/request", "{ }", NONCE);
    expect(a).not.toBe(b);
  });
});

describe("linepayNonce", () => {
  it("emits UUIDs", () => {
    expect(linepayNonce()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(linepayNonce()).not.toBe(linepayNonce());
  });
});

describe("parseLinepayJson", () => {
  it("keeps 19-digit transactionIds exact where JSON.parse rounds them", () => {
    const raw = '{"info":{"transactionId":2023042201206549310}}';

    // The trap this guards against: plain parsing loses the low digits.
    const lossy = JSON.parse(raw) as { info: { transactionId: number } };
    expect(String(lossy.info.transactionId)).not.toBe("2023042201206549310");

    const parsed = parseLinepayJson(raw) as { info: { transactionId: string } };
    expect(parsed.info.transactionId).toBe("2023042201206549310");
  });

  it("quotes refundTransactionId, including nested refundList entries", () => {
    const raw =
      '{"info":[{"transactionId":2023042201206549310,' +
      '"refundList":[{"refundTransactionId":2023042201206549311,"refundAmount":-40}]}]}';
    const parsed = parseLinepayJson(raw) as {
      info: Array<{
        transactionId: string;
        refundList: Array<{ refundTransactionId: string; refundAmount: number }>;
      }>;
    };
    expect(parsed.info[0]?.transactionId).toBe("2023042201206549310");
    expect(parsed.info[0]?.refundList[0]?.refundTransactionId).toBe("2023042201206549311");
    expect(parsed.info[0]?.refundList[0]?.refundAmount).toBe(-40);
  });

  it("leaves ids inside string values (payment URLs) untouched", () => {
    const raw = '{"info":{"paymentUrl":{"web":"https://x.test/?id=123","app":"line://pay/9"}}}';
    expect(parseLinepayJson(raw)).toEqual({
      info: { paymentUrl: { web: "https://x.test/?id=123", app: "line://pay/9" } },
    });
  });
});
