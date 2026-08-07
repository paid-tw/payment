import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { isPaymentError, PaymentError, supports } from "@paid-tw/payment";
import { decryptTradeInfo } from "../../crypto.js";
import {
  ALTER_AMT_URL,
  ALTER_STATUS_URL,
  encryptPeriod,
  KEY,
  IV,
  MERCHANT,
  parseEnvelopeRequest,
  server,
  testPeriodProvider,
} from "./period-server.js";
import {
  CYCLE_NOTIFY_FAILED_JSON,
  CYCLE_NOTIFY_JSON,
  MANUAL_ALTER_AMT_RESP_HEX,
  MANUAL_ALTER_STATUS_RESP_HEX,
  MANUAL_CREATE_RESULT_HEX,
} from "./period-fixtures.js";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const CREATE_INPUT = {
  orderId: "myorder1700033460",
  currency: "TWD",
  method: "card" as const,
  prodDesc: "Test commssion",
  amount: 10,
  periodType: "M" as const,
  periodPoint: "05",
  periodTimes: 12,
  startType: 2 as const,
  payerEmail: "test@neweb.com.tw",
  notifyUrl: "https://shop.example/period/notify",
};

describe("period createPayment — mandate checkout form (no network)", () => {
  it("builds the MerchantID_/PostData_ form for the hosted card page", async () => {
    const form = await testPeriodProvider().createPayment({
      ...CREATE_INPUT,
      paymentInfo: "Y",
      orderInfo: "N",
      emailModify: 1,
      langType: "zh-Tw",
    });

    expect(form.mode).toBe("redirect");
    expect(form.action).toBe("https://newebpay-period.test/MPG/period");
    expect(form.params.MerchantID_).toBe(MERCHANT);

    const inner = Object.fromEntries(
      new URLSearchParams(decryptTradeInfo(form.params.PostData_, KEY, IV)).entries(),
    );
    expect(inner.RespondType).toBe("JSON");
    expect(inner.Version).toBe("1.5");
    expect(inner.MerOrderNo).toBe("myorder1700033460");
    expect(inner.ProdDesc).toBe("Test commssion");
    expect(inner.PeriodAmt).toBe("10");
    expect(inner.PeriodType).toBe("M");
    expect(inner.PeriodPoint).toBe("05");
    expect(inner.PeriodStartType).toBe("2");
    expect(inner.PeriodTimes).toBe("12");
    expect(inner.PayerEmail).toBe("test@neweb.com.tw");
    expect(inner.PaymentInfo).toBe("Y");
    expect(inner.OrderInfo).toBe("N");
    expect(inner.NotifyURL).toBe("https://shop.example/period/notify");
    expect(inner.TimeStamp).toMatch(/^\d+$/);
  });

  it("validates the schedule locally", async () => {
    const reject = (
      patch: Partial<Parameters<ReturnType<typeof testPeriodProvider>["createPayment"]>[0]>,
    ) =>
      testPeriodProvider()
        .createPayment({ ...CREATE_INPUT, ...patch })
        .then(
          () => {
            throw new Error("expected createPayment to reject");
          },
          (e) => e as PaymentError,
        );

    expect((await reject({ orderId: "bad-order" })).code).toBe("VALIDATION");
    expect((await reject({ currency: "USD" })).code).toBe("VALIDATION");
    expect((await reject({ method: "atm" as never })).code).toBe("VALIDATION");
    expect((await reject({ prodDesc: "" })).code).toBe("VALIDATION");
    expect((await reject({ payerEmail: "" })).code).toBe("VALIDATION");
    expect((await reject({ amount: 0 })).code).toBe("VALIDATION");
    expect((await reject({ periodTimes: 0 })).code).toBe("VALIDATION");
    expect((await reject({ periodTimes: 100 })).code).toBe("VALIDATION");
    // PeriodPoint must match the PeriodType's format.
    expect((await reject({ periodType: "D", periodPoint: "1" })).code).toBe("VALIDATION");
    expect((await reject({ periodType: "W", periodPoint: "8" })).code).toBe("VALIDATION");
    expect((await reject({ periodType: "M", periodPoint: "5" })).code).toBe("VALIDATION");
    expect((await reject({ periodType: "Y", periodPoint: "1332" })).code).toBe("VALIDATION");
    // PeriodFirstdate only with D + startType 3.
    expect((await reject({ firstDate: "2026/09/01" })).code).toBe("VALIDATION");
    const ok = await testPeriodProvider().createPayment({
      ...CREATE_INPUT,
      periodType: "D",
      periodPoint: "40",
      startType: 3,
      firstDate: "2026/09/01",
    });
    expect(ok.mode).toBe("redirect");
  });

  it('accepts PeriodTimes "NE" (CAU unlimited)', async () => {
    const form = await testPeriodProvider().createPayment({ ...CREATE_INPUT, periodTimes: "NE" });
    const inner = Object.fromEntries(
      new URLSearchParams(decryptTradeInfo(form.params.PostData_, KEY, IV)).entries(),
    );
    expect(inner.PeriodTimes).toBe("NE");
  });
});

