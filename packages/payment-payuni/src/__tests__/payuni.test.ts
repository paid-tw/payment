import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { isPaymentError, PaymentError, supports } from "@paid-tw/payment";
import { parseRequest, paySuccess, payError, QUERY_URL, server, testProvider } from "./server.js";
import { QUERY_FLAT_LINEPAY, QUERY_JSON_PAID, QUERY_QS_JSON_RESULT } from "./fixtures.js";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("PAYUNi getPayment — success shapes", () => {
  it("normalizes a JSON `Result` array (paid card)", async () => {
    server.use(http.post(QUERY_URL, () => HttpResponse.json(paySuccess(QUERY_JSON_PAID))));

    const data = await testProvider().getPayment({ merTradeNo: "ORDER-123" });

    expect(data.status).toBe("paid");
    expect(data.method).toBe("card");
    expect(data.amount).toBe(100);
    expect(data.tradeNo).toBe("UNI20260630000001");
    expect(data.merTradeNo).toBe("ORDER-123");
    // raw keeps the fields the pretty formatter renders (card/bank/fee).
    expect((data.raw as Record<string, unknown>).Card6No).toBe("400022");
    expect((data.raw as Record<string, unknown>).CardBank).toBe("807");
  });

  it("treats a blank TradeAmt as unknown (undefined), not 0", async () => {
    const payload = JSON.stringify({
      Status: "SUCCESS",
      Result: [{ TradeNo: "UNI9", MerTradeNo: "ORDER-9", TradeStatus: "9", TradeAmt: "" }],
    });
    server.use(http.post(QUERY_URL, () => HttpResponse.json(paySuccess(payload))));
    const data = await testProvider().getPayment({ merTradeNo: "ORDER-9" });
    expect(data.status).toBe("unpaid");
    expect(data.amount).toBeUndefined();
  });

  it("normalizes flattened `Result[0][Field]` querystring keys (LINE Pay)", async () => {
    server.use(http.post(QUERY_URL, () => HttpResponse.json(paySuccess(QUERY_FLAT_LINEPAY))));

    const data = await testProvider().getPayment({ merTradeNo: "ORDER-456" });

    expect(data.status).toBe("paid");
    expect(data.method).toBe("linepay");
    expect(data.amount).toBe(250);
    expect(data.tradeNo).toBe("UNI20260630000002");
  });

  it("normalizes a querystring whose `Result` is a JSON string (pending ATM)", async () => {
    server.use(http.post(QUERY_URL, () => HttpResponse.json(paySuccess(QUERY_QS_JSON_RESULT))));

    const data = await testProvider().getPayment({ tradeNo: "UNI20260630000003" });

    expect(data.status).toBe("pending");
    expect(data.method).toBe("atm");
    expect(data.amount).toBe(80);
  });
});

describe("PAYUNi getPayment — request signing", () => {
  it("sends Version 2.0 + an encrypted, hashed body carrying MerTradeNo", async () => {
    let captured: ReturnType<typeof parseRequest> | undefined;
    server.use(
      http.post(QUERY_URL, async ({ request }) => {
        captured = parseRequest(await request.text());
        return HttpResponse.json(paySuccess(QUERY_JSON_PAID));
      }),
    );

    await testProvider().getPayment({ merTradeNo: "ORDER-123" });

    expect(captured?.merId).toBe("TESTMER01");
    expect(captured?.version).toBe("2.0");
    expect(captured?.hashInfo).toMatch(/^[0-9A-F]{64}$/); // SHA-256 hex, upper
    expect(captured?.params.MerTradeNo).toBe("ORDER-123");
    expect(captured?.params.Timestamp).toMatch(/^\d+$/);
  });
});

describe("PAYUNi getPayment — error mapping", () => {
  it("maps QUERY03001 (查無訂單) to NOT_FOUND, preserving the raw code", async () => {
    server.use(http.post(QUERY_URL, () => HttpResponse.json(payError("QUERY03001"))));

    const err = await testProvider()
      .getPayment({ merTradeNo: "NOPE" })
      .catch((e) => e);

    expect(isPaymentError(err)).toBe(true);
    expect((err as PaymentError).code).toBe("NOT_FOUND");
    expect((err as PaymentError).rawCode).toBe("QUERY03001");
    expect((err as PaymentError).rawMessage).toBe("查無符合訂單資料");
  });

  it("maps QUERY01002 (HASH 不符) to AUTH", async () => {
    server.use(http.post(QUERY_URL, () => HttpResponse.json(payError("QUERY01002"))));
    const err = await testProvider()
      .getPayment({ merTradeNo: "x" })
      .catch((e) => e);
    expect((err as PaymentError).code).toBe("AUTH");
  });

  it("wraps a non-2xx HTTP response as a PROVIDER error", async () => {
    server.use(http.post(QUERY_URL, () => new HttpResponse("oops", { status: 500 })));
    const err = await testProvider()
      .getPayment({ merTradeNo: "x" })
      .catch((e) => e);
    expect((err as PaymentError).code).toBe("PROVIDER");
    expect((err as PaymentError).rawCode).toBe("500");
  });

  it("wraps a transport failure as a NETWORK error", async () => {
    server.use(http.post(QUERY_URL, () => HttpResponse.error()));
    const err = await testProvider()
      .getPayment({ merTradeNo: "x" })
      .catch((e) => e);
    expect((err as PaymentError).code).toBe("NETWORK");
  });
});

describe("PAYUNi getPayment — validation (no network)", () => {
  it("rejects when neither MerTradeNo nor TradeNo is given", async () => {
    // No handler registered: onUnhandledRequest:"error" would throw if it hit
    // the network, so this also proves we fail before sending.
    const err = await testProvider()
      .getPayment({})
      .catch((e) => e);
    expect((err as PaymentError).code).toBe("VALIDATION");
  });

  it("rejects with AUTH when credentials are missing", async () => {
    const err = await testProvider({ merchantId: undefined, hashKey: undefined, hashIv: undefined })
      .getPayment({ merTradeNo: "x" })
      .catch((e) => e);
    expect((err as PaymentError).code).toBe("AUTH");
  });
});

describe("PAYUNi capabilities", () => {
  it("declares only GET_PAYMENT; create/refund reject as UNSUPPORTED", async () => {
    const provider = testProvider();
    expect(supports(provider.capabilities, "GET_PAYMENT")).toBe(true);
    expect(supports(provider.capabilities, "CREATE_PAYMENT")).toBe(false);

    const createErr = await provider
      .createPayment({ amount: 1, currency: "TWD", method: "card", orderId: "o" })
      .catch((e) => e);
    expect((createErr as PaymentError).code).toBe("UNSUPPORTED");

    const refundErr = await provider.refundPayment({ orderId: "o" }).catch((e) => e);
    expect((refundErr as PaymentError).code).toBe("UNSUPPORTED");
  });
});
