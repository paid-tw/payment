import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { computeCheckMacValue } from "../provider.js";
import { PaymentError, supports } from "@paid-tw/payment";
import {
  DOACTION_URL,
  HASH_IV,
  HASH_KEY,
  queryResponse,
  QUERY_URL,
  server,
  stageQueryHandlers,
  testProvider,
} from "./ecpay-server.js";
import {
  QUERY_BAD_MERTRADENO,
  QUERY_NOT_FOUND,
  QUERY_PAID,
  STAGE_PAID_MER_TRADE_NO,
  STAGE_PROBE_MER_TRADE_NO,
} from "./ecpay-fixtures.js";
import { ECPAY_SANDBOX } from "../config.js";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
// Restore default stage-sim handlers after each test's server.use overrides.
afterEach(() => {
  server.resetHandlers(...stageQueryHandlers);
});
afterAll(() => server.close());

describe("ECPay CheckMacValue", () => {
  // ECPay's documented worked example — the single most important regression
  // guard: if the sort / .NET-encode / SHA256 pipeline drifts, this breaks.
  // https://developers.ecpay.com.tw/?p=2902
  it("reproduces the documented worked example", () => {
    const params = {
      MerchantID: "3002607",
      MerchantTradeNo: "ecpay20230312153023",
      MerchantTradeDate: "2023/03/12 15:30:23",
      PaymentType: "aio",
      TotalAmount: "30000",
      TradeDesc: "促銷方案",
      ItemName: "Apple iphone 15",
      ReturnURL: "https://www.ecpay.com.tw/receive.php",
      ChoosePayment: "ALL",
      EncryptType: "1",
    };
    expect(computeCheckMacValue(params, "pwFHCqoQZGmho4w6", "EkRm7iFT261dpevs")).toBe(
      "6C51C9E6888DE861FD62FB1DD17029FC742634498FD813DC43D4243B5685B840",
    );
  });

  // Second golden, independently verified against the live stage cashier: an
  // ItemName with `'` and `~` (which .NET/PHP encode to %27/%7E but
  // encodeURIComponent leaves literal). ECPay accepted exactly this MAC; the old
  // encoder produced "CheckMacValue Error". Guards the '/~ encoding path.
  it("encodes ' and ~ like ECPay (stage-verified worked example)", () => {
    const params = {
      MerchantID: "3002607",
      MerchantTradeNo: "probeenc001",
      MerchantTradeDate: "2026/07/02 10:00:00",
      PaymentType: "aio",
      TotalAmount: "100",
      TradeDesc: "probe",
      ItemName: "Apple's ~deal",
      ReturnURL: "https://example.com/n",
      ChoosePayment: "Credit",
      EncryptType: "1",
    };
    expect(computeCheckMacValue(params, "pwFHCqoQZGmho4w6", "EkRm7iFT261dpevs")).toBe(
      "D1CAD631D46964035334D5A66DEEB46A11DBB737D9FAABF8C7DEB9D864D2AFB2",
    );
  });

  it("ignores a pre-existing CheckMacValue key in the input", () => {
    const base = { MerchantID: "3002607", TradeAmt: "100" };
    const withMac = { ...base, CheckMacValue: "STALE" };
    expect(computeCheckMacValue(withMac, HASH_KEY, HASH_IV)).toBe(
      computeCheckMacValue(base, HASH_KEY, HASH_IV),
    );
  });
});

