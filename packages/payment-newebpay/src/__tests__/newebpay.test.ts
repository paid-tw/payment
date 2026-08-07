import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { isPaymentError, PaymentError, supports } from "@paid-tw/payment";
import { checkValue, decryptTradeInfo, tradeSha } from "../crypto.js";
import {
  actionSuccess,
  CANCEL_URL,
  CLOSE_URL,
  gatewayError,
  KEY,
  IV,
  MERCHANT,
  parseEnvelopeRequest,
  QUERY_URL,
  querySuccess,
  responseCheckCode,
  server,
  testProvider,
} from "./server.js";
import {
  CANCEL_AUTH_RESULT,
  CLOSE_REFUND_RESULT,
  QUERY_CREDIT_CANCELED_RESULT,
  QUERY_CREDIT_FAILED_RESULT,
  QUERY_CREDIT_PAID_RESULT,
  QUERY_CREDIT_REFUNDED_RESULT,
  QUERY_PENDING_RESULT,
  QUERY_VACC_UNPAID_RESULT,
} from "./fixtures.js";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const CREATE_INPUT = {
  amount: 100,
  currency: "TWD",
  method: "card" as const,
  orderId: "order_123",
  notifyUrl: "https://shop.example/newebpay/notify",
};

describe("NewebPay createPayment — checkout form", () => {
  // No MSW handler in this block: building the form must never hit the network
  // (MPG only accepts front-channel browser posts — MPG02005 otherwise).
  it("builds a signed MPG redirect form whose TradeInfo decrypts to the order", async () => {
    const form = await testProvider().createPayment({
      ...CREATE_INPUT,
      itemDesc: "測試商品",
      returnUrl: "https://shop.example/back",
    });

    expect(form.mode).toBe("redirect");
    expect(form.method).toBe("POST");
    expect(form.action).toBe("https://newebpay.test/MPG/mpg_gateway");
    expect(form.params.MerchantID).toBe(MERCHANT);
    expect(form.params.Version).toBe("2.3");
    expect(form.params.TradeSha).toBe(tradeSha(form.params.TradeInfo, KEY, IV));

    const inner = Object.fromEntries(
      new URLSearchParams(decryptTradeInfo(form.params.TradeInfo, KEY, IV)).entries(),
    );
    expect(inner.MerchantID).toBe(MERCHANT);
    expect(inner.RespondType).toBe("JSON");
    expect(inner.Version).toBe("2.3");
    expect(inner.MerchantOrderNo).toBe("order_123");
    expect(inner.Amt).toBe("100");
    expect(inner.ItemDesc).toBe("測試商品");
    expect(inner.NotifyURL).toBe("https://shop.example/newebpay/notify");
    expect(inner.ReturnURL).toBe("https://shop.example/back");
    expect(inner.CREDIT).toBe("1");
    expect(inner.TimeStamp).toMatch(/^\d+$/);
  });

  it("maps each shared method onto its MPG enable flag", async () => {
    const cases = [
      { method: "atm", amount: 1200, flag: "VACC" },
      { method: "cvs", amount: 700, flag: "CVS" },
      { method: "barcode", amount: 700, flag: "BARCODE" },
      { method: "linepay", amount: 100, flag: "LINEPAY" },
    ] as const;
    for (const { method, amount, flag } of cases) {
      const form = await testProvider().createPayment({ ...CREATE_INPUT, method, amount });
      const inner = Object.fromEntries(
        new URLSearchParams(decryptTradeInfo(form.params.TradeInfo, KEY, IV)).entries(),
      );
      expect(inner[flag]).toBe("1");
    }
  });

  it("merges typed fields and passthrough params into the signed payload", async () => {
    const form = await testProvider().createPayment({
      ...CREATE_INPUT,
      method: "atm",
      amount: 1200,
      customerUrl: "https://shop.example/newebpay/code",
      clientBackUrl: "https://shop.example/",
      email: "buyer@example.com",
      emailModify: 0,
      expireDate: "20260830",
      params: { WEBATM: 1, BankType: "BOT,HNCB" },
    });
    const inner = Object.fromEntries(
      new URLSearchParams(decryptTradeInfo(form.params.TradeInfo, KEY, IV)).entries(),
    );
    expect(inner.CustomerURL).toBe("https://shop.example/newebpay/code");
    expect(inner.ClientBackURL).toBe("https://shop.example/");
    expect(inner.Email).toBe("buyer@example.com");
    expect(inner.EmailModify).toBe("0");
    expect(inner.ExpireDate).toBe("20260830");
    expect(inner.VACC).toBe("1");
    expect(inner.WEBATM).toBe("1");
    expect(inner.BankType).toBe("BOT,HNCB");
  });
});

