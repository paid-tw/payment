import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PaymentError } from "@paid-tw/payment";
import { encryptData } from "../../ecpg/aes.js";
import { ECPAY_SANDBOX_NO_3D } from "../config.js";
import { ECPAY_BACKAUTH_NOTIFY_ACK, verifyEcpayPeriodNotify } from "../notify.js";
import type { EcpayBackAuthCreateInput } from "../provider.js";
import {
  PERIOD_CANCEL_SUCCESS,
  PERIOD_CREATE_SUCCESS,
  PERIOD_QUERY_ACTIVE,
  PERIOD_QUERY_CANCELLED,
  PERIOD_REAUTH_CANCELLED,
} from "./backauth-fixtures.js";
import {
  AUTH_URL,
  capture,
  PERIOD_ACTION_URL,
  QUERY_URL,
  respondWith,
  server,
  testCard,
  testProvider,
} from "./backauth-server.js";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/**
 * Offline 定期定額 behaviour, replayed from payloads recorded on ECPay stage. The live
 * suite proves these payloads are real; this suite proves we read them correctly, and
 * covers the branches that are unreachable or too costly to reach live (每天/每月
 * schedules would authorize a real charge on a cadence we would then have to chase).
 */
function base(overrides: Partial<EcpayBackAuthCreateInput> = {}): EcpayBackAuthCreateInput {
  return {
    amount: 5,
    currency: "TWD",
    method: "card",
    orderId: "PDTEST0001",
    itemDesc: "paid-tw period",
    notifyUrl: "https://shop.test/notify",
    orderResultUrl: "https://shop.test/result",
    card: testCard(),
    // Required by the ConsumerInfo guard, which runs before the schedule checks — so
    // leaving them out here would make every period assertion pass for the wrong reason.
    phone: "886912345678",
    cardholderName: "TEST USER",
    period: { amount: 5, type: "M", frequency: 1, execTimes: 12 },
    ...overrides,
  };
}

async function caught(promise: Promise<unknown>): Promise<PaymentError> {
  return (await promise.catch((e: unknown) => e)) as PaymentError;
}

/** Reads `CardInfo` off a captured request, failing loudly if nothing was captured. */
function cardInfoOf(seen: { body?: Record<string, unknown> }): Record<string, unknown> {
  expect(seen.body).toBeDefined();
  return seen.body?.CardInfo as Record<string, unknown>;
}

describe("定期定額 request shape", () => {
  it("sends the schedule inside CardInfo, not as its own object", async () => {
    // Recorded finding: there is no PeriodInfo container. Getting this wrong is silent
    // — ECPay authorizes a one-off and the caller believes a schedule exists.
    const seen = capture(AUTH_URL, PERIOD_CREATE_SUCCESS);
    await testProvider().createPayment(base());

    const cardInfo = seen.body?.CardInfo as Record<string, unknown>;
    expect(cardInfo).toMatchObject({
      PeriodAmount: 5,
      PeriodType: "M",
      Frequency: 1,
      ExecTimes: 12,
    });
    expect(seen.body).not.toHaveProperty("PeriodInfo");
  });

  it("defaults PeriodReturnURL to notifyUrl but lets the schedule override it", async () => {
    const seen = capture(AUTH_URL, PERIOD_CREATE_SUCCESS);
    await testProvider().createPayment(base());
    expect(cardInfoOf(seen).PeriodReturnURL).toBe("https://shop.test/notify");

    const other = capture(AUTH_URL, PERIOD_CREATE_SUCCESS);
    await testProvider().createPayment(
      base({
        period: {
          amount: 5,
          type: "M",
          frequency: 1,
          execTimes: 12,
          returnUrl: "https://shop.test/period",
        },
      }),
    );
    expect(cardInfoOf(other).PeriodReturnURL).toBe("https://shop.test/period");
  });

  it("omits every period field on an ordinary one-off order", async () => {
    const seen = capture(AUTH_URL, PERIOD_CREATE_SUCCESS);
    await testProvider().createPayment(base({ period: undefined }));

    const cardInfo = (seen.body?.CardInfo ?? {}) as Record<string, unknown>;
    for (const key of ["PeriodAmount", "PeriodType", "Frequency", "ExecTimes", "PeriodReturnURL"]) {
      expect(cardInfo).not.toHaveProperty(key);
    }
  });
});