describe("ECPay getPayment (QueryTradeInfo)", () => {
  it("normalizes a paid credit-card query", async () => {
    server.use(
      http.post(QUERY_URL, () =>
        HttpResponse.text(
          queryResponse({
            MerchantID: "3002607",
            MerchantTradeNo: "ORDER-A1",
            TradeNo: "2303121530231234",
            TradeAmt: "30000",
            PaymentDate: "2023/03/12 15:31:00",
            PaymentType: "Credit_CreditCard",
            TradeStatus: "1",
            HandlingCharge: "10",
          }),
        ),
      ),
    );

    const data = await testProvider().getPayment({ merTradeNo: "ORDER-A1" });

    expect(data.status).toBe("paid");
    expect(data.method).toBe("card");
    expect(data.amount).toBe(30000);
    expect(data.tradeNo).toBe("2303121530231234");
    expect(data.merTradeNo).toBe("ORDER-A1");
    expect(data.paidAt).toBe("2023/03/12 15:31:00");
  });

  it("maps an unpaid ATM order (TradeStatus 0)", async () => {
    server.use(
      http.post(QUERY_URL, () =>
        HttpResponse.text(
          queryResponse({
            MerchantTradeNo: "ORDER-A2",
            TradeAmt: "500",
            PaymentType: "ATM_TAISHIN",
            TradeStatus: "0",
          }),
        ),
      ),
    );
    const data = await testProvider().getPayment({ merTradeNo: "ORDER-A2" });
    expect(data.status).toBe("unpaid");
    expect(data.method).toBe("atm");
  });

  it("signs the request with a valid CheckMacValue over MerchantTradeNo + TimeStamp", async () => {
    let body: Record<string, string> | undefined;
    server.use(
      http.post(QUERY_URL, async ({ request }) => {
        body = Object.fromEntries(new URLSearchParams(await request.text()).entries());
        return HttpResponse.text(queryResponse({ MerchantTradeNo: "ORDER-A1", TradeStatus: "1" }));
      }),
    );

    await testProvider().getPayment({ merTradeNo: "ORDER-A1" });

    expect(body?.MerchantTradeNo).toBe("ORDER-A1");
    expect(body?.TimeStamp).toMatch(/^\d+$/);
    expect(body?.CheckMacValue).toBe(computeCheckMacValue(body!, HASH_KEY, HASH_IV));
  });

  it("rejects a response whose CheckMacValue does not verify", async () => {
    server.use(
      http.post(QUERY_URL, () =>
        HttpResponse.text(
          new URLSearchParams({
            MerchantTradeNo: "ORDER-A1",
            TradeStatus: "1",
            CheckMacValue: "DEADBEEF",
          }).toString(),
        ),
      ),
    );
    const err = await testProvider()
      .getPayment({ merTradeNo: "ORDER-A1" })
      .catch((e) => e);
    expect((err as PaymentError).code).toBe("PROVIDER");
  });

  it("maps a `code|message` error body to a PROVIDER error", async () => {
    server.use(http.post(QUERY_URL, () => HttpResponse.text("0|CheckMacValue Error")));
    const err = await testProvider()
      .getPayment({ merTradeNo: "ORDER-A1" })
      .catch((e) => e);
    expect((err as PaymentError).code).toBe("PROVIDER");
    expect((err as PaymentError).rawCode).toBe("0");
  });

  it("wraps a non-2xx response as PROVIDER and a transport failure as NETWORK", async () => {
    server.use(http.post(QUERY_URL, () => new HttpResponse("bad", { status: 500 })));
    const provErr = await testProvider()
      .getPayment({ merTradeNo: "x" })
      .catch((e) => e);
    expect((provErr as PaymentError).code).toBe("PROVIDER");

    server.use(http.post(QUERY_URL, () => HttpResponse.error()));
    const netErr = await testProvider()
      .getPayment({ merTradeNo: "x" })
      .catch((e) => e);
    expect((netErr as PaymentError).code).toBe("NETWORK");
  });
});

describe("ECPay getPayment — MSW stage simulator (default handlers + recorded fixtures)", () => {
  // Default handlers in ecpay-server.ts replay field-exact stage fixtures for
  // known MerchantTradeNo values (same keys as ECPAY_SANDBOX / live).
  it("uses public sandbox credentials (3002607) for MSW + live parity", () => {
    expect(HASH_KEY).toBe(ECPAY_SANDBOX.hashKey);
    expect(HASH_IV).toBe(ECPAY_SANDBOX.hashIv);
    expect(ECPAY_SANDBOX.merchantId).toBe("3002607");
  });

  it("normalizes a real settled credit-card order via default stage handler", async () => {
    // No server.use — hits stageQueryHandlers for STAGE_PAID_MER_TRADE_NO.
    const data = await testProvider().getPayment({ merTradeNo: STAGE_PAID_MER_TRADE_NO });
    expect(data.status).toBe("paid");
    expect(data.method).toBe("card");
    expect(data.amount).toBe(1234);
    expect(data.tradeNo).toBe("2607022124117236");
    expect(data.merTradeNo).toBe(STAGE_PAID_MER_TRADE_NO);
    expect(data.paidAt).toBe("2026/07/02 21:27:45");
  });

  it("maps probe not-found (10200047) via default stage handler", async () => {
    const err = await testProvider()
      .getPayment({ merTradeNo: STAGE_PROBE_MER_TRADE_NO })
      .catch((e) => e);
    expect((err as PaymentError).code).toBe("NOT_FOUND");
    expect((err as PaymentError).rawCode).toBe("10200047");
  });

  it("maps any unknown order to NOT_FOUND (stage-shaped 10200047)", async () => {
    const err = await testProvider()
      .getPayment({ merTradeNo: "unknown-order-xyz" })
      .catch((e) => e);
    expect((err as PaymentError).code).toBe("NOT_FOUND");
    expect((err as PaymentError).rawCode).toBe("10200047");
  });

  it("still accepts an explicit field-exact QUERY_PAID body override", async () => {
    server.use(http.post(QUERY_URL, () => HttpResponse.text(QUERY_PAID)));
    const data = await testProvider().getPayment({ merTradeNo: STAGE_PAID_MER_TRADE_NO });
    expect(data.status).toBe("paid");
    expect(data.amount).toBe(1234);
  });

  it("maps the doc's not-found TradeStatus 10200095 to NOT_FOUND too", async () => {
    server.use(
      http.post(QUERY_URL, () =>
        HttpResponse.text(queryResponse({ MerchantTradeNo: "X", TradeStatus: "10200095" })),
      ),
    );
    const err = await testProvider()
      .getPayment({ merTradeNo: "X" })
      .catch((e) => e);
    expect((err as PaymentError).code).toBe("NOT_FOUND");
    expect((err as PaymentError).rawCode).toBe("10200095");
  });

  it("maps a real empty-MerchantTradeNo response (10200052) to VALIDATION", async () => {
    server.use(http.post(QUERY_URL, () => HttpResponse.text(QUERY_BAD_MERTRADENO)));
    const err = await testProvider()
      .getPayment({ merTradeNo: "whatever" })
      .catch((e) => e);
    expect((err as PaymentError).code).toBe("VALIDATION");
    expect((err as PaymentError).rawCode).toBe("10200052");
  });
});

