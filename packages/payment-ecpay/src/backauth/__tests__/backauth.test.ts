import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PaymentError as PaymentErrorClass, supports } from "@paid-tw/payment";
import type { PaymentError } from "@paid-tw/payment";
import { ECPAY_BACKAUTH_ORIGINS, ECPAY_TEST_CARD, resolveBackAuthOrigin } from "../config.js";
import { createEcpayBackAuthProvider } from "../provider.js";
import type {
  EcpayBackAuthCreateInput,
  EcpayBackAuthRefundInput,
  EcpayCardDetails,
} from "../provider.js";
import {
  AUTH_3DS,
  AUTH_DECLINED,
  AUTH_MISSING_ORDER_RESULT_URL,
  AUTH_SUCCESS,
  DOACTION_OK,
  QUERY_TRADE_PAID,
} from "./backauth-fixtures.js";
import {
  AUTH_URL,
  BASE,
  DOACTION_URL,
  envelope,
  HASH_IV,
  HASH_KEY,
  MERCHANT,
  QUERY_URL,
  readRequestData,
  respondWith,
  server,
  testCard,
  testProvider,
} from "./backauth-server.js";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const CARD = testCard();

function input(overrides: Partial<EcpayBackAuthCreateInput> = {}): EcpayBackAuthCreateInput {
  return {
    amount: 199,
    currency: "TWD",
    method: "card",
    orderId: "BAOK85547852370",
    itemDesc: "paid-tw backauth probe",
    notifyUrl: "https://shop.test/notify",
    orderResultUrl: "https://shop.test/result",
    card: CARD,
    phone: "886912345678",
    cardholderName: "TEST USER",
    ...overrides,
  };
}