describe("定期定額 schedule validation", () => {
  it.each([
    ["D", 366, "每天"],
    ["M", 13, "每月"],
    ["Y", 2, "每年"],
  ] as const)(
    "rejects a %s frequency of %i above the documented ceiling",
    async (type, frequency) => {
      const err = await caught(
        testProvider().createPayment(
          base({ period: { amount: 5, type, frequency, execTimes: 2 } }),
        ),
      );
      expect(err.code).toBe("VALIDATION");
      expect(err.message).toContain("period.frequency");
    },
  );

  it.each([
    ["D", 1000],
    ["M", 1000],
    ["Y", 100],
  ] as const)(
    "rejects a %s execTimes of %i above the documented ceiling",
    async (type, execTimes) => {
      const err = await caught(
        testProvider().createPayment(
          base({ period: { amount: 5, type, frequency: 1, execTimes } }),
        ),
      );
      expect(err.code).toBe("VALIDATION");
      expect(err.message).toContain("period.execTimes");
    },
  );

  it("rejects execTimes of 1, which the API also rejects despite reading like a typo", async () => {
    // Verified on stage: ExecTimes must be >= 2. Doc 9093's "2-999" next to Frequency's
    // "1-365" looks like an off-by-one in the doc, so this is pinned deliberately.
    const err = await caught(
      testProvider().createPayment(
        base({ period: { amount: 5, type: "M", frequency: 1, execTimes: 1 } }),
      ),
    );
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toContain("period.execTimes");
  });

  it.each([0, -1, 5.5, Number.NaN])("rejects the frequency %j", async (frequency) => {
    const err = await caught(
      testProvider().createPayment(
        base({ period: { amount: 5, type: "M", frequency: frequency as number, execTimes: 2 } }),
      ),
    );
    expect(err.code).toBe("VALIDATION");
  });

  it("rejects an unknown period type", async () => {
    const err = await caught(
      testProvider().createPayment(
        base({ period: { amount: 5, type: "W" as "D", frequency: 1, execTimes: 2 } }),
      ),
    );
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toContain("period.type");
  });

  it("rejects a non-positive period amount", async () => {
    const err = await caught(
      testProvider().createPayment(
        base({ period: { amount: 0, type: "M", frequency: 1, execTimes: 2 } }),
      ),
    );
    expect(err.code).toBe("VALIDATION");
  });

  it("refuses to combine a schedule with installments", async () => {
    // ECPay cannot express "instalments, recurring" — sending both would let the API
    // pick, which is exactly the ambiguity worth failing on.
    const err = await caught(testProvider().createPayment(base({ installments: [3] })));
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toMatch(/分期/);
  });

  it("validates before touching the network", async () => {
    // No MSW handler is registered, and the server is in `onUnhandledRequest: "error"`
    // mode — so a request escaping validation fails the test rather than passing it.
    const err = await caught(
      testProvider().createPayment(
        base({ period: { amount: 5, type: "Y", frequency: 1, execTimes: 1 } }),
      ),
    );
    expect(err.code).toBe("VALIDATION");
  });
});

describe("定期定額 create response", () => {
  it("reports the echoed schedule and the first cycle as already charged", async () => {
    server.use(respondWith(AUTH_URL, PERIOD_CREATE_SUCCESS));
    const result = await testProvider().createPayment(
      base({ period: { amount: 5, type: "Y", frequency: 1, execTimes: 2 } }),
    );

    expect(result.mode).toBe("authorized");
    // The thing most likely to surprise a caller: cycle 1 is charged at create time.
    expect(result.period).toMatchObject({
      type: "Y",
      frequency: 1,
      execTimes: 2,
      periodAmount: 5,
      totalSuccessTimes: 1,
      totalSuccessAmount: 5,
    });
    // And it is still an ordinary authorization, with the usual card detail.
    expect(result.card).toMatchObject({ gwsr: 14_522_380, card4No: "2222" });
  });
});