describe("period alterStatus [NPA-B051]", () => {
  it("posts the encrypted envelope and decodes the manual's suspend response verbatim", async () => {
    let captured: ReturnType<typeof parseEnvelopeRequest> | undefined;
    server.use(
      http.post(ALTER_STATUS_URL, async ({ request }) => {
        captured = parseEnvelopeRequest(await request.text());
        // The manual prints the AlterStatus response key lowercase (`period`).
        return HttpResponse.json({ period: MANUAL_ALTER_STATUS_RESP_HEX });
      }),
    );
    const result = await testPeriodProvider().alterStatus({
      orderId: "myorder1700033460",
      periodNo: "P231115153213aMDNWZ",
      alterType: "suspend",
    });

    expect(captured?.merchantId).toBe(MERCHANT);
    expect(captured?.params.Version).toBe("1.0");
    expect(captured?.params.AlterType).toBe("suspend");
    expect(captured?.params.MerOrderNo).toBe("myorder1700033460");
    expect(captured?.params.PeriodNo).toBe("P231115153213aMDNWZ");

    expect(result.status).toBe("SUCCESS");
    expect(result.merOrderNo).toBe("myorder1700033460");
    expect(result.periodNo).toBe("P231115153213aMDNWZ");
    expect(result.alterType).toBe("suspend");
  });

  it("maps an encrypted PER10061 (已暫停) rejection to CONFLICT", async () => {
    server.use(
      http.post(ALTER_STATUS_URL, () =>
        HttpResponse.json({
          period: encryptPeriod(
            JSON.stringify({ Status: "PER10061", Message: "無法重複暫停", Result: {} }),
          ),
        }),
      ),
    );
    const err = await testPeriodProvider()
      .alterStatus({ orderId: "o1", periodNo: "P1", alterType: "suspend" })
      .catch((e) => e);
    expect(isPaymentError(err)).toBe(true);
    expect((err as PaymentError).code).toBe("CONFLICT");
    expect((err as PaymentError).rawCode).toBe("PER10061");
  });

  it("maps a plaintext envelope rejection (no period field) onto the error table", async () => {
    server.use(
      http.post(ALTER_STATUS_URL, () =>
        HttpResponse.json({ Status: "PER10004", Message: "PeriodNo 資料不齊全" }),
      ),
    );
    const err = await testPeriodProvider()
      .alterStatus({ orderId: "o1", periodNo: "P1", alterType: "suspend" })
      .catch((e) => e);
    expect((err as PaymentError).code).toBe("VALIDATION");
    expect((err as PaymentError).rawCode).toBe("PER10004");
  });

  it("validates alterType and the mandate reference locally (no network)", async () => {
    let err = await testPeriodProvider()
      .alterStatus({ orderId: "o1", periodNo: "P1", alterType: "pause" as never })
      .catch((e) => e);
    expect((err as PaymentError).code).toBe("VALIDATION");

    err = await testPeriodProvider()
      .alterStatus({ orderId: "", periodNo: "P1", alterType: "suspend" })
      .catch((e) => e);
    expect((err as PaymentError).code).toBe("VALIDATION");
  });

  it("wraps HTTP 500 as PROVIDER and transport failures as NETWORK", async () => {
    server.use(http.post(ALTER_STATUS_URL, () => new HttpResponse("oops", { status: 500 })));
    let err = await testPeriodProvider()
      .alterStatus({ orderId: "o1", periodNo: "P1", alterType: "suspend" })
      .catch((e) => e);
    expect((err as PaymentError).code).toBe("PROVIDER");

    server.use(http.post(ALTER_STATUS_URL, () => HttpResponse.error()));
    err = await testPeriodProvider()
      .alterStatus({ orderId: "o1", periodNo: "P1", alterType: "suspend" })
      .catch((e) => e);
    expect((err as PaymentError).code).toBe("NETWORK");
  });
});

describe("period alterAmount [NPA-B052]", () => {
  it("posts the encrypted envelope and decodes the manual's response verbatim", async () => {
    let captured: ReturnType<typeof parseEnvelopeRequest> | undefined;
    server.use(
      http.post(ALTER_AMT_URL, async ({ request }) => {
        captured = parseEnvelopeRequest(await request.text());
        return HttpResponse.json({ Period: MANUAL_ALTER_AMT_RESP_HEX });
      }),
    );
    const result = await testPeriodProvider().alterAmount({
      orderId: "myorder1700033460",
      periodNo: "P231115153213aMDNWZ",
      amount: 15,
    });

    expect(captured?.params.Version).toBe("1.2");
    expect(captured?.params.AlterAmt).toBe("15");

    expect(result.status).toBe("SUCCESS");
    expect(result.amount).toBe(15);
    expect(result.newNextAmt).toBe(15);
    expect(result.newNextTime).toBe("2023-12-05");
    expect(result.periodTimes).toBe(12);
    expect(result.cardExpiry).toBe("2908");
    expect(result.notifyUrl).toBe("-"); // "-" = NotifyURL not modified
  });

  it("requires periodType+periodPoint as a pair and periodTimes with cardExpiry", async () => {
    let err = await testPeriodProvider()
      .alterAmount({ orderId: "o1", periodNo: "P1", periodType: "M" })
      .catch((e) => e);
    expect((err as PaymentError).code).toBe("VALIDATION");

    err = await testPeriodProvider()
      .alterAmount({ orderId: "o1", periodNo: "P1", cardExpiry: "3105" })
      .catch((e) => e);
    expect((err as PaymentError).code).toBe("VALIDATION");
  });
});

