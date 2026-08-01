import { describe, expect, it } from "vitest";
import { isPaymentError, type PaymentError } from "@paid-tw/payment";
import { ECPAY_SANDBOX_NO_3D, ECPAY_TEST_CARD } from "../../backauth/config.js";
import { createEcpayBackAuthProvider } from "../../backauth/provider.js";
import { ECPAY_SANDBOX_GATEWAY } from "../config.js";
import { queryEcpayCardInfo, queryEcpayCreditDetail } from "../queries.js";

/**
 * Live tests for the credit queries on **ecpayment-stage**.
 *
 *   ECPAY_LIVE=1 pnpm test:live:ecpay:credit
 *
 * Uses two different published stage merchants on purpose, because the two endpoints
 * have different access rules:
 *
 *   - `CreditDetail/QueryTrade` — the no-3D merchant `2000132`, so the suite can
 *     create a real authorization with BackAuth and then query it. Self-contained:
 *     nothing depends on an order recorded on a previous day.
 *   - `Credit/QueryCardInfo` — the 閘道商 merchant `3085779`. This endpoint is
 *     gateway-only; an ordinary merchant gets `5000095`, which the suite also asserts
 *     so the capability boundary itself stays verified.
 *
 * Not reachable from stage, and therefore doc-derived in the fixtures: a **captured**
 * order (`CloseData` as a populated array), because capture needs `Credit/DoAction`
 * and ECPay does not expose that on stage at all.
 */
const live = process.env.ECPAY_LIVE === "1";
const LIVE_OPTS = { retry: 2, timeout: 40_000 } as const;

function dump(label: string, value: unknown): void {
  if (process.env.PAID_DEBUG === "1") {
    console.error(`[credit-live] ${label}:`, JSON.stringify(value, null, 2));
  }
}

function futureExpiry() {
  return { month: "12", year: String((new Date().getUTCFullYear() + 4) % 100).padStart(2, "0") };
}