describe("NewebPay createPayment — validation (no network)", () => {
  const reject = (input: Parameters<ReturnType<typeof testProvider>["createPayment"]>[0]) =>
    testProvider()
      .createPayment(input)
      .then(
        () => {
          throw new Error("expected createPayment to reject");
        },
        (e) => e as PaymentError,
      );

  it("rejects a MerchantOrderNo outside 1-30 alnum/underscore", async () => {
    expect((await reject({ ...CREATE_INPUT, orderId: "order-123" })).code).toBe("VALIDATION");
    expect((await reject({ ...CREATE_INPUT, orderId: "x".repeat(31) })).code).toBe("VALIDATION");
  });

  it("rejects non-TWD currencies", async () => {
    expect((await reject({ ...CREATE_INPUT, currency: "USD" })).code).toBe("VALIDATION");
  });

  it("requires notifyUrl", async () => {
    expect((await reject({ ...CREATE_INPUT, notifyUrl: undefined })).code).toBe("VALIDATION");
  });

  it("rejects ReturnURL === NotifyURL (the manual forbids sharing one URL)", async () => {
    const err = await reject({ ...CREATE_INPUT, returnUrl: CREATE_INPUT.notifyUrl });
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toContain("同一網址");
  });

  it("enforces the per-method amount gates", async () => {
    expect((await reject({ ...CREATE_INPUT, method: "atm", amount: 50_000 })).code).toBe(
      "VALIDATION",
    );
    expect((await reject({ ...CREATE_INPUT, method: "cvs", amount: 29 })).code).toBe("VALIDATION");
    expect((await reject({ ...CREATE_INPUT, method: "barcode", amount: 40_001 })).code).toBe(
      "VALIDATION",
    );
  });

  it("rejects passthrough params the adapter derives, types, or cannot support", async () => {
    for (const params of [
      { Amt: 999 }, // signed by the adapter
      { CREDIT: 1 }, // duplicate of method="card"
      { LangType: "en" }, // has a typed option
      { EncryptType: 1 }, // AES-GCM unsupported
      { ["__proto__"]: "x" } as Record<string, string>, // object-internal name
      { InstFlag: Number.NaN }, // non-finite value
    ]) {
      const err = await reject({ ...CREATE_INPUT, params });
      expect(err.code).toBe("VALIDATION");
    }
  });

  it("rejects a non-positive or non-finite amount and an over-long ItemDesc", async () => {
    expect((await reject({ ...CREATE_INPUT, amount: 0 })).code).toBe("VALIDATION");
    expect((await reject({ ...CREATE_INPUT, amount: Number.NaN })).code).toBe("VALIDATION");
    expect((await reject({ ...CREATE_INPUT, itemDesc: "字".repeat(51) })).code).toBe("VALIDATION");
  });
});