describe("period notify verification", () => {
  it("decodes the manual's create-result blob verbatim (Period key)", () => {
    const notify = testPeriodProvider().verifyPeriodCreateNotify({
      Period: MANUAL_CREATE_RESULT_HEX,
    });
    expect(notify.success).toBe(true);
    expect(notify.message).toBe("委託單成立，且首次授權成功");
    expect(notify.merchantId).toBe(MERCHANT);
    expect(notify.merTradeNo).toBe("myorder1700033460");
    expect(notify.periodNo).toBe("P231115153213aMDNWZ");
    expect(notify.periodType).toBe("M");
    expect(notify.periodAmt).toBe(10);
    expect(notify.authTimes).toBe(12);
    expect(notify.dateArray).toHaveLength(12);
    expect(notify.dateArray[0]).toBe("2023-11-15"); // P1 ran at creation (startType 2)
    expect(notify.auth).toMatchObject({
      tradeNo: "23111515321368339",
      cardNo: "400022******1111",
      authCode: "230297",
      respondCode: "00",
      escrowBank: "HNCB",
      authBank: "KGI",
      paymentMethod: "CREDIT",
    });
  });

  it("accepts the lowercase `period` envelope key", () => {
    const notify = testPeriodProvider().verifyPeriodCreateNotify({
      period: MANUAL_CREATE_RESULT_HEX,
    });
    expect(notify.success).toBe(true);
  });

  it("normalizes an N050 cycle notify, parsing the OrderNo period suffix", () => {
    const notify = testPeriodProvider().verifyPeriodCycleNotify({
      Period: encryptPeriod(CYCLE_NOTIFY_JSON),
    });
    expect(notify.success).toBe(true);
    expect(notify.merTradeNo).toBe("periodi1655708272");
    expect(notify.orderNo).toBe("periodi1655708272_2");
    expect(notify.periodSequence).toBe(2);
    expect(notify.tradeNo).toBe("22062407181613548");
    expect(notify.totalTimes).toBe(12);
    expect(notify.alreadyTimes).toBe(2);
    expect(notify.amount).toBe(20);
    expect(notify.nextAuthDate).toBe("2022-06-26");
    expect(notify.periodNo).toBe("P220620145859us4Rlj");
  });

  it("reports a failed period as success:false with the code preserved", () => {
    const notify = testPeriodProvider().verifyPeriodCycleNotify({
      Period: encryptPeriod(CYCLE_NOTIFY_FAILED_JSON),
    });
    expect(notify.success).toBe(false);
    expect(notify.status).toBe("TRA10035");
    expect(notify.periodSequence).toBe(3);
  });

  it("rejects a blob encrypted under another shop's keys with AUTH", () => {
    const err = (() => {
      try {
        testPeriodProvider({
          hashKey: "Z".repeat(32),
          hashIv: "W".repeat(16),
        }).verifyPeriodCreateNotify({ Period: MANUAL_CREATE_RESULT_HEX });
      } catch (e) {
        return e;
      }
      throw new Error("expected the verifier to throw");
    })();
    expect(isPaymentError(err)).toBe(true);
    expect((err as PaymentError).code).toBe("AUTH");
  });

  it("rejects a missing Period field with AUTH", () => {
    const err = (() => {
      try {
        testPeriodProvider().verifyPeriodCycleNotify({ Status: "SUCCESS" });
      } catch (e) {
        return e;
      }
      throw new Error("expected the verifier to throw");
    })();
    expect((err as PaymentError).code).toBe("AUTH");
  });
});

describe("period capabilities", () => {
  it("declares only CREATE_PAYMENT; query/refund reject as UNSUPPORTED", async () => {
    const provider = testPeriodProvider();
    expect(supports(provider, "CREATE_PAYMENT")).toBe(true);
    expect(supports(provider, "GET_PAYMENT")).toBe(false);
    expect(supports(provider, "REFUND_PAYMENT")).toBe(false);

    const queryErr = await provider.getPayment({}).catch((e) => e);
    expect((queryErr as PaymentError).code).toBe("UNSUPPORTED");
    const refundErr = await provider.refundPayment({ orderId: "o" }).catch((e) => e);
    expect((refundErr as PaymentError).code).toBe("UNSUPPORTED");
  });
});
