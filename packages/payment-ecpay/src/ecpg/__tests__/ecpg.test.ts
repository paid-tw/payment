import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PaymentError } from "@paid-tw/payment";
import { ECPAY_SANDBOX } from "../../config.js";
import { encryptData } from "../aes.js";
import { createEcpayEcpgProvider } from "../provider.js";

const BASE = "https://ecpg.test";
const KEY = ECPAY_SANDBOX.hashKey;
const IV = ECPAY_SANDBOX.hashIv;
const MERCHANT = ECPAY_SANDBOX.merchantId;

const TOKEN_URL = `${BASE}/Merchant/GetTokenbyTrade`;
const CREATE_URL = `${BASE}/Merchant/CreatePayment`;

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function provider() {
  return createEcpayEcpgProvider({
    merchantId: MERCHANT,
    hashKey: KEY,
    hashIv: IV,
    baseUrl: BASE,
    sandbox: true,
  });
}

function okEnvelope(data: Record<string, unknown>) {
  return {
    MerchantID: MERCHANT,
    RpHeader: { Timestamp: 1 },
    TransCode: 1,
    TransMsg: "Success",
    Data: encryptData(data, KEY, IV),
  };
}

describe("createEcpayEcpgProvider", () => {
  it("has name ecpay-ecpg and only CREATE_PAYMENT", () => {
    const p = provider();
    expect(p.name).toBe("ecpay-ecpg");
    expect(p.capabilities.has("CREATE_PAYMENT")).toBe(true);
    expect(p.capabilities.has("GET_PAYMENT")).toBe(false);
  });

  it("GetTokenbyTrade returns mode:token (not a settled payment)", async () => {
    let captured: Record<string, unknown> | undefined;
    server.use(
      http.post(TOKEN_URL, async ({ request }) => {
        captured = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          okEnvelope({
            RtnCode: 1,
            RtnMsg: "Success",
            MerchantID: MERCHANT,
            Token: "tok_abc123",
            TokenExpireDate: "2026/12/31 23:59:59",
          }),
        );
      }),
    );

    const result = await provider().createPayment({
      amount: 100,
      currency: "TWD",
      method: "card",
      orderId: "ECPGORDER01",
      notifyUrl: "https://shop.test/notify",
      returnUrl: "https://shop.test/result",
      email: "buyer@example.com",
      itemDesc: "item",
    });

    expect(result.mode).toBe("token");
    expect(result.token).toBe("tok_abc123");
    expect(result.merchantTradeNo).toBe("ECPGORDER01");
    expect(result.frontend.environment).toBe("stage");
    expect(captured?.MerchantID).toBe(MERCHANT);
    expect(typeof captured?.Data).toBe("string");
    expect(captured?.RqHeader).toMatchObject({ Timestamp: expect.any(Number) });
  });

  it("rejects missing consumer contact", async () => {
    const err = await provider()
      .createPayment({
        amount: 1,
        currency: "TWD",
        method: "card",
        orderId: "X1",
        notifyUrl: "https://n.test",
      })
      .catch((e) => e);
    expect((err as PaymentError).code).toBe("VALIDATION");
  });

  it("createPaymentWithPayToken normalizes 3DS URL", async () => {
    server.use(
      http.post(CREATE_URL, () =>
        HttpResponse.json(
          okEnvelope({
            RtnCode: 1,
            RtnMsg: "Success",
            MerchantID: MERCHANT,
            OrderInfo: { MerchantTradeNo: "ECPGORDER01" },
            ThreeDInfo: { ThreeDURL: "https://3d.example/verify" },
          }),
        ),
      ),
    );

    const result = await provider().createPaymentWithPayToken({
      payToken: "pay_xyz",
      merchantTradeNo: "ECPGORDER01",
    });

    expect(result.mode).toBe("ecpg_create");
    expect(result.success).toBe(true);
    expect(result.threeDUrl).toBe("https://3d.example/verify");
    expect(result.merTradeNo).toBe("ECPGORDER01");
  });

  it("createPaymentWithPayToken normalizes ATM take-number", async () => {
    server.use(
      http.post(CREATE_URL, () =>
        HttpResponse.json(
          okEnvelope({
            RtnCode: 1,
            RtnMsg: "Success",
            OrderInfo: {
              MerchantTradeNo: "ATM1",
              TradeNo: "T1",
              TradeAmt: 500,
            },
            ATMInfo: { BankCode: "007", vAccount: "12345678901234", ExpireDate: "2026/08/01" },
          }),
        ),
      ),
    );
    const result = await provider().createPaymentWithPayToken({
      payToken: "p",
      merchantTradeNo: "ATM1",
    });
    expect(result.atm?.bankCode).toBe("007");
    expect(result.atm?.vAccount).toBe("12345678901234");
    expect(result.amount).toBe(500);
  });

  it("maps TransCode != 1 to PROVIDER", async () => {
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json({
          MerchantID: MERCHANT,
          TransCode: 0,
          TransMsg: "bad",
          Data: "",
        }),
      ),
    );
    const err = await provider()
      .createPayment({
        amount: 1,
        currency: "TWD",
        method: "card",
        orderId: "Z1",
        notifyUrl: "https://n.test",
        email: "a@b.c",
      })
      .catch((e) => e);
    expect((err as PaymentError).code).toBe("PROVIDER");
  });

  it("getPayment / refundPayment are UNSUPPORTED", async () => {
    const p = provider();
    await expect(p.getPayment({ merTradeNo: "x" })).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(p.refundPayment({ orderId: "x" })).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });
});

describe("null coercion on the token path", () => {
  it('rejects a null Token instead of accepting the string "null"', async () => {
    // String(null) === "null" is truthy, so the emptiness guard would have passed
    // it through as a usable embed token.
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json(okEnvelope({ RtnCode: 1, RtnMsg: "Success", Token: null })),
      ),
    );
    const err = await provider()
      .createPayment({
        amount: 1,
        currency: "TWD",
        method: "card",
        orderId: "NULLTOK1",
        notifyUrl: "https://n.test",
        email: "a@b.c",
      })
      .catch((e: unknown) => e);
    expect((err as PaymentError).code).toBe("PROVIDER");
    expect((err as PaymentError).message).toMatch(/缺少 Token/);
  });

  it('omits a null TokenExpireDate rather than reporting "null"', async () => {
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json(
          okEnvelope({ RtnCode: 1, RtnMsg: "Success", Token: "tok_1", TokenExpireDate: null }),
        ),
      ),
    );
    const result = await provider().createPayment({
      amount: 1,
      currency: "TWD",
      method: "card",
      orderId: "NULLEXP1",
      notifyUrl: "https://n.test",
      email: "a@b.c",
    });
    expect(result.token).toBe("tok_1");
    expect(result.tokenExpireDate).toBeUndefined();
  });

  it("drops null ATM/CVS fields from createPaymentWithPayToken", async () => {
    server.use(
      http.post(CREATE_URL, () =>
        HttpResponse.json(
          okEnvelope({
            RtnCode: 1,
            RtnMsg: "Success",
            OrderInfo: { MerchantTradeNo: "MIX1", TradeNo: null },
            ATMInfo: { BankCode: null, vAccount: "12345678901234", ExpireDate: null },
          }),
        ),
      ),
    );
    const result = await provider().createPaymentWithPayToken({
      payToken: "p",
      merchantTradeNo: "MIX1",
    });
    expect(result.atm).toEqual({ vAccount: "12345678901234" });
    expect(result.tradeNo).toBeUndefined();
    expect(JSON.stringify(result.atm)).not.toContain("null");
  });
});
