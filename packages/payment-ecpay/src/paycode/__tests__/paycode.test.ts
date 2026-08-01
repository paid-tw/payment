import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PaymentError } from "@paid-tw/payment";
import { ECPAY_PAYCODE_ORIGINS, resolvePayCodeOrigin } from "../config.js";
import {
  GEN_ATM,
  GEN_ATM_DEFAULT_BANK,
  GEN_BARCODE,
  GEN_CVS,
  GEN_DUPLICATE_ORDER,
  QUERY_INFO_ATM,
  QUERY_TRADE_NOT_FOUND,
  QUERY_TRADE_UNPAID,
  STAGE_QUERY_MER_TRADE_NO,
} from "./paycode-fixtures.js";
import {
  BASE,
  envelope,
  GEN_URL,
  MERCHANT,
  QUERY_INFO_URL,
  QUERY_TRADE_URL,
  readRequestData,
  respondWith,
  server,
  testProvider,
} from "./paycode-server.js";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/** Minimum viable create input; tests override what they exercise. */
const base = {
  amount: 123,
  currency: "TWD",
  orderId: "PCATM85542622715",
  itemDesc: "paid-tw paycode probe",
  notifyUrl: "https://shop.test/ecpay/paycode/notify",
} as const;

/** Capture the decrypted request body a handler received. */
function captureGen(data: Record<string, unknown>) {
  const seen: { body?: Record<string, unknown> } = {};
  server.use(
    http.post(GEN_URL, async ({ request }) => {
      seen.body = await readRequestData(request);
      return HttpResponse.json(envelope(data));
    }),
  );
  return seen;
}

describe("createEcpayPayCodeProvider — shape", () => {
  it("is a distinct provider from AIO and ECPG", () => {
    const provider = testProvider();
    expect(provider.name).toBe("ecpay-paycode");
    expect(provider.capabilities.has("CREATE_PAYMENT")).toBe(true);
    expect(provider.capabilities.has("GET_PAYMENT")).toBe(true);
    expect(provider.capabilities.has("REFUND_PAYMENT")).toBe(false);
  });

  it("resolves the ecpayment host, and lets baseUrl win for tests", () => {
    expect(resolvePayCodeOrigin({ sandbox: true })).toBe(ECPAY_PAYCODE_ORIGINS.sandbox);
    expect(resolvePayCodeOrigin({})).toBe(ECPAY_PAYCODE_ORIGINS.production);
    expect(resolvePayCodeOrigin({ baseUrl: "https://x.test/" })).toBe("https://x.test");
  });

  it("refuses to run without credentials", async () => {
    const provider = testProvider({ hashKey: undefined });
    await expect(provider.createPayment({ ...base, method: "atm" })).rejects.toMatchObject({
      code: "AUTH",
      provider: "ecpay-paycode",
    });
  });

  it("refundPayment is UNSUPPORTED — ECPay has no refund API for cash-in methods", async () => {
    await expect(testProvider().refundPayment({ orderId: "X" })).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  });
});

