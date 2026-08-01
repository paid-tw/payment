import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PaymentError } from "@paid-tw/payment";
import { ECPAY_CREDIT_ORIGINS, resolveCreditOrigin } from "../config.js";
import { queryEcpayCardInfo, queryEcpayCreditDetail } from "../queries.js";
import {
  CARD_INFO_NOT_GATEWAY,
  CARD_INFO_PADDED,
  CARD_INFO_UNKNOWN_BIN,
  CARD_INFO_WITH_COBRANDING,
  DETAIL_AIO_CASING,
  DETAIL_AUTHORIZED,
  DETAIL_CAPTURED,
  DETAIL_NOT_FOUND,
  STAGE_CREDIT_MER_TRADE_NO,
  STAGE_CREDIT_TRADE_NO,
} from "./credit-fixtures.js";
import {
  BASE,
  capture,
  CARD_INFO_URL,
  config,
  DETAIL_URL,
  envelope,
  MERCHANT,
  respondWith,
  server,
} from "./credit-server.js";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const detailInput = { merTradeNo: STAGE_CREDIT_MER_TRADE_NO };

async function caught(promise: Promise<unknown>): Promise<PaymentError> {
  return (await promise.catch((e: unknown) => e)) as PaymentError;
}

describe("credit query config", () => {
  it("resolves the ecpayment host, not the AIO or ECPG one", () => {
    expect(resolveCreditOrigin({ sandbox: true })).toBe(ECPAY_CREDIT_ORIGINS.sandbox);
    expect(resolveCreditOrigin({})).toBe(ECPAY_CREDIT_ORIGINS.production);
    expect(resolveCreditOrigin({ baseUrl: "https://x.test/" })).toBe("https://x.test");
  });

  it("requires credentials on both functions", async () => {
    const bare = { sandbox: true };
    expect((await caught(queryEcpayCreditDetail(bare, detailInput))).code).toBe("AUTH");
    expect((await caught(queryEcpayCardInfo(bare, { cardNoPrefix: "431195" }))).code).toBe("AUTH");
  });
});

describe("CreditDetail/QueryTrade — success shapes", () => {
  it("normalizes an authorized-not-captured order", async () => {
    server.use(respondWith(DETAIL_URL, DETAIL_AUTHORIZED));
    const detail = await queryEcpayCreditDetail(config, detailInput);

    expect(detail).toMatchObject({
      tradeId: "14521552",
      amount: 199,
      closedAmount: 0,
      authTime: "2026/08/01 09:30:52",
      status: "Authorized",
    });
    // CloseData was `{}` — must become an empty array, not throw and not `{}`.
    expect(detail.closeData).toEqual([]);
  });

  it("reads CloseData from the top level, where ECPay actually puts it", async () => {
    // The bug this pins: doc 45925 lists CloseData among the Data params without
    // showing nesting, and reading it from RtnValue yields [] forever.
    server.use(respondWith(DETAIL_URL, DETAIL_CAPTURED));
    const detail = await queryEcpayCreditDetail(config, detailInput);

    expect(detail.closedAmount).toBe(199);
    expect(detail.closeData).toEqual([
      { status: "Captured", amount: 199, dateTime: "2026/08/02 03:00:00", sno: undefined },
      { status: "To be captured", amount: 0, dateTime: "2026/08/01 09:30:52", sno: undefined },
    ]);
  });

  it("still reads CloseData if it ever moves inside RtnValue", async () => {
    // Defensive: both positions are accepted so a relocation cannot silently empty it.
    server.use(
      respondWith(DETAIL_URL, {
        RtnMsg: "",
        RtnValue: {
          ...DETAIL_CAPTURED.RtnValue,
          CloseData: [{ Status: "Captured", Amount: 199, DateTime: "2026/08/02 03:00:00" }],
        },
      }),
    );
    const detail = await queryEcpayCreditDetail(config, detailInput);
    expect(detail.closeData).toHaveLength(1);
  });

  it("accepts the AIO transport's lowercase field names too", async () => {
    // Same logical endpoint, two casings: the form API sends amount/clsamt/authtime/
    // close_data/sno while the AES-JSON one sends PascalCase.
    server.use(respondWith(DETAIL_URL, DETAIL_AIO_CASING));
    const detail = await queryEcpayCreditDetail(config, detailInput);

    expect(detail).toMatchObject({ amount: 199, closedAmount: 199, status: "Captured" });
    expect(detail.closeData[0]).toMatchObject({ status: "Captured", sno: "1" });
  });

  it("sends MerchantTradeNo, and TradeNo only when given", async () => {
    const seen = capture(DETAIL_URL, DETAIL_AUTHORIZED);
    await queryEcpayCreditDetail(config, detailInput);
    expect(seen.body).toEqual({
      MerchantID: MERCHANT,
      MerchantTradeNo: STAGE_CREDIT_MER_TRADE_NO,
    });

    await queryEcpayCreditDetail(config, { ...detailInput, tradeNo: STAGE_CREDIT_TRADE_NO });
    expect(seen.body).toMatchObject({ TradeNo: STAGE_CREDIT_TRADE_NO });
  });

  it("forwards PlatformID only when configured", async () => {
    const seen = capture(DETAIL_URL, DETAIL_AUTHORIZED);
    await queryEcpayCreditDetail(config, detailInput);
    expect(seen.body).not.toHaveProperty("PlatformID");

    await queryEcpayCreditDetail({ ...config, platformId: "3085780" }, detailInput);
    expect(seen.body).toMatchObject({ PlatformID: "3085780" });
  });
});