describe("NewebPay getPayment — success shapes", () => {
  it("normalizes the manual's paid credit-card response (field-exact fixture)", async () => {
    server.use(
      http.post(QUERY_URL, () => HttpResponse.json(querySuccess(QUERY_CREDIT_PAID_RESULT))),
    );
    const data = await testProvider().getPayment({
      merTradeNo: "Vanespl_ec_1695795668",
      amount: 30,
    });

    expect(data.status).toBe("paid");
    expect(data.method).toBe("card");
    expect(data.amount).toBe(30);
    expect(data.paidAt).toBe("2023-09-27 14:21:59");
    expect(data.tradeNo).toBe("23092714215835071");
    expect(data.merTradeNo).toBe("Vanespl_ec_1695795668");
    expect((data.raw as Record<string, unknown>).AuthBank).toBe("KGI");
    expect((data.raw as Record<string, unknown>).Card6No).toBe("400022");
  });

  it("normalizes an unpaid ATM order — blank PayTime becomes undefined", async () => {
    server.use(
      http.post(QUERY_URL, () => HttpResponse.json(querySuccess(QUERY_VACC_UNPAID_RESULT))),
    );
    const data = await testProvider().getPayment({ merTradeNo: "paidlive1786134867", amount: 30 });
    expect(data.status).toBe("unpaid");
    expect(data.method).toBe("atm");
    expect(data.paidAt).toBeUndefined();
    expect((data.raw as Record<string, unknown>).PayInfo).toBe("(004)TestAccount12345");
  });

  it("maps OrderStatus 9 (付款中-待銀行確認) to pending", async () => {
    server.use(http.post(QUERY_URL, () => HttpResponse.json(querySuccess(QUERY_PENDING_RESULT))));
    const data = await testProvider().getPayment({ merTradeNo: "order_twqr_001", amount: 500 });
    expect(data.status).toBe("pending");
    expect(data.method).toBe("twqr");
  });

  it("maps TradeStatus 2/3/6 to failed/canceled/refunded and passes unknown through", async () => {
    const cases = [
      { fixture: QUERY_CREDIT_FAILED_RESULT, status: "failed" },
      { fixture: QUERY_CREDIT_CANCELED_RESULT, status: "canceled" },
      { fixture: QUERY_CREDIT_REFUNDED_RESULT, status: "refunded" },
      { fixture: { ...QUERY_CREDIT_PAID_RESULT, TradeStatus: "8" }, status: "8" },
    ];
    for (const { fixture, status } of cases) {
      server.use(http.post(QUERY_URL, () => HttpResponse.json(querySuccess(fixture))));
      const data = await testProvider().getPayment({
        merTradeNo: String(fixture.MerchantOrderNo),
        amount: 30,
      });
      expect(data.status).toBe(status);
    }
  });
});

describe("NewebPay getPayment — request signing", () => {
  it("sends Version 1.3 + a CheckValue over Amt/MerchantID/MerchantOrderNo", async () => {
    let captured: Record<string, string> | undefined;
    server.use(
      http.post(QUERY_URL, async ({ request }) => {
        captured = Object.fromEntries(new URLSearchParams(await request.text()).entries());
        return HttpResponse.json(querySuccess(QUERY_CREDIT_PAID_RESULT));
      }),
    );
    await testProvider().getPayment({ merTradeNo: "Vanespl_ec_1695795668", amount: 30 });

    expect(captured?.MerchantID).toBe(MERCHANT);
    expect(captured?.Version).toBe("1.3");
    expect(captured?.RespondType).toBe("JSON");
    expect(captured?.Amt).toBe("30");
    expect(captured?.Gateway).toBeUndefined();
    expect(captured?.CheckValue).toBe(
      checkValue(
        { Amt: 30, MerchantID: MERCHANT, MerchantOrderNo: "Vanespl_ec_1695795668" },
        KEY,
        IV,
      ),
    );
  });

  it("adds Gateway=Composite for MS5-prefixed composite shops", async () => {
    let captured: Record<string, string> | undefined;
    server.use(
      http.post(QUERY_URL, async ({ request }) => {
        captured = Object.fromEntries(new URLSearchParams(await request.text()).entries());
        return HttpResponse.json(
          querySuccess({ ...QUERY_CREDIT_PAID_RESULT, MerchantID: "MS5001234" }),
        );
      }),
    );
    await testProvider({ merchantId: "MS5001234" })
      .getPayment({ merTradeNo: "Vanespl_ec_1695795668", amount: 30 })
      .catch(() => undefined); // CheckCode uses the fixture's shop — only the request matters here
    expect(captured?.Gateway).toBe("Composite");
  });
});