describe.skipIf(!live)("ECPay credit queries live — stage", LIVE_OPTS, () => {
  /** Authorize once, then query it — keeps the suite independent of past runs. */
  async function freshAuthorizedOrder() {
    const provider = createEcpayBackAuthProvider({ ...ECPAY_SANDBOX_NO_3D });
    const orderId = `CQ${Date.now().toString().slice(-11)}`;
    const exp = futureExpiry();
    const result = await provider.createPayment({
      amount: 199,
      currency: "TWD",
      method: "card",
      orderId,
      itemDesc: "paid-tw credit-query probe",
      notifyUrl: "https://example.com/ecpay/backauth/notify",
      orderResultUrl: "https://example.com/ecpay/backauth/result",
      card: {
        cardNo: ECPAY_TEST_CARD.cardNo,
        expiryMonth: exp.month,
        expiryYear: exp.year,
        cvv: ECPAY_TEST_CARD.cvv,
      },
      phone: "886912345678",
      cardholderName: "TEST USER",
    });
    if (result.mode !== "authorized") throw new Error("expected a direct authorization");
    return { orderId, result };
  }

  it("CreditDetail/QueryTrade returns the authorization we just made", async () => {
    const { orderId, result } = await freshAuthorizedOrder();
    const detail = await queryEcpayCreditDetail(
      { ...ECPAY_SANDBOX_NO_3D },
      {
        merTradeNo: orderId,
      },
    );
    dump("CreditDetail", detail.raw);

    expect(detail.amount).toBe(199);
    expect(detail.status).toBe("Authorized");
    expect(detail.authTime).toMatch(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/);
    // TradeID is the same 授權單號 the authorization reported as Gwsr.
    expect(detail.tradeId).toBe(String(result.card?.gwsr));

    // directCapture was false, so nothing is captured yet — and CloseData arrives as
    // `{}`, which must normalize to an empty array rather than throwing.
    expect(detail.closedAmount).toBe(0);
    expect(detail.closeData).toEqual([]);
    // Pins the top-level position of CloseData against the real payload.
    expect(detail.raw).toHaveProperty("CloseData");
    expect(detail.raw.RtnValue).not.toHaveProperty("CloseData");
    // And that success really does carry neither RtnCode nor a message.
    expect(detail.raw).not.toHaveProperty("RtnCode");
    expect(detail.raw.RtnMsg).toBe("");
  });

  it("passing TradeNo alongside MerchantTradeNo is accepted", async () => {
    const { orderId, result } = await freshAuthorizedOrder();
    const detail = await queryEcpayCreditDetail(
      { ...ECPAY_SANDBOX_NO_3D },
      { merTradeNo: orderId, tradeNo: result.tradeNo },
    );
    expect(detail.tradeId).toBeTruthy();
  });

  it.each([
    ["an order that never existed", { merTradeNo: `CQMISS${Date.now().toString().slice(-8)}` }],
    // Recorded finding: a non-credit order and a wrong-merchant order are
    // indistinguishable from a genuine miss — all three answer 10000185.
    ["a non-credit (ATM 取號) order", { merTradeNo: "PCATM85542622715" }],
  ] as const)("reports %s as NOT_FOUND via RtnCode 10000185", async (_label, input) => {
    const err = await queryEcpayCreditDetail({ ...ECPAY_SANDBOX_NO_3D }, input).catch(
      (e: unknown) => e,
    );
    dump("CreditDetail miss", (err as PaymentError).toJSON?.() ?? err);

    expect(isPaymentError(err)).toBe(true);
    const pe = err as PaymentError;
    expect(pe.code).toBe("NOT_FOUND");
    expect(pe.rawCode).toBe("10000185");
  });

  it("QueryCardInfo resolves the issuer for the test card's BIN", async () => {
    const info = await queryEcpayCardInfo(
      { ...ECPAY_SANDBOX_GATEWAY },
      {
        cardNoPrefix: ECPAY_TEST_CARD.cardNo.slice(0, 9),
      },
    );
    dump("QueryCardInfo 9-digit", info.raw);

    expect(info.issuingBank).toBeTruthy();
    expect(info.issuingBankCode).toMatch(/^\d{3}$/);
    expect(Array.isArray(info.coBranding)).toBe(true);
  });

  it("a 6-digit BIN answers the issuer but loses the co-branding detail", async () => {
    // The padding surprise: the doc says pad to 9 with zeros, but digits 7-9 select a
    // co-branded product, so padding is not semantically neutral.
    const nine = await queryEcpayCardInfo(
      { ...ECPAY_SANDBOX_GATEWAY },
      {
        cardNoPrefix: ECPAY_TEST_CARD.cardNo.slice(0, 9),
      },
    );
    const six = await queryEcpayCardInfo(
      { ...ECPAY_SANDBOX_GATEWAY },
      {
        cardNoPrefix: ECPAY_TEST_CARD.cardNo.slice(0, 6),
      },
    );
    dump("QueryCardInfo 6-digit", six.raw);

    expect(six.issuingBank).toBe(nine.issuingBank);
    expect(six.coBranding.length).toBeLessThanOrEqual(nine.coBranding.length);
  });

  it("QueryCardInfo on a non-gateway merchant is UNSUPPORTED, not a payload error", async () => {
    // Keeps the capability boundary verified: no request tweak makes this work.
    const err = await queryEcpayCardInfo(
      { ...ECPAY_SANDBOX_NO_3D },
      {
        cardNoPrefix: "431195222",
      },
    ).catch((e: unknown) => e);
    dump("QueryCardInfo non-gateway", (err as PaymentError).toJSON?.() ?? err);

    expect(isPaymentError(err)).toBe(true);
    expect((err as PaymentError).code).toBe("UNSUPPORTED");
    expect((err as PaymentError).rawCode).toBe("5000095");
  });

  it("an unrecognised BIN is NOT_FOUND", async () => {
    const err = await queryEcpayCardInfo(
      { ...ECPAY_SANDBOX_GATEWAY },
      {
        cardNoPrefix: "999999",
      },
    ).catch((e: unknown) => e);
    expect(isPaymentError(err)).toBe(true);
    expect((err as PaymentError).code).toBe("NOT_FOUND");
  });

  it("rejects a full PAN before it reaches the network", async () => {
    await expect(
      queryEcpayCardInfo(
        { ...ECPAY_SANDBOX_GATEWAY },
        {
          cardNoPrefix: ECPAY_TEST_CARD.cardNo,
        },
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