describe("CreditDetail/QueryTrade — the two error protocols", () => {
  it("maps the RtnCode protocol ECPay actually uses (10000185 → NOT_FOUND)", async () => {
    server.use(respondWith(DETAIL_URL, DETAIL_NOT_FOUND));
    const err = await caught(queryEcpayCreditDetail(config, detailInput));

    expect(err.code).toBe("NOT_FOUND");
    expect(err.rawCode).toBe("10000185");
    expect(err.message).toContain("查無交易資料");
    expect(err.rawMessage).toBe("Cant not find the trade data");
  });

  it("passes an unmapped RtnCode through as PROVIDER without losing it", async () => {
    server.use(respondWith(DETAIL_URL, { RtnCode: 987_654, RtnMsg: "brand new" }));
    const err = await caught(queryEcpayCreditDetail(config, detailInput));
    expect(err.code).toBe("PROVIDER");
    expect(err.rawCode).toBe("987654");
    expect(err.rawMessage).toBe("brand new");
  });

  it.each([
    ["error_Stop", "AUTH", /商家/],
    ["error_nopay", "CONFLICT", /銀行尚未回覆/],
    ["error", "PROVIDER", /資料檢核/],
  ] as const)("maps the documented %s protocol to %s", async (msg, code, match) => {
    // Doc 45925's protocol: no RtnCode, failure in RtnMsg. Not observed on stage, but
    // implemented because the doc specifies it.
    server.use(respondWith(DETAIL_URL, { RtnMsg: msg }));
    const err = await caught(queryEcpayCreditDetail(config, detailInput));
    expect(err.code).toBe(code);
    expect(err.message).toMatch(match);
    expect(err.rawCode).toBe(msg);
  });

  it("treats error_nopay as retryable rather than a miss", async () => {
    // ECPay's guidance: the bank has not replied; re-query in 10 minutes. Reporting
    // NOT_FOUND here would make a caller give up on a live order.
    server.use(respondWith(DETAIL_URL, { RtnMsg: "error_nopay" }));
    const err = await caught(queryEcpayCreditDetail(config, detailInput));
    expect(err.code).toBe("CONFLICT");
    expect(err.code).not.toBe("NOT_FOUND");
  });

  it("rejects an unexpected non-empty RtnMsg rather than treating it as success", async () => {
    server.use(respondWith(DETAIL_URL, { RtnMsg: "something new", RtnValue: { Amount: 1 } }));
    expect((await caught(queryEcpayCreditDetail(config, detailInput))).code).toBe("PROVIDER");
  });

  it("rejects a success-shaped response with no RtnValue", async () => {
    server.use(respondWith(DETAIL_URL, { RtnMsg: "" }));
    const err = await caught(queryEcpayCreditDetail(config, detailInput));
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toMatch(/沒有 RtnValue/);
  });

  it("requires merTradeNo", async () => {
    const err = await caught(queryEcpayCreditDetail(config, { merTradeNo: "" }));
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toMatch(/merTradeNo/);
  });
});

