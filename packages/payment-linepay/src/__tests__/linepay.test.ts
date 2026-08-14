import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { isPaymentError, type PaymentError } from "@paid-tw/payment";
import {
  CHANNEL_ID,
  DETAILS_URL,
  REQUEST_URL,
  captureUrl,
  checkUrl,
  confirmUrl,
  gatewayError,
  inspectSignedRequest,
  refundUrl,
  server,
  testProvider,
  voidUrl,
} from "./server.js";
import {
  CHECK_PENDING_JSON,
  CONFIRM_SUCCESS_JSON,
  DETAILS_EMPTY_JSON,
  DETAILS_NOT_FOUND_JSON,
  DETAILS_PAID_JSON,
  DETAILS_PARTIAL_REFUND_JSON,
  REFUND_OVERFLOW_2101_JSON,
  REFUND_SUCCESS_JSON,
  REFUND_TX_ID,
  REQUEST_SUCCESS_JSON,
  TX_ID,
  TX_ID_ROUNDED,
} from "./fixtures.js";
import type { LinepayRefundInput } from "../provider.js";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/** Serve a raw JSON string verbatim — keeps int64 ids un-rounded. */
const json = (raw: string) =>
  new HttpResponse(raw, { headers: { "Content-Type": "application/json" } });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function expectPaymentError(
  promise: Promise<unknown>,
  code: string,
  rawCode?: string,
): Promise<PaymentError> {
  const err = await promise.then(
    () => {
      throw new Error(`expected a PaymentError(${code})`);
    },
    (e) => e as PaymentError,
  );
  expect(isPaymentError(err)).toBe(true);
  expect(err.code).toBe(code);
  if (rawCode !== undefined) expect(err.rawCode).toBe(rawCode);
  return err;
}

const CREATE_INPUT = {
  amount: 100,
  currency: "TWD",
  method: "linepay",
  orderId: "ORDER_20260813_1000001",
  itemDesc: "paid-tw test product",
  returnUrl: "https://shop.example/linepay/confirm",
  cancelUrl: "https://shop.example/linepay/cancel",
} as const;