describe("NewebPay getPayment — integrity + error mapping", () => {
  it("rejects a tampered response CheckCode with AUTH", async () => {
    const bad = querySuccess(QUERY_CREDIT_PAID_RESULT);
    (bad.Result as Record<string, unknown>).CheckCode = "0".repeat(64);
    server.use(http.post(QUERY_URL, () => HttpResponse.json(bad)));
    const err = await testProvider()
      .getPayment({ merTradeNo: "Vanespl_ec_1695795668", amount: 30 })
      .catch((e) => e);
    expect((err as PaymentError).code).toBe("AUTH");
  });

  it("maps TRA10021 (查無交易) to NOT_FOUND, preserving the gateway's own message", async () => {
    // Shape + message as recorded live 2026-08-07: {"Status":"TRA10021",
    // "Message":"查無交易資料","Result":[]}.
    server.use(
      http.post(QUERY_URL, () => HttpResponse.json(gatewayError("TRA10021", "查無交易資料"))),
    );
    const err = await testProvider()
      .getPayment({ merTradeNo: "NOPE1", amount: 1 })
      .catch((e) => e);
    expect(isPaymentError(err)).toBe(true);
    expect((err as PaymentError).code).toBe("NOT_FOUND");
    expect((err as PaymentError).rawCode).toBe("TRA10021");
    expect((err as PaymentError).rawMessage).toBe("查無交易資料");
    expect((err as PaymentError).message).toContain("查無該筆交易");
  });

  it("maps TRA10054 (CheckValue 錯誤) to AUTH and TRA10071 (查詢鎖定) to PROVIDER", async () => {
    server.use(http.post(QUERY_URL, () => HttpResponse.json(gatewayError("TRA10054"))));
    let err = await testProvider()
      .getPayment({ merTradeNo: "x1", amount: 1 })
      .catch((e) => e);
    expect((err as PaymentError).code).toBe("AUTH");

    server.use(http.post(QUERY_URL, () => HttpResponse.json(gatewayError("TRA10071"))));
    err = await testProvider()
      .getPayment({ merTradeNo: "x1", amount: 1 })
      .catch((e) => e);
    expect((err as PaymentError).code).toBe("PROVIDER");
  });

  it("wraps a non-2xx HTTP response as PROVIDER and a transport failure as NETWORK", async () => {
    server.use(http.post(QUERY_URL, () => new HttpResponse("oops", { status: 500 })));
    let err = await testProvider()
      .getPayment({ merTradeNo: "x1", amount: 1 })
      .catch((e) => e);
    expect((err as PaymentError).code).toBe("PROVIDER");
    expect((err as PaymentError).rawCode).toBe("500");

    server.use(http.post(QUERY_URL, () => HttpResponse.error()));
    err = await testProvider()
      .getPayment({ merTradeNo: "x1", amount: 1 })
      .catch((e) => e);
    expect((err as PaymentError).code).toBe("NETWORK");
  });

  it("wraps a non-JSON body as PROVIDER", async () => {
    server.use(http.post(QUERY_URL, () => new HttpResponse("<html>maintenance</html>")));
    const err = await testProvider()
      .getPayment({ merTradeNo: "x1", amount: 1 })
      .catch((e) => e);
    expect((err as PaymentError).code).toBe("PROVIDER");
    expect((err as PaymentError).message).toContain("不是 JSON");
  });

  it("validates locally (no network): missing order id, missing amount, missing creds", async () => {
    let err = await testProvider()
      .getPayment({ amount: 1 })
      .catch((e) => e);
    expect((err as PaymentError).code).toBe("VALIDATION");

    err = await testProvider()
      .getPayment({ merTradeNo: "x1" } as never)
      .catch((e) => e);
    expect((err as PaymentError).code).toBe("VALIDATION");

    err = await testProvider({ hashKey: undefined })
      .getPayment({ merTradeNo: "x1", amount: 1 })
      .catch((e) => e);
    expect((err as PaymentError).code).toBe("AUTH");
  });
});