describe("createEcpayBackAuthProvider — shape", () => {
  it("is a fourth, separate ECPay adapter", () => {
    const p = testProvider();
    expect(p.name).toBe("ecpay-backauth");
    expect(p.capabilities.has("CREATE_PAYMENT")).toBe(true);
    expect(p.capabilities.has("GET_PAYMENT")).toBe(true);
    expect(p.capabilities.has("REFUND_PAYMENT")).toBe(true);
  });

  it("does not advertise REFUND_PAYMENT on a sandbox instance", () => {
    // `supports()` is the feature-detection contract, so a sandbox provider claiming
    // REFUND_PAYMENT would make `if (supports(p, "REFUND_PAYMENT")) p.refundPayment()`
    // throw anyway. Refunds genuinely do not exist on stage, so the capability is
    // resolved per instance rather than per adapter.
    for (const sandbox of [
      createEcpayBackAuthProvider({
        merchantId: MERCHANT,
        hashKey: HASH_KEY,
        hashIv: HASH_IV,
        sandbox: true,
      }),
      createEcpayBackAuthProvider({
        merchantId: MERCHANT,
        hashKey: HASH_KEY,
        hashIv: HASH_IV,
        baseUrl: ECPAY_BACKAUTH_ORIGINS.sandbox,
      }),
    ]) {
      expect(supports(sandbox, "CREATE_PAYMENT")).toBe(true);
      expect(supports(sandbox, "GET_PAYMENT")).toBe(true);
      expect(supports(sandbox, "REFUND_PAYMENT")).toBe(false);
    }

    // Production, by contrast, does have it.
    const prod = createEcpayBackAuthProvider({
      merchantId: MERCHANT,
      hashKey: HASH_KEY,
      hashIv: HASH_IV,
    });
    expect(supports(prod, "REFUND_PAYMENT")).toBe(true);
  });

  it("treats sandbox:true as sandbox even behind a custom baseUrl", async () => {
    // The bug: `baseUrl` used to shadow the flag entirely, so stage-through-a-proxy —
    // `{ sandbox: true, baseUrl: "https://internal-proxy" }` — was classified as
    // production. It then advertised REFUND_PAYMENT and actually attempted a DoAction
    // that cannot exist, failing with NETWORK instead of a useful UNSUPPORTED.
    const proxied = createEcpayBackAuthProvider({
      merchantId: MERCHANT,
      hashKey: HASH_KEY,
      hashIv: HASH_IV,
      sandbox: true,
      baseUrl: "https://ecpay-proxy.invalid",
    });
    expect(supports(proxied, "REFUND_PAYMENT")).toBe(false);
    await expect(
      proxied.creditDoAction({ orderId: "A", tradeNo: "1", action: "R", amount: 1 }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  it("still routes through baseUrl even when the flag says sandbox", () => {
    // Environment classification and request routing are separate questions — the
    // fix must not make `baseUrl` stop winning for routing.
    expect(resolveBackAuthOrigin({ sandbox: true, baseUrl: "https://x.test" })).toBe(
      "https://x.test",
    );
  });

  it("keeps the capability guard and the runtime behaviour in agreement", async () => {
    // The bug this prevents: guarded call still throwing.
    const sandbox = createEcpayBackAuthProvider({
      merchantId: MERCHANT,
      hashKey: HASH_KEY,
      hashIv: HASH_IV,
      sandbox: true,
    });
    expect(supports(sandbox, "REFUND_PAYMENT")).toBe(false);
    await expect(
      sandbox.refundPayment({ orderId: "A", tradeNo: "1", amount: 1 }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  it("resolves the ecpayment host", () => {
    expect(resolveBackAuthOrigin({ sandbox: true })).toBe(ECPAY_BACKAUTH_ORIGINS.sandbox);
    expect(resolveBackAuthOrigin({})).toBe(ECPAY_BACKAUTH_ORIGINS.production);
  });

  it("requires credentials", async () => {
    await expect(testProvider({ hashIv: undefined }).createPayment(input())).rejects.toMatchObject({
      code: "AUTH",
      provider: "ecpay-backauth",
    });
  });
});

describe("BackAuth — the two response shapes", () => {
  it("returns mode:authorized for a settled authorization", async () => {
    server.use(respondWith(AUTH_URL, AUTH_SUCCESS));
    const result = await testProvider().createPayment(input());

    expect(result.mode).toBe("authorized");
    if (result.mode !== "authorized") throw new Error("unreachable");

    expect(result.success).toBe(true);
    expect(result.status).toBe("paid");
    expect(result.amount).toBe(199);
    expect(result.tradeNo).toBe("2608010930520281");
    expect(result.chargeFee).toBe(4.98);
    expect(result.processFee).toBe(1);
    expect(result.card).toEqual({
      authCode: "777777",
      gwsr: 14_521_552,
      processDate: "2026/08/01 09:30:53",
      amount: 199,
      card6No: "431195",
      card4No: "2222",
      eci: 0,
      issuingBank: "CTBC Bank",
      issuingBankCode: "822",
      installments: undefined,
    });
  });

  it("returns mode:3ds even though the payload has no RtnCode", async () => {
    // The whole reason this is a discriminated union. Recorded live: the 3D payload
    // is ThreeDURL + MerchantID + MerchantTradeNo and nothing else. Checking RtnCode
    // first — the obvious implementation — rejects a valid hand-off.
    server.use(respondWith(AUTH_URL, AUTH_3DS));
    const result = await testProvider().createPayment(input());

    expect(result.mode).toBe("3ds");
    if (result.mode !== "3ds") throw new Error("unreachable");
    expect(result.threeDUrl).toBe(AUTH_3DS.ThreeDURL);
    expect(result.merTradeNo).toBe("BA3D85547853850");
    expect(result.raw).not.toHaveProperty("RtnCode");
  });

  it("handles MerchantID arriving as a number on the 3DS branch", async () => {
    // Recorded live: string on the authorized branch, number on the 3D branch.
    expect(typeof AUTH_3DS.MerchantID).toBe("number");
    expect(typeof AUTH_SUCCESS.MerchantID).toBe("string");
    server.use(respondWith(AUTH_URL, AUTH_3DS));
    await expect(testProvider().createPayment(input())).resolves.toMatchObject({ mode: "3ds" });
  });

  it("sends the card in the encrypted Data, with the documented field names", async () => {
    const seen: { body?: Record<string, unknown> } = {};
    server.use(
      http.post(AUTH_URL, async ({ request }) => {
        seen.body = await readRequestData(request);
        return HttpResponse.json(envelope(AUTH_SUCCESS));
      }),
    );
    await testProvider().createPayment(
      input({ directCapture: true, installments: 3, redeem: true, customField: "x" }),
    );

    expect(seen.body).toMatchObject({
      MerchantID: MERCHANT,
      ChoosePayment: "Credit",
      CardInfo: {
        CardNo: ECPAY_TEST_CARD.cardNo,
        CardValidMM: CARD.expiryMonth,
        CardValidYY: CARD.expiryYear,
        CardCVV2: ECPAY_TEST_CARD.cvv,
        OrderResultURL: "https://shop.test/result",
        DirectCapture: "1",
        Redeem: "Y",
        CreditInstallment: "3",
      },
      ConsumerInfo: { Phone: "886912345678", Name: "TEST USER", CountryCode: "158" },
      CustomField: "x",
    });
  });

  it("defaults DirectCapture and Redeem to off", async () => {
    const seen: { body?: Record<string, unknown> } = {};
    server.use(
      http.post(AUTH_URL, async ({ request }) => {
        seen.body = await readRequestData(request);
        return HttpResponse.json(envelope(AUTH_SUCCESS));
      }),
    );
    await testProvider().createPayment(input());
    const cardInfo = seen.body?.CardInfo as Record<string, unknown>;
    expect(cardInfo.DirectCapture).toBe("0");
    expect(cardInfo.Redeem).toBe("N");
    expect(cardInfo).not.toHaveProperty("CreditInstallment");
  });
});

/** Collect every key name in a nested structure, for leak assertions. */
function allKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      allKeys(v, out);
    }
  }
  return out;
}

/**
 * Card fields must never reach a result or an error. Note the CVV is checked by
 * **key name, not substring**: ECPay's test CVV is `222` and the masked `Card4No` is
 * `2222`, so a substring assertion fails on legitimate output — the sound check is
 * that no CVV-bearing field exists at all.
 */
const CARD_FIELD_NAMES = ["cvv", "CardCVV2", "cardNo", "CardNo", "CardValidMM", "CardValidYY"];

describe("BackAuth — card data never leaks", () => {
  it("keeps the PAN and every card field out of the result", async () => {
    server.use(respondWith(AUTH_URL, AUTH_SUCCESS));
    const result = await testProvider().createPayment(input());

    expect(JSON.stringify(result)).not.toContain(ECPAY_TEST_CARD.cardNo);
    for (const field of CARD_FIELD_NAMES) {
      expect(allKeys(result)).not.toContain(field);
    }
    // What the caller legitimately gets is the masked pair.
    if (result.mode !== "authorized") throw new Error("unreachable");
    expect(result.card?.card6No).toBe("431195");
    expect(result.card?.card4No).toBe("2222");
  });

  it("keeps card data out of a gateway error", async () => {
    server.use(respondWith(AUTH_URL, AUTH_DECLINED));
    const err = (await testProvider()
      .createPayment(input())
      .catch((e: unknown) => e)) as PaymentError;

    const serialized = JSON.stringify({ json: err.toJSON(), raw: err.raw, message: err.message });
    expect(serialized).not.toContain(ECPAY_TEST_CARD.cardNo);
    for (const field of CARD_FIELD_NAMES) {
      expect(allKeys({ json: err.toJSON(), raw: err.raw })).not.toContain(field);
    }
  });

  it("does send the card to ECPay — inside the encrypted Data, never in the clear", async () => {
    // The complement of the leak tests: confirm the PAN reaches the gateway, and that
    // the outer JSON body carries only MerchantID/RqHeader/Data.
    let outerBody: Record<string, unknown> | undefined;
    let decrypted: Record<string, unknown> | undefined;
    server.use(
      http.post(AUTH_URL, async ({ request }) => {
        const raw = await request.clone().text();
        outerBody = JSON.parse(raw) as Record<string, unknown>;
        decrypted = await readRequestData(request);
        return HttpResponse.json(envelope(AUTH_SUCCESS));
      }),
    );
    await testProvider().createPayment(input());

    expect(Object.keys(outerBody ?? {}).sort()).toEqual(["Data", "MerchantID", "RqHeader"]);
    expect(JSON.stringify(outerBody)).not.toContain(ECPAY_TEST_CARD.cardNo);
    expect(decrypted?.CardInfo).toMatchObject({ CardNo: ECPAY_TEST_CARD.cardNo });
  });

  it("reports only the length when rejecting a malformed card number", async () => {
    const err = (await testProvider()
      .createPayment(input({ card: { ...CARD, cardNo: "4311abcd95222222" } }))
      .catch((e: unknown) => e)) as PaymentError;
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toContain("16 個字元");
    expect(err.message).not.toContain("4311abcd");
  });
});

describe("BackAuth — request validation", () => {
  async function expectValidation(promise: Promise<unknown>, match: RegExp) {
    const err = (await promise.catch((e: unknown) => e)) as PaymentError;
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toMatch(match);
  }

  it("requires orderResultUrl and names the code ECPay would return", async () => {
    // Doc 45958 does not mark it required; stage returns 5000029 without it.
    await expectValidation(testProvider().createPayment(input({ orderResultUrl: "" })), /5000029/);
    expect(AUTH_MISSING_ORDER_RESULT_URL.RtnCode).toBe(5_000_029);
  });

  it("requires notifyUrl, phone and cardholderName", async () => {
    await expectValidation(
      testProvider().createPayment(input({ notifyUrl: undefined })),
      /ReturnURL/,
    );
    await expectValidation(testProvider().createPayment(input({ phone: "" })), /phone/);
    await expectValidation(
      testProvider().createPayment(input({ cardholderName: "" })),
      /cardholderName/,
    );
  });

  it("rejects non-card methods and non-TWD", async () => {
    await expectValidation(testProvider().createPayment(input({ method: "atm" })), /幕後取號/);
    await expectValidation(testProvider().createPayment(input({ currency: "USD" })), /TWD/);
  });

  it("validates MerchantTradeNo and amount", async () => {
    await expectValidation(
      testProvider().createPayment(input({ orderId: "has-dash" })),
      /MerchantTradeNo/,
    );
    await expectValidation(testProvider().createPayment(input({ amount: 0 })), /TotalAmount/);
  });

  it.each([
    [{ cardNo: "123" }, /13-19 碼數字/],
    [{ expiryMonth: "13" }, /CardValidMM/],
    [{ expiryMonth: "0" }, /CardValidMM/],
    [{ expiryYear: "2030" }, /CardValidYY/],
    [{ cvv: "12" }, /CardCVV2/],
    [{ cvv: "12345" }, /CardCVV2/],
  ] as const)("rejects a malformed card field %j", async (patch, match) => {
    await expectValidation(
      testProvider().createPayment(input({ card: { ...CARD, ...patch } as EcpayCardDetails })),
      match,
    );
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["an object", {}],
  ] as const)("rejects a %s cardNo with VALIDATION, not a TypeError", async (_label, value) => {
    // Untyped callers are real for a published package. Before normalizing, the regex
    // failed and then `.length` threw, so a validation problem surfaced as an
    // unhandled TypeError with no PaymentError code to branch on.
    const err = (await testProvider()
      .createPayment(input({ card: { ...CARD, cardNo: value as unknown as string } }))
      .catch((e: unknown) => e)) as PaymentError;

    expect(err).toBeInstanceOf(PaymentErrorClass);
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toContain("0 個字元");
  });

  it("normalizes a numeric cardNo to the string ECPay documents", async () => {
    // A number passed the regex (it coerces) and was then serialized into the payload
    // as a JSON number rather than a string.
    const seen: { body?: Record<string, unknown> } = {};
    server.use(
      http.post(AUTH_URL, async ({ request }) => {
        seen.body = await readRequestData(request);
        return HttpResponse.json(envelope(AUTH_SUCCESS));
      }),
    );
    await testProvider().createPayment(
      input({
        card: { ...CARD, cardNo: Number(ECPAY_TEST_CARD.cardNo) as unknown as string },
      }),
    );
    const cardInfo = seen.body?.CardInfo as Record<string, unknown>;
    expect(cardInfo.CardNo).toBe(ECPAY_TEST_CARD.cardNo);
    expect(typeof cardInfo.CardNo).toBe("string");
  });

  it("rejects a missing card object entirely", async () => {
    const err = (await testProvider()
      .createPayment(input({ card: undefined as unknown as EcpayCardDetails }))
      .catch((e: unknown) => e)) as PaymentError;
    expect(err.code).toBe("VALIDATION");
  });

  it("accepts ECPay's own test card, which fails Luhn", async () => {
    // Deliberate: a Luhn guard would reject the vendor's documented stage card.
    const luhn = (n: string) => {
      let sum = 0;
      let dbl = false;
      for (let i = n.length - 1; i >= 0; i--) {
        let d = Number(n[i]);
        if (dbl) {
          d *= 2;
          if (d > 9) d -= 9;
        }
        sum += d;
        dbl = !dbl;
      }
      return sum % 10 === 0;
    };
    expect(luhn(ECPAY_TEST_CARD.cardNo)).toBe(false);

    server.use(respondWith(AUTH_URL, AUTH_SUCCESS));
    await expect(testProvider().createPayment(input())).resolves.toMatchObject({
      mode: "authorized",
    });
  });
});

describe("BackAuth — gateway failures", () => {
  it("maps a declined card to PROVIDER, keeping ECPay's wording", async () => {
    server.use(respondWith(AUTH_URL, AUTH_DECLINED));
    const err = (await testProvider()
      .createPayment(input())
      .catch((e: unknown) => e)) as PaymentError;
    expect(err.code).toBe("PROVIDER");
    expect(err.rawCode).toBe("10100058");
    expect(err.message).toContain("Pay Fail.");
  });

  it("does not borrow the 幕後取號 meaning of 10100058", async () => {
    // Same number means "ATM 繳費期限已過" in the 幕後取號 table. Cross-service code
    // collisions are why the error tables are per-service, and why this one leaves
    // 10100058 unmapped rather than mislabelling a declined card.
    server.use(respondWith(AUTH_URL, AUTH_DECLINED));
    const err = (await testProvider()
      .createPayment(input())
      .catch((e: unknown) => e)) as PaymentError;
    expect(err.message).not.toContain("繳費期限");
  });

  it("maps 10300066 to CONFLICT — pending, do not ship", async () => {
    server.use(
      respondWith(AUTH_URL, { RtnCode: 10_300_066, RtnMsg: "交易付款結果待確認中，請勿出貨" }),
    );
    const err = (await testProvider()
      .createPayment(input())
      .catch((e: unknown) => e)) as PaymentError;
    expect(err.code).toBe("CONFLICT");
    expect(err.message).toContain("請勿出貨");
  });

  it.each([
    ["10100248", "PROVIDER"],
    ["10100252", "PROVIDER"],
    ["10100255", "PROVIDER"],
    ["5000029", "VALIDATION"],
  ] as const)("maps RtnCode %s to %s", async (code, expected) => {
    server.use(respondWith(AUTH_URL, { RtnCode: Number(code), RtnMsg: "x" }));
    const err = (await testProvider()
      .createPayment(input())
      .catch((e: unknown) => e)) as PaymentError;
    expect(err.code).toBe(expected);
    expect(err.rawCode).toBe(code);
  });

  it("fails on a rejected envelope", async () => {
    server.use(http.post(AUTH_URL, () => HttpResponse.json(envelope(AUTH_SUCCESS, 0))));
    await expect(testProvider().createPayment(input())).rejects.toMatchObject({
      code: "PROVIDER",
      rawCode: "0",
    });
  });

  it("maps a transport failure to NETWORK", async () => {
    server.use(http.post(AUTH_URL, () => HttpResponse.error()));
    await expect(testProvider().createPayment(input())).rejects.toMatchObject({
      code: "NETWORK",
    });
  });
});

describe("QueryTrade — getPayment", () => {
  it("normalizes a paid credit order", async () => {
    server.use(respondWith(QUERY_URL, QUERY_TRADE_PAID));
    const data = await testProvider().getPayment({ merTradeNo: "BAOK85547852370" });
    expect(data).toMatchObject({
      status: "paid",
      method: "card",
      amount: 199,
      tradeNo: "2608010930520281",
    });
  });

  it("maps 查無交易資料 to NOT_FOUND", async () => {
    server.use(
      respondWith(QUERY_URL, { RtnCode: 10_000_185, RtnMsg: "Cant not find the trade data" }),
    );
    await expect(testProvider().getPayment({ merTradeNo: "NOPE" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("requires MerchantTradeNo", async () => {
    await expect(testProvider().getPayment({ tradeNo: "1" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("normalizes an unpaid order and passes an unknown TradeStatus through", async () => {
    // TradeStatus 0 happens on an authorization that did not settle; anything else
    // is kept verbatim rather than forced into the two known states.
    server.use(
      respondWith(QUERY_URL, {
        ...QUERY_TRADE_PAID,
        OrderInfo: { ...QUERY_TRADE_PAID.OrderInfo, TradeStatus: "0", PaymentDate: "" },
      }),
    );
    const unpaid = await testProvider().getPayment({ merTradeNo: "BAOK85547852370" });
    expect(unpaid.status).toBe("unpaid");
    expect(unpaid.paidAt).toBeUndefined();

    server.use(
      respondWith(QUERY_URL, {
        ...QUERY_TRADE_PAID,
        OrderInfo: { ...QUERY_TRADE_PAID.OrderInfo, TradeStatus: "7" },
      }),
    );
    expect((await testProvider().getPayment({ merTradeNo: "X" })).status).toBe("7");

    server.use(
      respondWith(QUERY_URL, { ...QUERY_TRADE_PAID, OrderInfo: { MerchantTradeNo: "X" } }),
    );
    expect((await testProvider().getPayment({ merTradeNo: "X" })).status).toBe("unknown");
  });
});

describe("Credit/DoAction — production only", () => {
  it("refuses outright when configured against sandbox", async () => {
    // ECPay does not expose this endpoint on stage at all, so calling it could only
    // ever 404. Failing locally gives a message that explains why.
    const sandbox = createEcpayBackAuthProvider({
      merchantId: MERCHANT,
      hashKey: HASH_KEY,
      hashIv: HASH_IV,
      sandbox: true,
    });
    const err = (await sandbox
      .creditDoAction({ orderId: "A", tradeNo: "1", action: "R", amount: 1 })
      .catch((e: unknown) => e)) as PaymentError;
    expect(err.code).toBe("UNSUPPORTED");
    expect(err.message).toContain("僅正式環境");
  });

  it("reports UNSUPPORTED before AUTH when sandbox and credentials are both missing", async () => {
    // Error precedence matters here: the environment constraint is unconditional,
    // while credentials are fixable. Reporting AUTH first would send someone hunting
    // for keys that cannot make this endpoint exist.
    const bare = createEcpayBackAuthProvider({ sandbox: true });
    await expect(
      bare.creditDoAction({ orderId: "A", tradeNo: "1", action: "R", amount: 1 }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });

    // A production instance with no credentials still reports AUTH, as it should —
    // there the credentials genuinely are the problem.
    const prodBare = createEcpayBackAuthProvider({});
    await expect(
      prodBare.creditDoAction({ orderId: "A", tradeNo: "1", action: "R", amount: 1 }),
    ).rejects.toMatchObject({ code: "AUTH" });
  });

  it("also refuses when baseUrl points at the stage origin", async () => {
    const sandbox = createEcpayBackAuthProvider({
      merchantId: MERCHANT,
      hashKey: HASH_KEY,
      hashIv: HASH_IV,
      baseUrl: ECPAY_BACKAUTH_ORIGINS.sandbox,
    });
    await expect(
      sandbox.creditDoAction({ orderId: "A", tradeNo: "1", action: "R", amount: 1 }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  it("posts the documented shape when the origin is not sandbox", async () => {
    const seen: { body?: Record<string, unknown> } = {};
    server.use(
      http.post(DOACTION_URL, async ({ request }) => {
        seen.body = await readRequestData(request);
        return HttpResponse.json(envelope(DOACTION_OK));
      }),
    );
    const result = await testProvider().creditDoAction({
      orderId: "BAOK85547852370",
      tradeNo: "2608010930520281",
      action: "R",
      amount: 199,
    });

    expect(seen.body).toEqual({
      MerchantID: MERCHANT,
      MerchantTradeNo: "BAOK85547852370",
      TradeNo: "2608010930520281",
      Action: "R",
      TotalAmount: 199,
    });
    expect(result.action).toBe("R");
    expect(result.rtnCode).toBe(1);
  });

  it("validates the action letter and the handles it needs", async () => {
    const p = testProvider();
    await expect(
      p.creditDoAction({
        orderId: "A",
        tradeNo: "1",
        action: "X" as "C",
        amount: 1,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", message: /C\|R\|E\|N/ });
    await expect(
      p.creditDoAction({ orderId: "A", tradeNo: "", action: "R", amount: 1 }),
    ).rejects.toMatchObject({ code: "VALIDATION", message: /tradeNo/ });
    await expect(
      p.creditDoAction({ orderId: "A", tradeNo: "1", action: "R", amount: 0 }),
    ).rejects.toMatchObject({ code: "VALIDATION", message: /正整數/ });
  });

  it("refundPayment needs the gateway TradeNo, and says so", async () => {
    // Unlike the AIO adapter this one will not silently pre-query for the TradeNo;
    // an extra lookup on a refund path is worth being explicit about.
    //
    // Both fields are required by `EcpayBackAuthRefundInput`, so these calls are TYPE
    // errors for a typed consumer — the casts are deliberate, exercising the runtime
    // guard that must still exist because a caller holding the widened
    // `PaymentProvider` type can reach this method without the narrowing.
    await expect(
      testProvider().refundPayment({
        orderId: "BAOK85547852370",
        amount: 199,
      } as EcpayBackAuthRefundInput),
    ).rejects.toMatchObject({ code: "VALIDATION", message: /tradeNo/ });
    await expect(
      testProvider().refundPayment({
        orderId: "BAOK85547852370",
        tradeNo: "1",
      } as EcpayBackAuthRefundInput),
    ).rejects.toMatchObject({ code: "VALIDATION", message: /amount/ });
  });

  it("refundPayment delegates to DoAction R", async () => {
    const seen: { body?: Record<string, unknown> } = {};
    server.use(
      http.post(DOACTION_URL, async ({ request }) => {
        seen.body = await readRequestData(request);
        return HttpResponse.json(envelope(DOACTION_OK));
      }),
    );
    await testProvider().refundPayment({
      orderId: "BAOK85547852370",
      tradeNo: "2608010930520281",
      amount: 199,
    });
    expect(seen.body).toMatchObject({ Action: "R", TotalAmount: 199 });
  });
});

describe("credit queries reachable from the provider", () => {
  it("delegates queryCreditDetail to the shared implementation", async () => {
    server.use(
      http.post(`${BASE}/1.0.0/CreditDetail/QueryTrade`, () =>
        HttpResponse.json(
          envelope({
            RtnMsg: "",
            RtnValue: { TradeID: 14_521_552, Amount: 199, ClsAmt: 0, Status: "Authorized" },
            CloseData: {},
          }),
        ),
      ),
    );
    const detail = await testProvider().queryCreditDetail({ merTradeNo: "BAOK85547852370" });
    expect(detail).toMatchObject({ tradeId: "14521552", status: "Authorized" });
    expect(detail.closeData).toEqual([]);
  });

  it("delegates queryCardInfo, and surfaces the gateway-only failure", async () => {
    server.use(
      http.post(`${BASE}/1.0.0/Credit/QueryCardInfo`, () =>
        HttpResponse.json(
          envelope({ RtnCode: 5_000_095, RtnMsg: "Only support gateway merchantID" }),
        ),
      ),
    );
    await expect(testProvider().queryCardInfo({ cardNoPrefix: "431195222" })).rejects.toMatchObject(
      { code: "UNSUPPORTED", rawCode: "5000095" },
    );
  });
});

describe("verifyPaymentNotify — closes the 3DS branch", () => {
  it("verifies an authorization notify and surfaces the handles worth persisting", () => {
    // When createPayment returned mode:"3ds", this notify is where the result
    // actually arrives. `tradeNo` is the handle creditDoAction needs; `gwsr`
    // (creditRefundId) is the bank authorization reference, which DoAction does NOT
    // accept — doc 45919's request is MerchantID/MerchantTradeNo/TradeNo/Action/
    // TotalAmount only.
    const notify = {
      MerchantID: MERCHANT,
      TransCode: 1,
      Data: envelope({
        RtnCode: 1,
        RtnMsg: "Succeeded.",
        MerchantID: MERCHANT,
        OrderInfo: {
          MerchantTradeNo: "BA3D85547853850",
          TradeNo: "2608010930520281",
          TradeAmt: 199,
          PaymentType: "Credit",
          PaymentDate: "2026/08/01 09:31:00",
          TradeStatus: "1",
        },
        CardInfo: {
          AuthCode: "777777",
          Gwsr: 14_521_552,
          Card6No: "431195",
          Card4No: "2222",
          Eci: 5,
        },
      }).Data,
    };
    const result = testProvider().verifyPaymentNotify(notify);

    expect(result.success).toBe(true);
    expect(result.simulated).toBe(false);
    expect(result.method).toBe("card");
    // What DoAction actually needs:
    expect(result.tradeNo).toBe("2608010930520281");
    // Available, but not a DoAction input:
    expect(result.creditRefundId).toBe("14521552");
    expect(result.card).toMatchObject({ authCode: "777777", card4No: "2222" });
  });

  it("attributes errors to ecpay-backauth", () => {
    const err = (() => {
      try {
        testProvider().verifyPaymentNotify({ MerchantID: MERCHANT, TransCode: 0 });
      } catch (e) {
        return e as PaymentError;
      }
    })();
    expect(err?.provider).toBe("ecpay-backauth");
  });
});