describe("createPayment (付款請求)", () => {
  it("signs the request and returns the payment URL with an exact int64 id", async () => {
    let seen: Awaited<ReturnType<typeof inspectSignedRequest>> | undefined;
    server.use(
      http.post(REQUEST_URL, async ({ request }) => {
        seen = await inspectSignedRequest(request);
        return json(REQUEST_SUCCESS_JSON);
      }),
    );

    const result = await testProvider().createPayment({ ...CREATE_INPUT });

    expect(seen?.signatureValid).toBe(true);
    expect(seen?.channelId).toBe(CHANNEL_ID);
    expect(seen?.nonce).toMatch(UUID);
    expect(seen?.body).toEqual({
      amount: 100,
      currency: "TWD",
      orderId: "ORDER_20260813_1000001",
      packages: [
        {
          id: "1",
          amount: 100,
          products: [{ name: "paid-tw test product", quantity: 1, price: 100 }],
        },
      ],
      redirectUrls: {
        confirmUrl: "https://shop.example/linepay/confirm",
        cancelUrl: "https://shop.example/linepay/cancel",
      },
    });

    expect(result.mode).toBe("redirect");
    expect(result.transactionId).toBe(TX_ID);
    expect(result.transactionId).not.toBe(TX_ID_ROUNDED);
    expect(result.paymentUrl.web).toContain("sandbox-web-pay.line.me");
    expect(result.paymentAccessToken).toBe("179097132890");
  });

  it("passes explicit packages/options through and books the confirmUrl override", async () => {
    let seen: Awaited<ReturnType<typeof inspectSignedRequest>> | undefined;
    server.use(
      http.post(REQUEST_URL, async ({ request }) => {
        seen = await inspectSignedRequest(request);
        return json(REQUEST_SUCCESS_JSON);
      }),
    );

    await testProvider().createPayment({
      ...CREATE_INPUT,
      amount: 130,
      confirmUrl: "https://shop.example/other-confirm",
      packages: [
        {
          id: "pkg-1",
          amount: 100,
          products: [{ id: "p1", name: "商品", quantity: 2, price: 50 }],
        },
      ],
      options: {
        payment: { capture: false },
        display: { locale: "zh_TW" },
        shipping: { feeAmount: 30 },
      },
    });

    const body = seen?.body as Record<string, unknown>;
    expect(body.packages).toEqual([
      { id: "pkg-1", amount: 100, products: [{ id: "p1", name: "商品", quantity: 2, price: 50 }] },
    ]);
    expect(body.options).toEqual({
      payment: { capture: false },
      display: { locale: "zh_TW" },
      shipping: { feeAmount: 30 },
    });
    expect((body.redirectUrls as Record<string, string>).confirmUrl).toBe(
      "https://shop.example/other-confirm",
    );
  });

  it("rejects local contract violations before any request is sent", async () => {
    const provider = testProvider();
    await expectPaymentError(
      provider.createPayment({ ...CREATE_INPUT, method: "card" }),
      "VALIDATION",
    );
    await expectPaymentError(
      provider.createPayment({ ...CREATE_INPUT, currency: "EUR" }),
      "VALIDATION",
    );
    await expectPaymentError(
      provider.createPayment({ ...CREATE_INPUT, amount: 99.5 }),
      "VALIDATION",
    );
    await expectPaymentError(
      provider.createPayment({ ...CREATE_INPUT, cancelUrl: undefined }),
      "VALIDATION",
    );
    await expectPaymentError(
      provider.createPayment({ ...CREATE_INPUT, notifyUrl: "https://shop.example/notify" }),
      "VALIDATION",
    );
    await expectPaymentError(
      provider.createPayment({ ...CREATE_INPUT, orderId: "x".repeat(101) }),
      "VALIDATION",
    );
    // Σ packages.amount (+ shipping fee) must equal amount.
    await expectPaymentError(
      provider.createPayment({
        ...CREATE_INPUT,
        packages: [{ id: "1", amount: 60, products: [{ name: "商品", quantity: 1, price: 60 }] }],
      }),
      "VALIDATION",
    );
  });

  it("maps a duplicate orderId (1172) onto CONFLICT with the raw code preserved", async () => {
    server.use(http.post(REQUEST_URL, () => HttpResponse.json(gatewayError("1172"))));
    const err = await expectPaymentError(
      testProvider().createPayment({ ...CREATE_INPUT }),
      "CONFLICT",
      "1172",
    );
    expect(err.message).toContain("已存在相同訂單號碼");
  });

  it("normalizes transport failures", async () => {
    server.use(http.post(REQUEST_URL, () => new HttpResponse(null, { status: 500 })));
    await expectPaymentError(testProvider().createPayment({ ...CREATE_INPUT }), "PROVIDER", "500");

    server.use(http.post(REQUEST_URL, () => HttpResponse.error()));
    await expectPaymentError(testProvider().createPayment({ ...CREATE_INPUT }), "NETWORK");
  });

  it("requires credentials before touching the network", async () => {
    await expectPaymentError(
      testProvider({ channelSecret: undefined }).createPayment({ ...CREATE_INPUT }),
      "AUTH",
    );
  });
});

describe("getPayment (查詢付款明細)", () => {
  it("queries by tradeNo with a signed GET and normalizes a paid transaction", async () => {
    let seen: Awaited<ReturnType<typeof inspectSignedRequest>> | undefined;
    let params: URLSearchParams | undefined;
    server.use(
      http.get(DETAILS_URL, async ({ request }) => {
        params = new URL(request.url).searchParams;
        seen = await inspectSignedRequest(request);
        return json(DETAILS_PAID_JSON);
      }),
    );

    const data = await testProvider().getPayment({ tradeNo: TX_ID });

    expect(seen?.signatureValid).toBe(true);
    expect(params?.get("transactionId")).toBe(TX_ID);
    expect(data).toMatchObject({
      status: "paid",
      method: "linepay",
      amount: 100,
      paidAt: "2026-08-13T09:00:00Z",
      tradeNo: TX_ID,
      merTradeNo: "ORDER_20260813_1000001",
    });
  });

  it("queries by merTradeNo (orderId)", async () => {
    let params: URLSearchParams | undefined;
    server.use(
      http.get(DETAILS_URL, ({ request }) => {
        params = new URL(request.url).searchParams;
        return json(DETAILS_PAID_JSON);
      }),
    );
    await testProvider().getPayment({ merTradeNo: "ORDER_20260813_1000001" });
    expect(params?.get("orderId")).toBe("ORDER_20260813_1000001");
    expect(params?.has("transactionId")).toBe(false);
  });

  it("classifies refunds: partial vs exhausted", async () => {
    server.use(http.get(DETAILS_URL, () => json(DETAILS_PARTIAL_REFUND_JSON)));
    const partial = await testProvider().getPayment({ tradeNo: TX_ID });
    expect(partial.status).toBe("partially_refunded");

    server.use(
      http.get(DETAILS_URL, () =>
        json(DETAILS_PARTIAL_REFUND_JSON.replace('"refundAmount": -40', '"refundAmount": -100')),
      ),
    );
    const full = await testProvider().getPayment({ tradeNo: TX_ID });
    expect(full.status).toBe("refunded");
  });

  it("maps an empty result list and 1150 onto NOT_FOUND", async () => {
    server.use(http.get(DETAILS_URL, () => json(DETAILS_EMPTY_JSON)));
    await expectPaymentError(testProvider().getPayment({ tradeNo: TX_ID }), "NOT_FOUND");

    // The answer the sandbox actually gives for unknown ids AND for
    // transactions that exist but were never confirmed (recorded 2026-08-13).
    server.use(http.get(DETAILS_URL, () => json(DETAILS_NOT_FOUND_JSON)));
    await expectPaymentError(testProvider().getPayment({ tradeNo: TX_ID }), "NOT_FOUND", "1150");
  });

  it("requires one of tradeNo/merTradeNo", async () => {
    await expectPaymentError(testProvider().getPayment({}), "VALIDATION");
  });
});