describe("ECPay getPayment — guards (no network)", () => {
  it("requires MerchantTradeNo", async () => {
    const err = await testProvider()
      .getPayment({})
      .catch((e) => e);
    expect((err as PaymentError).code).toBe("VALIDATION");
  });

  it("requires credentials", async () => {
    const err = await testProvider({ merchantId: undefined, hashKey: undefined, hashIv: undefined })
      .getPayment({ merTradeNo: "x" })
      .catch((e) => e);
    expect((err as PaymentError).code).toBe("AUTH");
  });
});

describe("ECPay createPayment (AioCheckOut)", () => {
  it("builds a signed redirect form with mapped params", async () => {
    const form = await testProvider().createPayment({
      amount: 1000,
      currency: "TWD",
      method: "card",
      orderId: "ORDERC1",
      itemDesc: "T-shirt",
      notifyUrl: "https://shop.test/ecpay/notify",
      returnUrl: "https://shop.test/thanks",
    });

    expect(form.action).toBe("https://ecpay.test/Cashier/AioCheckOut/V5");
    expect(form.method).toBe("POST");
    expect(form.params.MerchantTradeNo).toBe("ORDERC1");
    expect(form.params.TotalAmount).toBe("1000");
    expect(form.params.ChoosePayment).toBe("Credit");
    expect(form.params.PaymentType).toBe("aio");
    expect(form.params.EncryptType).toBe("1");
    expect(form.params.ReturnURL).toBe("https://shop.test/ecpay/notify");
    expect(form.params.OrderResultURL).toBe("https://shop.test/thanks");
    expect(form.params.MerchantTradeDate).toMatch(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/);
    // The stamped CheckMacValue must verify over the rest of the params.
    expect(form.params.CheckMacValue).toBe(computeCheckMacValue(form.params, HASH_KEY, HASH_IV));
  });

  it("maps payment methods to ChoosePayment (atm/cvs/unknown->ALL)", async () => {
    const provider = testProvider();
    const build = (method: "card" | "atm" | "cvs" | "linepay") =>
      provider.createPayment({
        amount: 1,
        currency: "TWD",
        method,
        orderId: "o",
        notifyUrl: "https://shop.test/n",
      });
    expect((await build("atm")).params.ChoosePayment).toBe("ATM");
    expect((await build("cvs")).params.ChoosePayment).toBe("CVS");
    expect((await build("linepay")).params.ChoosePayment).toBe("ALL");
  });

  it("rejects a MerchantTradeNo that is not 1-20 alphanumeric chars", async () => {
    const provider = testProvider();
    for (const orderId of ["ORDER-1", "order_1", "a".repeat(21), ""]) {
      const err = await provider
        .createPayment({ amount: 1, currency: "TWD", method: "card", orderId, notifyUrl: "u" })
        .catch((e) => e);
      expect((err as PaymentError).code).toBe("VALIDATION");
    }
  });

  it("rejects a non-TWD currency and a missing notify-url", async () => {
    const provider = testProvider();
    const fx = await provider
      .createPayment({ amount: 1, currency: "USD", method: "card", orderId: "o", notifyUrl: "u" })
      .catch((e) => e);
    expect((fx as PaymentError).code).toBe("VALIDATION");

    const noNotify = await provider
      .createPayment({ amount: 1, currency: "TWD", method: "card", orderId: "o" })
      .catch((e) => e);
    expect((noNotify as PaymentError).code).toBe("VALIDATION");
  });
});