describe("定期定額 query", () => {
  it("surfaces the undocumented per-cycle ExecLog", async () => {
    server.use(respondWith(QUERY_URL, PERIOD_QUERY_ACTIVE));
    const order = await testProvider().queryPeriodOrder({ merTradeNo: "PD85599355842" });

    expect(order.executions).toHaveLength(1);
    expect(order.executions[0]).toEqual({
      rtnCode: 1,
      amount: 5,
      gwsr: 14_522_380,
      processDate: "2026/08/01 23:49:16",
      authCode: "777777",
      tradeNo: "2608012349160646",
      chargeFee: 2,
    });
  });

  it("reads isActive from ExecStatus, which is the only field that moves on Cancel", async () => {
    server.use(respondWith(QUERY_URL, PERIOD_QUERY_ACTIVE));
    const active = await testProvider().queryPeriodOrder({ merTradeNo: "PD85599355842" });
    expect(active.execStatus).toBe("1");
    expect(active.isActive).toBe(true);

    server.resetHandlers();
    server.use(respondWith(QUERY_URL, PERIOD_QUERY_CANCELLED));
    const cancelled = await testProvider().queryPeriodOrder({ merTradeNo: "PD85599355842" });
    expect(cancelled.isActive).toBe(false);

    // The trap this guards: a cancelled schedule still looks paid and still reports the
    // same counters, so neither one can stand in for "is it still running?".
    expect(cancelled.status).toBe(active.status);
    expect(cancelled.period).toEqual(active.period);
  });

  it("reads the progress counters out of CardInfo", async () => {
    server.use(respondWith(QUERY_URL, PERIOD_QUERY_ACTIVE));
    const order = await testProvider().queryPeriodOrder({ merTradeNo: "PD85599355842" });
    expect(order.period).toMatchObject({ totalSuccessTimes: 1, totalSuccessAmount: 5 });
    // Card fields share that container and must still normalize.
    expect(order.card).toMatchObject({ issuingBank: "CTBC Bank", card4No: "2222" });
  });

  it("returns no period block for an order that is not a schedule", async () => {
    // A one-off has no PeriodType, and `period: undefined` is how a caller can tell.
    const {
      PeriodType: _t,
      Frequency: _f,
      ExecTimes: _e,
      PeriodAmount: _a,
      ...card
    } = PERIOD_QUERY_ACTIVE.CardInfo;
    server.use(
      respondWith(QUERY_URL, { ...PERIOD_QUERY_ACTIVE, CardInfo: card, ExecStatus: undefined }),
    );
    const order = await testProvider().queryPeriodOrder({ merTradeNo: "ONEOFF01" });

    expect(order.period).toBeUndefined();
    expect(order.isActive).toBe(false);
  });

  it("yields an empty execution list rather than undefined when ExecLog is absent", async () => {
    // Undocumented fields can vanish without notice; callers iterate this.
    const { ExecLog: _omit, ...rest } = PERIOD_QUERY_ACTIVE;
    server.use(respondWith(QUERY_URL, rest));
    const order = await testProvider().queryPeriodOrder({ merTradeNo: "PD85599355842" });
    expect(order.executions).toEqual([]);
  });

  it("tolerates junk inside ExecLog instead of throwing", async () => {
    server.use(
      respondWith(QUERY_URL, { ...PERIOD_QUERY_ACTIVE, ExecLog: [null, "nope", { RtnCode: 1 }] }),
    );
    const order = await testProvider().queryPeriodOrder({ merTradeNo: "PD85599355842" });
    expect(order.executions).toHaveLength(3);
    expect(order.executions[2]?.rtnCode).toBe(1);
    expect(order.executions[0]?.tradeNo).toBeUndefined();
  });

  it("requires a merTradeNo", async () => {
    const err = await caught(testProvider().queryPeriodOrder({ merTradeNo: "" }));
    expect(err.code).toBe("VALIDATION");
  });
});

describe("定期定額 order actions", () => {
  it("cancels, accepting the Chinese success message", async () => {
    // Success text is "停用成功" here while the rest of BackAuth says "Succeeded." —
    // proof that RtnCode, never RtnMsg, is the success signal.
    const seen = capture(PERIOD_ACTION_URL, PERIOD_CANCEL_SUCCESS);
    const result = await testProvider().creditCardPeriodAction({
      orderId: "PD85599355842",
      action: "Cancel",
    });

    expect(seen.body).toMatchObject({ MerchantTradeNo: "PD85599355842", Action: "Cancel" });
    expect(result.rtnCode).toBe(1);
    expect(result.rtnMsg).toBe("停用成功");
  });

  it("maps ReAuth on a cancelled schedule to a terminal CONFLICT", async () => {
    // Cancel is irreversible — there is no resume endpoint — so retrying is pointless
    // and CONFLICT says that, where a generic PROVIDER error would invite a retry loop.
    server.use(respondWith(PERIOD_ACTION_URL, PERIOD_REAUTH_CANCELLED));
    const err = await caught(
      testProvider().creditCardPeriodAction({ orderId: "PD85599355842", action: "ReAuth" }),
    );

    expect(err.code).toBe("CONFLICT");
    expect(err.rawCode).toBe("100006");
    expect(err.message).toContain("該訂單狀態為停用中");
  });

  it.each(["", "cancel", "Stop", "ReAuth "])("rejects the action %j locally", async (action) => {
    const err = await caught(
      testProvider().creditCardPeriodAction({
        orderId: "PD85599355842",
        action: action as "Cancel",
      }),
    );
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toContain("ReAuth");
  });

  it("requires an orderId", async () => {
    const err = await caught(
      testProvider().creditCardPeriodAction({ orderId: "", action: "Cancel" }),
    );
    expect(err.code).toBe("VALIDATION");
  });

  it.each([
    ["10100223", "VALIDATION"],
    ["10100224", "VALIDATION"],
    ["10100225", "VALIDATION"],
    ["10100226", "VALIDATION"],
    ["10100227", "VALIDATION"],
    ["10100228", "VALIDATION"],
  ])("maps the schedule error %s to %s", async (rawCode, code) => {
    // The adapter blocks these locally, so they should be unreachable in practice — but
    // the ceilings are ECPay's to change, and a mapped code degrades better than a bare
    // PROVIDER error if they ever move.
    server.use(respondWith(AUTH_URL, { RtnCode: Number(rawCode), RtnMsg: "out of range" }));
    const err = await caught(testProvider().createPayment(base()));
    expect(err.code).toBe(code);
    expect(err.rawCode).toBe(rawCode);
  });
});