describe("GenPaymentCode — 取號", () => {
  it("ATM returns the virtual account from a recorded stage response", async () => {
    const seen = captureGen(GEN_ATM);
    const result = await testProvider().createPayment({
      ...base,
      method: "atm",
      expireDate: 3,
      atmBankCode: "822",
      customField: "paid-tw-live",
    });

    expect(result.mode).toBe("paycode");
    expect(result.method).toBe("atm");
    expect(result.status).toBe("unpaid");
    expect(result.atm).toEqual({
      bankCode: "822",
      vAccount: "9251262164875291",
      expireDate: "2026/08/04",
    });
    expect(result.expireDate).toBe("2026/08/04");
    expect(result.tradeNo).toBe("2608010803430236");
    expect(result.amount).toBe(123);
    // Recorded live: ChargeFee is fractional despite the doc typing it Int.
    expect(result.chargeFee).toBe(1.23);
    expect(result.customField).toBe("paid-tw-live");
    expect(result.cvs).toBeUndefined();
    expect(result.barcode).toBeUndefined();

    expect(seen.body).toMatchObject({
      MerchantID: MERCHANT,
      ChoosePayment: "ATM",
      ATMInfo: { ExpireDate: 3, ATMBankCode: "822" },
      OrderInfo: {
        MerchantTradeNo: base.orderId,
        TotalAmount: 123,
        ReturnURL: base.notifyUrl,
        ItemName: base.itemDesc,
        TradeDesc: base.itemDesc,
      },
    });
  });

  it("CVS returns the 繳費代碼 and the mobile barcode page", async () => {
    const seen = captureGen(GEN_CVS);
    const result = await testProvider().createPayment({
      ...base,
      method: "cvs",
      expireDate: 6000,
      cvsChain: "FAMILY",
      cvsDescriptions: ["line one", "line two"],
    });

    expect(result.method).toBe("cvs");
    expect(result.cvs?.paymentNo).toBe("LLL26213917389");
    expect(result.cvs?.paymentUrl).toContain("CVSBarCode?PaymentNo=LLL26213917389");
    expect(result.expireDate).toBe("2026/08/05 12:03:43");
    expect(result.atm).toBeUndefined();

    expect(seen.body?.ChoosePayment).toBe("CVS");
    expect(seen.body?.CVSInfo).toEqual({
      ExpireDate: 6000,
      CVSCode: "FAMILY",
      Desc_1: "line one",
      Desc_2: "line two",
    });
  });

  it("BARCODE returns three segments — segment 1 is not numeric", async () => {
    const seen = captureGen(GEN_BARCODE);
    const result = await testProvider().createPayment({ ...base, method: "barcode" });

    expect(result.method).toBe("barcode");
    expect(result.barcode).toEqual({
      barcode1: "1508086CY",
      barcode2: "1557352207269145",
      barcode3: "080829000000789",
      expireDate: "2026/08/08 23:59:59",
    });
    // ECPay's own doc calls Barcode1 "9 碼數字"; the recorded value ends in letters.
    expect(result.barcode?.barcode1).not.toMatch(/^\d+$/);

    // Defaults applied: BARCODE counts days, default 7.
    expect(seen.body?.BarcodeInfo).toEqual({ ExpireDate: 7 });
  });

  it("applies each method's own ExpireDate default and unit", async () => {
    const atm = captureGen(GEN_ATM);
    await testProvider().createPayment({ ...base, method: "atm" });
    expect(atm.body?.ATMInfo).toEqual({ ExpireDate: 3, ATMBankCode: "" });

    const cvs = captureGen(GEN_CVS);
    await testProvider().createPayment({ ...base, method: "cvs" });
    expect(cvs.body?.CVSInfo).toEqual({ ExpireDate: 10_080, CVSCode: "CVS" });
  });

  it("forwards PlatformID only when configured", async () => {
    const without = captureGen(GEN_ATM);
    await testProvider().createPayment({ ...base, method: "atm" });
    expect(without.body).not.toHaveProperty("PlatformID");

    const with_ = captureGen(GEN_ATM);
    await testProvider({ platformId: "3002608" }).createPayment({ ...base, method: "atm" });
    expect(with_.body?.PlatformID).toBe("3002608");
  });

  it("sends MerchantTradeDate as Taipei yyyy/MM/dd HH:mm:ss", async () => {
    const seen = captureGen(GEN_ATM);
    await testProvider().createPayment({ ...base, method: "atm" });
    const orderInfo = seen.body?.OrderInfo as Record<string, unknown>;
    expect(orderInfo.MerchantTradeDate).toMatch(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("passes Remark through only when given", async () => {
    const seen = captureGen(GEN_ATM);
    await testProvider().createPayment({ ...base, method: "atm", remark: "note" });
    expect(seen.body?.OrderInfo).toMatchObject({ Remark: "note" });
  });
});

describe("GenPaymentCode — request validation", () => {
  const provider = testProvider();

  async function expectValidation(promise: Promise<unknown>, match: RegExp) {
    const err = (await promise.catch((e: unknown) => e)) as PaymentError;
    expect(err.code).toBe("VALIDATION");
    expect(err.provider).toBe("ecpay-paycode");
    expect(err.message).toMatch(match);
    return err;
  }

  it("rejects card / linepay and points at BackAuth", async () => {
    await expectValidation(provider.createPayment({ ...base, method: "card" }), /BackAuth/);
    await expectValidation(provider.createPayment({ ...base, method: "linepay" }), /BackAuth/);
  });

  it("requires notifyUrl as ReturnURL", async () => {
    await expectValidation(
      provider.createPayment({ ...base, method: "atm", notifyUrl: undefined }),
      /ReturnURL/,
    );
  });

  it("rejects a non-TWD currency", async () => {
    await expectValidation(
      provider.createPayment({ ...base, method: "atm", currency: "USD" }),
      /TWD/,
    );
  });

  it("rejects MerchantTradeNo that ECPay would reject", async () => {
    for (const orderId of ["", "has-dash", "A".repeat(21), "中文訂單"]) {
      await expectValidation(
        provider.createPayment({ ...base, method: "atm", orderId }),
        /MerchantTradeNo/,
      );
    }
  });

  it("rejects non-positive or non-integer-able amounts", async () => {
    for (const amount of [0, -5, Number.NaN]) {
      await expectValidation(
        provider.createPayment({ ...base, method: "atm", amount }),
        /TotalAmount/,
      );
    }
  });

  it("enforces per-method ExpireDate ranges, because the unit differs", async () => {
    // ATM: 1-60 days.
    await expectValidation(
      provider.createPayment({ ...base, method: "atm", expireDate: 61 }),
      /1-60 天/,
    );
    await expectValidation(
      provider.createPayment({ ...base, method: "atm", expireDate: 0 }),
      /1-60 天/,
    );
    // CVS: 1-43200 minutes — 61 is legal here, so a shared range would be wrong.
    await expectValidation(
      provider.createPayment({ ...base, method: "cvs", expireDate: 43_201 }),
      /1-43200 分鐘/,
    );
    // BARCODE: 1-30 days.
    await expectValidation(
      provider.createPayment({ ...base, method: "barcode", expireDate: 31 }),
      /1-30 天/,
    );
    await expectValidation(
      provider.createPayment({ ...base, method: "atm", expireDate: 1.5 }),
      /整數/,
    );
  });

  it("accepts an ExpireDate that is only valid for that method", async () => {
    const seen = captureGen(GEN_CVS);
    await testProvider().createPayment({ ...base, method: "cvs", expireDate: 43_200 });
    expect(seen.body?.CVSInfo).toMatchObject({ ExpireDate: 43_200 });
  });

  it("rejects more than four CVS description lines", async () => {
    await expectValidation(
      provider.createPayment({
        ...base,
        method: "cvs",
        cvsDescriptions: ["1", "2", "3", "4", "5"],
      }),
      /最多 4 行/,
    );
  });
});

describe("GenPaymentCode — gateway failures", () => {
  it("maps a duplicate order to CONFLICT and keeps ECPay's wording", async () => {
    server.use(respondWith(GEN_URL, GEN_DUPLICATE_ORDER));
    const err = (await testProvider()
      .createPayment({ ...base, method: "atm" })
      .catch((e: unknown) => e)) as PaymentError;

    expect(err.code).toBe("CONFLICT");
    expect(err.rawCode).toBe("10300028");
    expect(err.message).toContain("duplicate order number");
    expect(err.message).toContain("MerchantTradeNo 重複");
  });

  it("passes an unmapped RtnCode through as PROVIDER without losing the code", async () => {
    server.use(respondWith(GEN_URL, { RtnCode: 99_999_999, RtnMsg: "brand new failure" }));
    const err = (await testProvider()
      .createPayment({ ...base, method: "atm" })
      .catch((e: unknown) => e)) as PaymentError;

    expect(err.code).toBe("PROVIDER");
    expect(err.rawCode).toBe("99999999");
    expect(err.rawMessage).toBe("brand new failure");
  });

  it("fails when TransCode reports the envelope was rejected", async () => {
    server.use(http.post(GEN_URL, () => HttpResponse.json(envelope({ RtnCode: 1 }, 0))));
    await expect(testProvider().createPayment({ ...base, method: "atm" })).rejects.toMatchObject({
      code: "PROVIDER",
      rawCode: "0",
      provider: "ecpay-paycode",
    });
  });

  it("fails when Data is missing from an otherwise OK envelope", async () => {
    server.use(
      http.post(GEN_URL, () =>
        HttpResponse.json({ MerchantID: MERCHANT, TransCode: 1, TransMsg: "Success!" }),
      ),
    );
    await expect(testProvider().createPayment({ ...base, method: "atm" })).rejects.toMatchObject({
      code: "PROVIDER",
      message: /缺少 Data/,
    });
  });

  it("fails when Data cannot be decrypted with our keys", async () => {
    server.use(
      http.post(GEN_URL, () =>
        HttpResponse.json({
          MerchantID: MERCHANT,
          TransCode: 1,
          TransMsg: "Success!",
          Data: "bm90LWEtdmFsaWQtY2lwaGVy",
        }),
      ),
    );
    await expect(testProvider().createPayment({ ...base, method: "atm" })).rejects.toMatchObject({
      code: "PROVIDER",
      message: /解密失敗/,
    });
  });

  it("maps an HTTP error to PROVIDER with the status as rawCode", async () => {
    server.use(http.post(GEN_URL, () => new HttpResponse(null, { status: 503 })));
    await expect(testProvider().createPayment({ ...base, method: "atm" })).rejects.toMatchObject({
      code: "PROVIDER",
      rawCode: "503",
    });
  });

  it("maps a transport failure to NETWORK", async () => {
    server.use(http.post(GEN_URL, () => HttpResponse.error()));
    await expect(testProvider().createPayment({ ...base, method: "atm" })).rejects.toMatchObject({
      code: "NETWORK",
      provider: "ecpay-paycode",
    });
  });

  it("rejects a success response that carries no payment code at all", async () => {
    // Guards against reporting a usable 取號 when ECPay answered RtnCode 1 with
    // empty Info objects — the caller would otherwise show the consumer nothing.
    server.use(
      respondWith(GEN_URL, {
        RtnCode: 1,
        RtnMsg: "成功",
        OrderInfo: { MerchantTradeNo: base.orderId, TradeStatus: "0" },
      }),
    );
    await expect(testProvider().createPayment({ ...base, method: "atm" })).rejects.toMatchObject({
      code: "PROVIDER",
      message: /沒有繳費資訊/,
    });
  });
});

describe("QueryTrade — getPayment", () => {
  it("normalizes an unpaid ATM order", async () => {
    server.use(respondWith(QUERY_TRADE_URL, QUERY_TRADE_UNPAID));
    const data = await testProvider().getPayment({ merTradeNo: STAGE_QUERY_MER_TRADE_NO });

    expect(data).toMatchObject({
      status: "unpaid",
      method: "atm",
      amount: 100,
      tradeNo: "2608010803460239",
      merTradeNo: STAGE_QUERY_MER_TRADE_NO,
    });
    // PaymentDate is "" on an unpaid order — must not surface as an empty string.
    expect(data.paidAt).toBeUndefined();
  });

  it("normalizes a paid order", async () => {
    server.use(
      respondWith(QUERY_TRADE_URL, {
        ...QUERY_TRADE_UNPAID,
        OrderInfo: {
          ...QUERY_TRADE_UNPAID.OrderInfo,
          TradeStatus: "1",
          PaymentDate: "2026/08/02 10:11:12",
        },
        ATMInfo: { ATMAccBank: "822", ATMAccNo: "12345" },
      }),
    );
    const data = await testProvider().getPayment({ merTradeNo: STAGE_QUERY_MER_TRADE_NO });
    expect(data.status).toBe("paid");
    expect(data.paidAt).toBe("2026/08/02 10:11:12");
  });

  it("maps 查無交易資料 to NOT_FOUND", async () => {
    server.use(respondWith(QUERY_TRADE_URL, QUERY_TRADE_NOT_FOUND));
    const err = (await testProvider()
      .getPayment({ merTradeNo: "NEVEREXISTED" })
      .catch((e: unknown) => e)) as PaymentError;

    expect(err.code).toBe("NOT_FOUND");
    expect(err.rawCode).toBe("10000185");
  });

  it("requires MerchantTradeNo — this API cannot query by TradeNo", async () => {
    await expect(testProvider().getPayment({ tradeNo: "2608010803460239" })).rejects.toMatchObject({
      code: "VALIDATION",
      message: /MerchantTradeNo/,
    });
  });

  it("keeps an unknown PaymentType verbatim instead of collapsing it", async () => {
    // ECPay adds payment types over time; mapping an unseen one to "unknown" would
    // silently discard information the caller can still act on.
    server.use(
      respondWith(QUERY_TRADE_URL, {
        ...QUERY_TRADE_UNPAID,
        OrderInfo: { ...QUERY_TRADE_UNPAID.OrderInfo, PaymentType: "TWQR" },
      }),
    );
    const data = await testProvider().getPayment({ merTradeNo: STAGE_QUERY_MER_TRADE_NO });
    expect(data.method).toBe("TWQR");
  });

  it("reports an absent PaymentType as unknown", async () => {
    server.use(
      respondWith(QUERY_TRADE_URL, {
        ...QUERY_TRADE_UNPAID,
        OrderInfo: { MerchantTradeNo: STAGE_QUERY_MER_TRADE_NO, TradeStatus: "0" },
      }),
    );
    const data = await testProvider().getPayment({ merTradeNo: STAGE_QUERY_MER_TRADE_NO });
    expect(data.method).toBe("unknown");
    expect(data.amount).toBeUndefined();
  });

  it("keeps an unknown TradeStatus verbatim instead of guessing", async () => {
    server.use(
      respondWith(QUERY_TRADE_URL, {
        ...QUERY_TRADE_UNPAID,
        OrderInfo: { ...QUERY_TRADE_UNPAID.OrderInfo, TradeStatus: "9" },
      }),
    );
    const data = await testProvider().getPayment({ merTradeNo: STAGE_QUERY_MER_TRADE_NO });
    expect(data.status).toBe("9");
  });
});

describe("QueryPaymentInfo — getPaymentCode", () => {
  it("re-reads the virtual account that QueryTrade does not carry", async () => {
    server.use(respondWith(QUERY_INFO_URL, QUERY_INFO_ATM));
    const info = await testProvider().getPaymentCode({
      merTradeNo: STAGE_QUERY_MER_TRADE_NO,
    });

    expect(info.method).toBe("atm");
    expect(info.atm?.vAccount).toBe("3833846216926530");
    expect(info.atm?.bankCode).toBe("004");
    expect(info.status).toBe("unpaid");
  });

  it("QueryTrade's ATMInfo is the payer, not the code — and nulls stay undefined", async () => {
    // Recorded live: QueryTrade answers ATMAccBank/ATMAccNo as JSON null. Feeding
    // that payload to the code normalizer must yield no ATM code (and never the
    // string "null"), which is exactly why getPaymentCode exists.
    server.use(respondWith(QUERY_INFO_URL, QUERY_TRADE_UNPAID));
    const info = await testProvider().getPaymentCode({
      merTradeNo: STAGE_QUERY_MER_TRADE_NO,
    });
    expect(info.atm).toBeUndefined();
    expect(JSON.stringify(info)).not.toContain('"null"');
  });

  it.each([
    ["barcode", GEN_BARCODE],
    ["cvs", GEN_CVS],
    ["atm", GEN_ATM],
  ] as const)(
    "infers method %s from PaymentType when the caller did not pick one",
    async (expected, payload) => {
      server.use(respondWith(QUERY_INFO_URL, payload));
      const info = await testProvider().getPaymentCode({ merTradeNo: "WHATEVER" });
      expect(info.method).toBe(expected);
    },
  );

  it("falls back to whichever Info object is populated when PaymentType is unusable", async () => {
    // QueryPaymentInfo documents all three Info keys; if ECPay ever omits or renames
    // PaymentType we must still label the code we actually got, not guess "atm".
    server.use(
      respondWith(QUERY_INFO_URL, {
        RtnCode: 1,
        RtnMsg: "Success!",
        OrderInfo: { MerchantTradeNo: "PCX", PaymentType: "SomethingNew", TradeStatus: "0" },
        CVSInfo: { PaymentNo: "LLL26213917389", ExpireDate: "2026/08/05 12:03:43" },
      }),
    );
    const info = await testProvider().getPaymentCode({ merTradeNo: "PCX" });
    expect(info.method).toBe("cvs");
    expect(info.cvs?.paymentNo).toBe("LLL26213917389");
  });

  it("propagates NOT_FOUND from the query family", async () => {
    server.use(respondWith(QUERY_INFO_URL, QUERY_TRADE_NOT_FOUND));
    await expect(testProvider().getPaymentCode({ merTradeNo: "NOPE" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("endpoint routing", () => {
  it("posts each operation to its own path under the configured origin", async () => {
    const hits: string[] = [];
    server.use(
      http.post(`${BASE}/*`, ({ request }) => {
        hits.push(new URL(request.url).pathname);
        return HttpResponse.json(envelope(GEN_ATM_DEFAULT_BANK));
      }),
    );

    const provider = testProvider();
    await provider.createPayment({ ...base, method: "atm" });
    await provider.getPayment({ merTradeNo: STAGE_QUERY_MER_TRADE_NO });
    await provider.getPaymentCode({ merTradeNo: STAGE_QUERY_MER_TRADE_NO });

    expect(hits).toEqual([
      "/1.0.0/Cashier/GenPaymentCode",
      "/1.0.0/Cashier/QueryTrade",
      "/1.0.0/Cashier/QueryPaymentInfo",
    ]);
  });
});
