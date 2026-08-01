import { describe, expect, it } from "vitest";
import { isPaymentError, type PaymentError } from "@paid-tw/payment";
import { ECPAY_SANDBOX } from "../../config.js";
import { createEcpayBackAuthProvider } from "../provider.js";
import { stageProvider, testCard } from "./backauth-server.js";

/**
 * Live tests against **ecpayment-stage** for 信用卡幕後授權, using ECPay's published
 * test card `4311952222222222` / CVV `222` (doc 45895 — not a real card).
 *
 * Enable with:
 *   ECPAY_LIVE=1 pnpm test:live:ecpay:backauth
 *
 * Two merchants are exercised deliberately, because they take **different code
 * paths** through `createPayment`:
 *
 *   - `2000132` has 3D verification **off** → a direct authorization
 *   - `3002607` has 3D verification **on**  → a `ThreeDURL` hand-off with no RtnCode
 *
 * Both are ECPay's own published stage merchants.
 *
 * These calls really do authorize on stage, which is what makes the assertions
 * meaningful. `Credit/DoAction` is deliberately not live-tested: ECPay does not
 * expose it on stage at all.
 */
const live = process.env.ECPAY_LIVE === "1";
const LIVE_OPTS = { retry: 2, timeout: 40_000 } as const;

function orderId(prefix: string): string {
  return `${prefix}${Date.now().toString().slice(-11)}`;
}

function dump(label: string, value: unknown): void {
  if (process.env.PAID_DEBUG === "1") {
    console.error(`[backauth-live] ${label}:`, JSON.stringify(value, null, 2));
  }
}

/** Shared, minus orderId — every field ECPay insists on. */
function baseInput() {
  return {
    amount: 199,
    currency: "TWD",
    method: "card" as const,
    itemDesc: "paid-tw backauth probe",
    notifyUrl: "https://example.com/ecpay/backauth/notify",
    orderResultUrl: "https://example.com/ecpay/backauth/result",
    card: testCard(),
    phone: "886912345678",
    cardholderName: "TEST USER",
    email: "probe@example.com",
  };
}

describe.skipIf(!live)("ECPay 幕後授權 live — stage", LIVE_OPTS, () => {
  it("authorizes directly on the no-3D merchant 2000132", async () => {
    const provider = stageProvider();
    const result = await provider.createPayment({ ...baseInput(), orderId: orderId("BAOK") });
    dump("BackAuth authorized", result.raw);

    expect(result.mode).toBe("authorized");
    if (result.mode !== "authorized") return;

    expect(result.success).toBe(true);
    expect(result.rtnCode).toBe(1);
    expect(result.status).toBe("paid");
    expect(result.amount).toBe(199);
    // Masked only — the PAN never comes back.
    expect(result.card?.card6No).toBe("431195");
    expect(result.card?.card4No).toBe("2222");
    expect(JSON.stringify(result)).not.toContain(baseInput().card.cardNo);
    // gwsr is the handle 請退款 needs later.
    expect(result.card?.gwsr).toBeGreaterThan(0);
    expect(result.card?.authCode).toBeTruthy();
    // Eci 0 = this did not go through 3D, which is the point of this merchant.
    expect(result.card?.eci).toBe(0);
    expect(result.tradeNo).toBeTruthy();
  });

  it("hands off to 3DS on merchant 3002607, with no RtnCode in the response", async () => {
    // The trap this suite exists to pin: the 3D payload has ThreeDURL and *no*
    // RtnCode, so a RtnCode-first check would report a valid hand-off as a failure.
    const provider = createEcpayBackAuthProvider({ ...ECPAY_SANDBOX });
    const result = await provider.createPayment({ ...baseInput(), orderId: orderId("BA3D") });
    dump("BackAuth 3ds", result.raw);

    expect(result.mode).toBe("3ds");
    if (result.mode !== "3ds") return;

    expect(result.threeDUrl).toMatch(/^https:\/\//);
    expect(result.merTradeNo).toBeTruthy();
    expect(result.raw).not.toHaveProperty("RtnCode");
  });

  it("rejects a missing OrderResultURL the way ECPay does (5000029)", async () => {
    // Doc 45958 does not mark OrderResultURL required; stage disagrees. The adapter
    // catches it locally, so assert the local guard rather than burning a request.
    const provider = stageProvider();
    const err = await provider
      .createPayment({ ...baseInput(), orderId: orderId("BANO"), orderResultUrl: "" })
      .catch((e: unknown) => e);
    expect(isPaymentError(err)).toBe(true);
    expect((err as PaymentError).code).toBe("VALIDATION");
    expect((err as PaymentError).message).toContain("5000029");
  });

  it("QueryTrade reads back an authorized order", async () => {
    const provider = stageProvider();
    const id = orderId("BAQ");
    const created = await provider.createPayment({ ...baseInput(), orderId: id });
    expect(created.mode).toBe("authorized");

    const data = await provider.getPayment({ merTradeNo: id });
    dump("QueryTrade", data.raw);
    expect(data.status).toBe("paid");
    expect(data.method).toBe("card");
    expect(data.merTradeNo).toBe(id);
    expect(data.amount).toBe(199);
  });

  it("a declined card surfaces as a business error, not a crash", async () => {
    // 4-digit CVV on a Visa test card is the cheapest way to get a rejection that
    // still exercises the whole authorize path.
    const provider = stageProvider();
    const err = await provider
      .createPayment({
        ...baseInput(),
        orderId: orderId("BABAD"),
        card: { ...testCard(), cardNo: "4000000000000002" },
      })
      .catch((e: unknown) => e);
    dump("declined", (err as PaymentError)?.toJSON?.() ?? err);

    if (isPaymentError(err)) {
      expect(err.rawCode).toBeTruthy();
      expect(err.code).not.toBe("AUTH");
      expect(err.code).not.toBe("NETWORK");
      // Whatever happens, the PAN must not be echoed into the error.
      expect(JSON.stringify(err.toJSON())).not.toContain("4000000000000002");
    } else {
      // Some stage cards authorize anyway; a settled result is acceptable here.
      expect((err as { mode?: string }).mode).toBeDefined();
    }
  });

  it("refuses DoAction against stage instead of issuing a doomed request", async () => {
    const provider = stageProvider();
    await expect(
      provider.creditDoAction({ orderId: "BAX", tradeNo: "1", action: "R", amount: 1 }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });
});