describe("NewebPay refund / capture / cancel (CreditCard Close + Cancel)", () => {
  it("refundPayment posts an encrypted Close envelope with CloseType=2", async () => {
    let captured: ReturnType<typeof parseEnvelopeRequest> | undefined;
    server.use(
      http.post(CLOSE_URL, async ({ request }) => {
        captured = parseEnvelopeRequest(await request.text());
        return HttpResponse.json(actionSuccess(CLOSE_REFUND_RESULT, { message: "退款申請成功" }));
      }),
    );
    const result = await testProvider().refundPayment({
      orderId: "Vanespl_ec_1695795668",
      amount: 30,
    });

    expect(captured?.merchantId).toBe(MERCHANT);
    expect(captured?.params.CloseType).toBe("2");
    expect(captured?.params.Cancel).toBeUndefined();
    expect(captured?.params.IndexType).toBe("1");
    expect(captured?.params.MerchantOrderNo).toBe("Vanespl_ec_1695795668");
    expect(captured?.params.Amt).toBe("30");
    expect(captured?.params.Version).toBe("1.1");

    expect(result.status).toBe("SUCCESS");
    expect(result.tradeNo).toBe("23092714215835071");
    expect(result.amount).toBe(30);
  });

  it("capturePayment / cancelCapture / cancelRefund pick the right CloseType+Cancel", async () => {
    const seen: Array<Record<string, string>> = [];
    server.use(
      http.post(CLOSE_URL, async ({ request }) => {
        seen.push(parseEnvelopeRequest(await request.text()).params);
        return HttpResponse.json(actionSuccess(CLOSE_REFUND_RESULT));
      }),
    );
    const provider = testProvider();
    await provider.capturePayment({ orderId: "o1", amount: 30 });
    await provider.cancelCapture({ orderId: "o1", amount: 30 });
    await provider.cancelRefund({ orderId: "o1", amount: 30 });

    expect(seen.map((p) => [p.CloseType, p.Cancel])).toEqual([
      ["1", undefined],
      ["1", "1"],
      ["2", "1"],
    ]);
  });

  it("uses IndexType=2 with TradeNo when a tradeNo is given", async () => {
    let captured: ReturnType<typeof parseEnvelopeRequest> | undefined;
    server.use(
      http.post(CLOSE_URL, async ({ request }) => {
        captured = parseEnvelopeRequest(await request.text());
        return HttpResponse.json(actionSuccess(CLOSE_REFUND_RESULT));
      }),
    );
    await testProvider().refundPayment({
      orderId: "o1",
      tradeNo: "23092714215835071",
      amount: 30,
    });
    expect(captured?.params.IndexType).toBe("2");
    expect(captured?.params.TradeNo).toBe("23092714215835071");
  });

  it("maps TRA10027 (重複請款) to CONFLICT with the gateway message", async () => {
    server.use(http.post(CLOSE_URL, () => HttpResponse.json(gatewayError("TRA10027"))));
    const err = await testProvider()
      .capturePayment({ orderId: "o1", amount: 30 })
      .catch((e) => e);
    expect((err as PaymentError).code).toBe("CONFLICT");
    expect((err as PaymentError).rawCode).toBe("TRA10027");
  });

  it("refundPayment without an amount is VALIDATION (no network)", async () => {
    const err = await testProvider()
      .refundPayment({ orderId: "o1" })
      .catch((e) => e);
    expect((err as PaymentError).code).toBe("VALIDATION");
  });

  it("cancelAuthorization verifies the response CheckCode and reports SUCCESS", async () => {
    let captured: ReturnType<typeof parseEnvelopeRequest> | undefined;
    server.use(
      http.post(CANCEL_URL, async ({ request }) => {
        captured = parseEnvelopeRequest(await request.text());
        return HttpResponse.json(
          actionSuccess(CANCEL_AUTH_RESULT, { message: "放棄授權成功", checkCode: true }),
        );
      }),
    );
    const result = await testProvider().cancelAuthorization({
      orderId: "Vanespl_ec_1695795668",
      amount: 30,
    });
    expect(captured?.params.Version).toBe("1.0");
    expect(captured?.params.IndexType).toBe("1");
    expect(result.queued).toBe(false);
    expect(result.status).toBe("SUCCESS");
  });

  it("treats TRA20001 as an accepted, bank-batch-queued cancel", async () => {
    server.use(
      http.post(CANCEL_URL, () =>
        HttpResponse.json(
          actionSuccess(CANCEL_AUTH_RESULT, {
            status: "TRA20001",
            message: "金融機構取消授權批次處理中",
            checkCode: true,
          }),
        ),
      ),
    );
    const result = await testProvider().cancelAuthorization({ orderId: "o1", amount: 30 });
    expect(result.queued).toBe(true);
    expect(result.status).toBe("TRA20001");
  });

  it("maps the recorded cancel error envelope (Result object, CheckCode over empty ids)", async () => {
    // Field-exact with the live recording 2026-08-07: an error Status arrives
    // WITH a Result object whose CheckCode is computed over the empty
    // MerchantOrderNo/TradeNo strings — must throw NOT_FOUND, never resolve.
    server.use(
      http.post(CANCEL_URL, () =>
        HttpResponse.json({
          Status: "TRA10021",
          Message: "查無該筆交易或該筆交易不為信用卡交易，請查明",
          Result: {
            MerchantID: MERCHANT,
            Amt: 30,
            MerchantOrderNo: "",
            TradeNo: "",
            CheckCode: responseCheckCode({
              Amt: 30,
              MerchantID: MERCHANT,
              MerchantOrderNo: "",
              TradeNo: "",
            }),
          },
        }),
      ),
    );
    const err = await testProvider()
      .cancelAuthorization({ orderId: "nope1", amount: 30 })
      .catch((e) => e);
    expect(isPaymentError(err)).toBe(true);
    expect((err as PaymentError).code).toBe("NOT_FOUND");
    expect((err as PaymentError).rawCode).toBe("TRA10021");
  });

  it("rejects a tampered cancelAuthorization CheckCode with AUTH", async () => {
    server.use(
      http.post(CANCEL_URL, () =>
        HttpResponse.json(actionSuccess({ ...CANCEL_AUTH_RESULT, CheckCode: "0".repeat(64) })),
      ),
    );
    const err = await testProvider()
      .cancelAuthorization({ orderId: "o1", amount: 30 })
      .catch((e) => e);
    expect((err as PaymentError).code).toBe("AUTH");
  });

  it("credit actions without orderId or tradeNo are VALIDATION (no network)", async () => {
    const err = await testProvider()
      .capturePayment({ amount: 30 })
      .catch((e) => e);
    expect((err as PaymentError).code).toBe("VALIDATION");
  });

  it("every credit action rejects a non-finite amount locally (no network)", async () => {
    const provider = testProvider();
    for (const call of [
      () => provider.capturePayment({ orderId: "o1", amount: Number.NaN }),
      () => provider.cancelCapture({ orderId: "o1", amount: Number.NaN }),
      () => provider.cancelRefund({ orderId: "o1", amount: Number.NaN }),
      () => provider.cancelAuthorization({ orderId: "o1", amount: Number.NaN }),
      () => provider.cancelAuthorization({ orderId: "o1", amount: undefined as never }),
    ]) {
      const err = await call().catch((e) => e);
      expect((err as PaymentError).code).toBe("VALIDATION");
    }
  });
});

describe("NewebPay capabilities", () => {
  it("declares CREATE_PAYMENT, GET_PAYMENT, and REFUND_PAYMENT", () => {
    const provider = testProvider();
    expect(supports(provider, "CREATE_PAYMENT")).toBe(true);
    expect(supports(provider, "GET_PAYMENT")).toBe(true);
    expect(supports(provider, "REFUND_PAYMENT")).toBe(true);
  });
});