describe("refundPayment (退款)", () => {
  it("refunds partially by tradeNo — refundAmount on the wire, int64 result intact", async () => {
    let seen: Awaited<ReturnType<typeof inspectSignedRequest>> | undefined;
    server.use(
      http.post(refundUrl(TX_ID), async ({ request }) => {
        seen = await inspectSignedRequest(request);
        return json(REFUND_SUCCESS_JSON);
      }),
    );

    const result = await testProvider().refundPayment({
      orderId: "ORDER_20260813_1000001",
      tradeNo: TX_ID,
      amount: 40,
    });

    expect(seen?.signatureValid).toBe(true);
    expect(seen?.body).toEqual({ refundAmount: 40 });
    expect(result.refundTransactionId).toBe(REFUND_TX_ID);
    expect(result.refundTransactionDate).toBe("2026-08-13T09:15:01Z");
  });

  it("omitting amount sends an empty body → full refund", async () => {
    let seen: Awaited<ReturnType<typeof inspectSignedRequest>> | undefined;
    server.use(
      http.post(refundUrl(TX_ID), async ({ request }) => {
        seen = await inspectSignedRequest(request);
        return json(REFUND_SUCCESS_JSON);
      }),
    );
    await testProvider().refundPayment({ orderId: "whatever", tradeNo: TX_ID });
    expect(seen?.body).toEqual({});
    expect(seen?.signatureValid).toBe(true);
  });

  it("resolves orderId → transactionId through the details query when tradeNo is absent", async () => {
    let detailsParams: URLSearchParams | undefined;
    server.use(
      http.get(DETAILS_URL, ({ request }) => {
        detailsParams = new URL(request.url).searchParams;
        return json(DETAILS_PAID_JSON);
      }),
      http.post(refundUrl(TX_ID), () => json(REFUND_SUCCESS_JSON)),
    );

    const result = await testProvider().refundPayment({ orderId: "ORDER_20260813_1000001" });
    expect(detailsParams?.get("orderId")).toBe("ORDER_20260813_1000001");
    expect(result.refundTransactionId).toBe(REFUND_TX_ID);
  });

  it("maps an already-refunded transaction (1165) onto CONFLICT", async () => {
    server.use(http.post(refundUrl(TX_ID), () => HttpResponse.json(gatewayError("1165"))));
    await expectPaymentError(
      testProvider().refundPayment({ orderId: "x", tradeNo: TX_ID, amount: 40 }),
      "CONFLICT",
      "1165",
    );
  });

  it("maps a parameter error (2101) onto VALIDATION, errorDetailMap kept in raw", async () => {
    server.use(http.post(refundUrl(TX_ID), () => json(REFUND_OVERFLOW_2101_JSON)));
    const err = await expectPaymentError(
      testProvider().refundPayment({ orderId: "x", tradeNo: TX_ID, amount: 40 }),
      "VALIDATION",
      "2101",
    );
    expect((err.raw as Record<string, unknown>).errorDetailMap).toMatchObject({
      unrecognizedPathVariable: "transactionId",
    });
  });

  it("requires orderId or tradeNo", async () => {
    await expectPaymentError(
      testProvider().refundPayment({} as unknown as LinepayRefundInput),
      "VALIDATION",
    );
  });

  it("rejects a path id past int64 locally (the gateway would 2101 it)", async () => {
    await expectPaymentError(
      testProvider().refundPayment({ orderId: "x", tradeNo: "9".repeat(19), amount: 40 }),
      "VALIDATION",
    );
  });
});