describe("定期定額 cycle notify", () => {
  const CREDS = {
    merchantId: ECPAY_SANDBOX_NO_3D.merchantId,
    hashKey: ECPAY_SANDBOX_NO_3D.hashKey,
    hashIv: ECPAY_SANDBOX_NO_3D.hashIv,
  };

  /**
   * A cycle notify, built by wrapping the *recorded* create payload in the notify
   * envelope. ECPay posts the same AES-JSON shape to `PeriodReturnURL` as to
   * `ReturnURL`, so this reuses the real `CardInfo` rather than inventing one.
   *
   * Not live-recorded: capturing cycle 2 would mean waiting a day (the shortest cadence)
   * on a schedule that keeps charging until stopped. Cycle 1's notify is the same shape.
   */
  function cycleEnvelope(cardOverrides: Record<string, unknown> = {}) {
    const data = {
      ...PERIOD_CREATE_SUCCESS,
      CardInfo: { ...PERIOD_CREATE_SUCCESS.CardInfo, ...cardOverrides },
    };
    return {
      MerchantID: CREDS.merchantId,
      RpHeader: { Timestamp: 1_785_547_600 },
      TransCode: 1,
      TransMsg: "Success",
      Data: encryptData(data, CREDS.hashKey, CREDS.hashIv),
    };
  }

  it("surfaces the cycle progress alongside the ordinary notify fields", () => {
    const notify = verifyEcpayPeriodNotify(cycleEnvelope(), CREDS);
    expect(notify.success).toBe(true);
    expect(notify.period).toMatchObject({
      type: "Y",
      execTimes: 2,
      periodAmount: 5,
      totalSuccessTimes: 1,
      totalSuccessAmount: 5,
    });
  });

  it("reports a later cycle by its counter, since merTradeNo never changes", () => {
    // The idempotency trap this documents: every cycle of a schedule posts the same
    // MerchantTradeNo, so keying dedupe on it alone drops cycles 2..n as replays.
    const cycle4 = verifyEcpayPeriodNotify(
      cycleEnvelope({ TotalSuccessTimes: 4, TotalSuccessAmount: 20 }),
      CREDS,
    );
    const cycle1 = verifyEcpayPeriodNotify(cycleEnvelope(), CREDS);

    expect(cycle4.merTradeNo).toBe(cycle1.merTradeNo);
    expect(cycle4.period?.totalSuccessTimes).toBe(4);
    expect(cycle4.period?.totalSuccessAmount).toBe(20);
  });

  it("leaves period undefined for a notify that is not a schedule", () => {
    // PeriodType is the marker. Without this guard the counters would be an object of
    // undefined values, which reads as "a schedule with unknown progress".
    const { PeriodType: _t, ...card } = PERIOD_CREATE_SUCCESS.CardInfo;
    const data = { ...PERIOD_CREATE_SUCCESS, CardInfo: card };
    const notify = verifyEcpayPeriodNotify(
      {
        MerchantID: CREDS.merchantId,
        RpHeader: { Timestamp: 1_785_547_600 },
        TransCode: 1,
        TransMsg: "Success",
        Data: encryptData(data, CREDS.hashKey, CREDS.hashIv),
      },
      CREDS,
    );
    expect(notify.period).toBeUndefined();
    expect(notify.success).toBe(true);
  });

  it("rejects a notify encrypted with the wrong key", () => {
    const forged = {
      MerchantID: CREDS.merchantId,
      RpHeader: { Timestamp: 1_785_547_600 },
      TransCode: 1,
      TransMsg: "Success",
      Data: encryptData(PERIOD_CREATE_SUCCESS, "0".repeat(16), CREDS.hashIv),
    };
    expect(() => verifyEcpayPeriodNotify(forged, CREDS)).toThrow(PaymentError);
  });

  it("rejects a notify for a different merchant", () => {
    const other = { ...cycleEnvelope(), MerchantID: "9999999" };
    expect(() => verifyEcpayPeriodNotify(other, CREDS)).toThrow(PaymentError);
  });

  it("acks with the same 1|OK the one-off notify uses", () => {
    // A cycle notify that is not acked is retried, so this must not drift.
    expect(ECPAY_BACKAUTH_NOTIFY_ACK).toBe("1|OK");
  });
});