describe("ECPay refundPayment (DoAction)", () => {
  // Resolve TradeNo via QueryTradeInfo, then DoAction Action=R.
  const stubQuery = (fields: Record<string, string>) =>
    http.post(QUERY_URL, () => HttpResponse.text(queryResponse(fields)));

  it("resolves TradeNo then issues a full-amount credit refund", async () => {
    let doAction: Record<string, string> | undefined;
    server.use(
      stubQuery({
        MerchantTradeNo: "ORDER-R1",
        TradeNo: "2303120001",
        TradeAmt: "30000",
        PaymentType: "Credit_CreditCard",
        TradeStatus: "1",
      }),
      http.post(DOACTION_URL, async ({ request }) => {
        doAction = Object.fromEntries(new URLSearchParams(await request.text()).entries());
        return HttpResponse.text(
          queryResponse({
            MerchantID: "3002607",
            MerchantTradeNo: "ORDER-R1",
            TradeNo: "2303120001",
            RtnCode: "1",
            RtnMsg: "交易成功",
          }),
        );
      }),
    );

    const result = await testProvider().refundPayment({ orderId: "ORDER-R1" });

    expect(result.rtnCode).toBe("1");
    expect(result.tradeNo).toBe("2303120001");
    expect(result.amount).toBe(30000); // full refund defaults to the paid amount
    expect(doAction?.Action).toBe("R");
    expect(doAction?.TradeNo).toBe("2303120001");
    expect(doAction?.CheckMacValue).toBe(computeCheckMacValue(doAction!, HASH_KEY, HASH_IV));
  });

  it("honors a partial --amount override", async () => {
    let doAction: Record<string, string> | undefined;
    server.use(
      stubQuery({
        TradeNo: "T2",
        TradeAmt: "30000",
        PaymentType: "Credit_CreditCard",
        TradeStatus: "1",
      }),
      http.post(DOACTION_URL, async ({ request }) => {
        doAction = Object.fromEntries(new URLSearchParams(await request.text()).entries());
        return HttpResponse.text(queryResponse({ TradeNo: "T2", RtnCode: "1", RtnMsg: "OK" }));
      }),
    );
    await testProvider().refundPayment({ orderId: "ORDER-R2", amount: 100 });
    expect(doAction?.TotalAmount).toBe("100");
  });

  it("maps a DoAction RtnCode != 1 to a PROVIDER error", async () => {
    server.use(
      stubQuery({
        TradeNo: "T3",
        TradeAmt: "100",
        PaymentType: "Credit_CreditCard",
        TradeStatus: "1",
      }),
      http.post(DOACTION_URL, () =>
        HttpResponse.text(queryResponse({ TradeNo: "T3", RtnCode: "10200047", RtnMsg: "已退款" })),
      ),
    );
    const err = await testProvider()
      .refundPayment({ orderId: "ORDER-R3" })
      .catch((e) => e);
    expect((err as PaymentError).code).toBe("PROVIDER");
    expect((err as PaymentError).rawCode).toBe("10200047");
  });

  it("rejects a non-credit-card order before calling DoAction", async () => {
    server.use(
      stubQuery({ TradeNo: "T4", TradeAmt: "100", PaymentType: "ATM_TAISHIN", TradeStatus: "1" }),
    );
    const err = await testProvider()
      .refundPayment({ orderId: "ORDER-R4" })
      .catch((e) => e);
    expect((err as PaymentError).code).toBe("VALIDATION");
  });

  it("fails with NOT_FOUND when a resolvable order has no TradeNo (e.g. unpaid)", async () => {
    server.use(stubQuery({ MerchantTradeNo: "ORDER-R5", TradeStatus: "0", TradeNo: "" }));
    const err = await testProvider()
      .refundPayment({ orderId: "ORDER-R5" })
      .catch((e) => e);
    expect((err as PaymentError).code).toBe("NOT_FOUND");
  });
});

describe("ECPay capabilities", () => {
  it("declares CREATE_PAYMENT + GET_PAYMENT + REFUND_PAYMENT", () => {
    const provider = testProvider();
    expect(supports(provider.capabilities, "CREATE_PAYMENT")).toBe(true);
    expect(supports(provider.capabilities, "GET_PAYMENT")).toBe(true);
    expect(supports(provider.capabilities, "REFUND_PAYMENT")).toBe(true);
  });
});