describe("confirmPayment (付款授權)", () => {
  it("posts amount+currency and returns the payInfo breakdown", async () => {
    let seen: Awaited<ReturnType<typeof inspectSignedRequest>> | undefined;
    server.use(
      http.post(confirmUrl(TX_ID), async ({ request }) => {
        seen = await inspectSignedRequest(request);
        return json(CONFIRM_SUCCESS_JSON);
      }),
    );

    const result = await testProvider().confirmPayment({
      transactionId: TX_ID,
      amount: 100,
      currency: "TWD",
    });

    expect(seen?.signatureValid).toBe(true);
    expect(seen?.body).toEqual({ amount: 100, currency: "TWD" });
    expect(result.transactionId).toBe(TX_ID);
    expect(result.orderId).toBe("ORDER_20260813_1000001");
    expect(result.payInfo).toEqual([
      { method: "CREDIT_CARD", amount: 90 },
      { method: "POINT", amount: 10 },
    ]);
  });

  it("rejects a number transactionId — precision was already lost upstream", async () => {
    await expectPaymentError(
      testProvider().confirmPayment({
        transactionId: Number(TX_ID) as unknown as string,
        amount: 100,
        currency: "TWD",
      }),
      "VALIDATION",
    );
  });

  it("maps confirming before the buyer authenticated (1169) — recorded live", async () => {
    server.use(
      http.post(confirmUrl(TX_ID), () =>
        HttpResponse.json(
          gatewayError("1169", "Payment method and password must be certificated by LINE Pay."),
        ),
      ),
    );
    const err = await expectPaymentError(
      testProvider().confirmPayment({ transactionId: TX_ID, amount: 100, currency: "TWD" }),
      "PROVIDER",
      "1169",
    );
    expect(err.message).toContain("驗證認證密碼");
  });
});

describe("capture / void (請款・取消授權)", () => {
  it("captures an authorization", async () => {
    let seen: Awaited<ReturnType<typeof inspectSignedRequest>> | undefined;
    server.use(
      http.post(captureUrl(TX_ID), async ({ request }) => {
        seen = await inspectSignedRequest(request);
        return json(CONFIRM_SUCCESS_JSON);
      }),
    );
    const result = await testProvider().capturePayment({
      transactionId: TX_ID,
      amount: 100,
      currency: "TWD",
    });
    expect(seen?.signatureValid).toBe(true);
    expect(seen?.body).toEqual({ amount: 100, currency: "TWD" });
    expect(result.transactionId).toBe(TX_ID);
  });

  it("voids an authorization with an empty (but signed) body", async () => {
    let seen: Awaited<ReturnType<typeof inspectSignedRequest>> | undefined;
    server.use(
      http.post(voidUrl(TX_ID), async ({ request }) => {
        seen = await inspectSignedRequest(request);
        return HttpResponse.json({ returnCode: "0000", returnMessage: "OK" });
      }),
    );
    await testProvider().voidAuthorization({ transactionId: TX_ID });
    expect(seen?.signatureValid).toBe(true);
    expect(seen?.body).toEqual({});
  });

  it("maps a wrong-state capture (1179) onto CONFLICT", async () => {
    server.use(http.post(captureUrl(TX_ID), () => HttpResponse.json(gatewayError("1179"))));
    await expectPaymentError(
      testProvider().capturePayment({ transactionId: TX_ID, amount: 100, currency: "TWD" }),
      "CONFLICT",
      "1179",
    );
  });
});

describe("checkPaymentRequestStatus (查詢付款請求狀態)", () => {
  it.each([
    ["0000", "pending"],
    ["0110", "ready"],
    ["0121", "canceled"],
    ["0122", "failed"],
    ["0123", "completed"],
  ] as const)("maps returnCode %s onto %s", async (returnCode, status) => {
    let seen: Awaited<ReturnType<typeof inspectSignedRequest>> | undefined;
    server.use(
      http.get(checkUrl(TX_ID), async ({ request }) => {
        seen = await inspectSignedRequest(request);
        // 0000 = the shape recorded live 2026-08-13 ("reserved transaction.").
        return returnCode === "0000"
          ? json(CHECK_PENDING_JSON)
          : HttpResponse.json({ returnCode, returnMessage: "" });
      }),
    );
    const result = await testProvider().checkPaymentRequestStatus({ transactionId: TX_ID });
    expect(seen?.signatureValid).toBe(true);
    expect(result.status).toBe(status);
    expect(result.returnCode).toBe(returnCode);
  });

  it("still throws for real errors (1150)", async () => {
    server.use(http.get(checkUrl(TX_ID), () => HttpResponse.json(gatewayError("1150"))));
    await expectPaymentError(
      testProvider().checkPaymentRequestStatus({ transactionId: TX_ID }),
      "NOT_FOUND",
      "1150",
    );
  });
});