describe("Credit/QueryCardInfo", () => {
  it("returns the issuer and any co-branding", async () => {
    server.use(respondWith(CARD_INFO_URL, CARD_INFO_WITH_COBRANDING));
    const info = await queryEcpayCardInfo(config, { cardNoPrefix: "431195222" });

    expect(info.issuingBank).toBe("中國信託");
    expect(info.issuingBankCode).toBe("822");
    expect(info.coBranding).toEqual([{ code: "ABCTest", comment: "APP SDK測試" }]);
  });

  it("pads a short prefix to 9 — which changes the answer", async () => {
    // Verified against stage: 431195222 returns a 聯名卡 entry, the padded
    // 431195 → 431195000 does not. Padding is what the doc asks for but it is not
    // semantically neutral, so the request shape is asserted explicitly.
    const seen = capture(CARD_INFO_URL, CARD_INFO_PADDED);
    const info = await queryEcpayCardInfo(config, { cardNoPrefix: "431195" });

    expect(seen.body).toEqual({ MerchantID: MERCHANT, CardNo: "431195000" });
    expect(info.coBranding).toEqual([]);
    expect(info.issuingBank).toBe("中國信託");
  });

  it("sends a full 9-digit prefix unchanged", async () => {
    const seen = capture(CARD_INFO_URL, CARD_INFO_WITH_COBRANDING);
    await queryEcpayCardInfo(config, { cardNoPrefix: "431195222" });
    expect(seen.body).toMatchObject({ CardNo: "431195222" });
  });

  it("maps the gateway-only failure to UNSUPPORTED", async () => {
    // 5000095 is a capability problem: this endpoint is 閘道商-only, so no payload fix
    // helps. UNSUPPORTED tells the caller to stop retrying.
    server.use(respondWith(CARD_INFO_URL, CARD_INFO_NOT_GATEWAY));
    const err = await caught(queryEcpayCardInfo(config, { cardNoPrefix: "431195222" }));

    expect(err.code).toBe("UNSUPPORTED");
    expect(err.rawCode).toBe("5000095");
    expect(err.message).toMatch(/限閘道商/);
  });

  it("maps an unrecognised BIN to NOT_FOUND", async () => {
    server.use(respondWith(CARD_INFO_URL, CARD_INFO_UNKNOWN_BIN));
    const err = await caught(queryEcpayCardInfo(config, { cardNoPrefix: "999999" }));
    expect(err.code).toBe("NOT_FOUND");
    expect(err.rawCode).toBe("0");
    expect(err.rawMessage).toBe("查詢失敗");
  });

  it("tolerates CoBrandingInfo arriving as a non-array", async () => {
    server.use(respondWith(CARD_INFO_URL, { ...CARD_INFO_WITH_COBRANDING, CoBrandingInfo: {} }));
    const info = await queryEcpayCardInfo(config, { cardNoPrefix: "431195222" });
    expect(info.coBranding).toEqual([]);
  });

  it.each([
    { prefix: "43119", why: "too short" },
    { prefix: "4311952222222222", why: "a full card number" },
    { prefix: "43119a", why: "non-digits" },
    { prefix: "", why: "empty" },
    { prefix: "4311952229", why: "10 digits" },
  ] as const)("rejects $prefix ($why) locally", async ({ prefix }) => {
    const err = await caught(queryEcpayCardInfo(config, { cardNoPrefix: prefix }));
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toMatch(/6-9 碼數字/);
  });

  it("refuses a full PAN with a message saying why", async () => {
    // Sending 16 digits here would put a real card number on the wire for a lookup
    // that only needs the issuer range.
    const err = await caught(queryEcpayCardInfo(config, { cardNoPrefix: "4311952222222222" }));
    expect(err.message).toMatch(/請勿傳完整卡號/);
  });
});

describe("envelope and transport failures", () => {
  it.each([
    ["CreditDetail", DETAIL_URL, () => queryEcpayCreditDetail(config, detailInput)],
    ["QueryCardInfo", CARD_INFO_URL, () => queryEcpayCardInfo(config, { cardNoPrefix: "431195" })],
  ] as const)("%s: TransCode != 1 fails", async (_label, url, call) => {
    server.use(http.post(url, () => HttpResponse.json(envelope({ RtnCode: 1 }, 0))));
    const err = await caught(call());
    expect(err.code).toBe("PROVIDER");
    expect(err.rawCode).toBe("0");
    expect(err.provider).toBe("ecpay-credit");
  });

  it.each([
    ["CreditDetail", DETAIL_URL, () => queryEcpayCreditDetail(config, detailInput)],
    ["QueryCardInfo", CARD_INFO_URL, () => queryEcpayCardInfo(config, { cardNoPrefix: "431195" })],
  ] as const)("%s: missing Data fails", async (_label, url, call) => {
    server.use(http.post(url, () => HttpResponse.json({ MerchantID: MERCHANT, TransCode: 1 })));
    expect((await caught(call())).message).toMatch(/缺少 Data/);
  });

  it("undecryptable Data fails rather than silently returning nothing", async () => {
    server.use(
      http.post(DETAIL_URL, () =>
        HttpResponse.json({ MerchantID: MERCHANT, TransCode: 1, Data: "bm90LWNpcGhlcg==" }),
      ),
    );
    expect((await caught(queryEcpayCreditDetail(config, detailInput))).message).toMatch(/解密失敗/);
  });

  it("HTTP error maps to PROVIDER with the status as rawCode", async () => {
    server.use(http.post(DETAIL_URL, () => new HttpResponse(null, { status: 503 })));
    const err = await caught(queryEcpayCreditDetail(config, detailInput));
    expect(err.code).toBe("PROVIDER");
    expect(err.rawCode).toBe("503");
  });

  it("transport failure maps to NETWORK", async () => {
    server.use(http.post(DETAIL_URL, () => HttpResponse.error()));
    expect((await caught(queryEcpayCreditDetail(config, detailInput))).code).toBe("NETWORK");
  });

  it("posts each query to its own path", async () => {
    const hits: string[] = [];
    server.use(
      http.post(`${BASE}/*`, ({ request }) => {
        hits.push(new URL(request.url).pathname);
        return HttpResponse.json(envelope(DETAIL_AUTHORIZED));
      }),
    );
    await queryEcpayCreditDetail(config, detailInput);
    await queryEcpayCardInfo(config, { cardNoPrefix: "431195222" }).catch(() => undefined);
    expect(hits).toEqual(["/1.0.0/CreditDetail/QueryTrade", "/1.0.0/Credit/QueryCardInfo"]);
  });
});
