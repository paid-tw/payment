import { describe, expect, it } from "vitest";
import { isPaymentError, type PaymentError } from "@paid-tw/payment";
import { ECPAY_ORIGINS, ECPAY_SANDBOX, ECPAY_SANDBOX_PORTAL } from "../config.js";
import { computeCheckMacValue } from "../provider.js";
import { stageProvider } from "./ecpay-server.js";

/**
 * Live tests against ECPay **payment-stage** using the public test merchant.
 *
 * Credentials (published by ECPay, not secrets):
 *   MerchantID  3002607
 *   HashKey     pwFHCqoQZGmho4w6
 *   HashIV      EkRm7iFT261dpevs
 *   後台        stagetest3 / test1234 @ vendor-stage.ecpay.com.tw
 *
 * Enable with:
 *   ECPAY_LIVE=1 pnpm test -- ecpay-live
 *
 * Optional:
 *   ECPAY_QUERY_ID=<MerchantTradeNo>   query a real stage order
 *   PAID_DEBUG=1                       print raw gateway payloads
 *
 * Offline counterpart: `ecpay.test.ts` (MSW + recorded fixtures, same keys).
 */
const live = process.env.ECPAY_LIVE === "1";
const LIVE_OPTS = { retry: 2, timeout: 30_000 } as const;

describe.skipIf(!live)("ECPay live — public stage merchant 3002607", LIVE_OPTS, () => {
  const provider = stageProvider();

  it("uses the published sandbox credentials by default", () => {
    expect(ECPAY_SANDBOX.merchantId).toBe("3002607");
    expect(ECPAY_SANDBOX.hashKey).toBe("pwFHCqoQZGmho4w6");
    expect(ECPAY_SANDBOX.hashIv).toBe("EkRm7iFT261dpevs");
    expect(ECPAY_SANDBOX_PORTAL.username).toBe("stagetest3");
    expect(ECPAY_ORIGINS.sandbox).toBe("https://payment-stage.ecpay.com.tw");
  });

  it("createPayment builds a stage AioCheckOut form with a valid CheckMacValue", async () => {
    const orderId = `LV${Date.now().toString().slice(-12)}`;
    const form = await provider.createPayment({
      amount: 100,
      currency: "TWD",
      method: "card",
      orderId,
      itemDesc: "paid-tw live probe",
      notifyUrl: "https://example.com/ecpay/notify",
      returnUrl: "https://example.com/ecpay/return",
    });

    expect(form.mode).toBe("redirect");
    expect(form.action).toBe(`${ECPAY_ORIGINS.sandbox}/Cashier/AioCheckOut/V5`);
    expect(form.method).toBe("POST");
    expect(form.params.MerchantID).toBe(ECPAY_SANDBOX.merchantId);
    expect(form.params.MerchantTradeNo).toBe(orderId);
    expect(form.params.TotalAmount).toBe("100");
    expect(form.params.ChoosePayment).toBe("Credit");
    expect(form.params.EncryptType).toBe("1");
    expect(form.params.ReturnURL).toBe("https://example.com/ecpay/notify");

    // Independent re-sign: proves HashKey/HashIV match ECPay's stage pair.
    const expected = computeCheckMacValue(form.params, ECPAY_SANDBOX.hashKey, ECPAY_SANDBOX.hashIv);
    expect(form.params.CheckMacValue).toBe(expected);

    if (process.env.PAID_DEBUG === "1") {
      console.error("[ecpay-live] AioCheckOut form:", JSON.stringify(form, null, 2));
    }
  });

  it("a passthrough order is really created, and the extra fields reach ECPay", async () => {
    // A locally-valid MAC proves nothing about acceptance, so this posts the form to the
    // real cashier and then queries the order back. The echoed StoreID/CustomField1 are
    // the evidence that the typed fields and the params escape hatch actually landed.
    const orderId = `AIOX${Date.now().toString().slice(-11)}`;
    const form = await provider.createPayment({
      amount: 321,
      currency: "TWD",
      method: "atm",
      orderId,
      itemDesc: "paid-tw passthrough probe",
      notifyUrl: "https://example.com/ecpay/notify",
      paymentInfoUrl: "https://example.com/ecpay/paid-info",
      clientRedirectUrl: "https://example.com/ecpay/code",
      storeId: "S1",
      customField1: "c1",
      params: { ExpireDate: 7 },
    });

    expect(form.params.PaymentInfoURL).toBe("https://example.com/ecpay/paid-info");
    expect(form.params.ExpireDate).toBe("7");
    // Independently re-sign: the MAC must cover the passthrough.
    const { CheckMacValue: signature, ...signedFields } = form.params;
    expect(signature).toBe(
      computeCheckMacValue(signedFields, ECPAY_SANDBOX.hashKey, ECPAY_SANDBOX.hashIv),
    );

    const response = await fetch(form.action, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form.params).toString(),
      redirect: "manual",
    });
    expect(response.status).toBeLessThan(500);

    const data = await provider.getPayment({ merTradeNo: orderId });
    if (process.env.PAID_DEBUG === "1") {
      console.error("[ecpay-live] passthrough order:", JSON.stringify(data.raw, null, 2));
    }
    expect(data.status).toBe("unpaid");
    expect(data.amount).toBe(321);
    const raw = data.raw as Record<string, string>;
    expect(raw.StoreID).toBe("S1");
    expect(raw.CustomField1).toBe("c1");
  });

  it("refuses to override a signed field through params, before any network call", async () => {
    for (const key of ["MerchantID", "TotalAmount", "CheckMacValue"]) {
      await expect(
        provider.createPayment({
          amount: 100,
          currency: "TWD",
          method: "atm",
          orderId: "AIOGUARD01",
          notifyUrl: "https://example.com/ecpay/notify",
          params: { [key]: "evil" },
        }),
      ).rejects.toMatchObject({ code: "VALIDATION" });
    }
  });

  it("getPayment for a non-existent order → NOT_FOUND (10200047) with verified MAC", async () => {
    // Stage always returns a full field set + CheckMacValue even for misses.
    const id = process.env.ECPAY_QUERY_ID ?? `probe${Date.now().toString().slice(-10)}`;
    try {
      const data = await provider.getPayment({ merTradeNo: id });
      // ECPAY_QUERY_ID may point at a real paid/unpaid stage order.
      expect(typeof data.status).toBe("string");
      if (process.env.PAID_DEBUG === "1") {
        console.error("[ecpay-live] getPayment ok:", JSON.stringify(data, null, 2));
      }
    } catch (err) {
      expect(isPaymentError(err)).toBe(true);
      const pe = err as PaymentError;
      expect(pe.rawCode).toBeTruthy();
      // Default probe ids that never existed map to 查無交易資料.
      if (!process.env.ECPAY_QUERY_ID) {
        expect(pe.code).toBe("NOT_FOUND");
        expect(pe.rawCode).toBe("10200047");
      }
      if (process.env.PAID_DEBUG === "1") {
        console.error("[ecpay-live] getPayment error:", pe.toJSON?.() ?? pe);
      }
    }
  });

  it("getPayment signs the request so stage accepts CheckMacValue (AUTH not thrown)", async () => {
    // A wrong hash would typically fail signature checks; with sandbox keys we
    // must get either normalized data or a business-level PaymentError, never AUTH
    // from missing/mismatched local credentials.
    const id = `mac${Date.now().toString().slice(-12)}`;
    try {
      await provider.getPayment({ merTradeNo: id });
    } catch (err) {
      expect(isPaymentError(err)).toBe(true);
      expect((err as PaymentError).code).not.toBe("AUTH");
      expect((err as PaymentError).code).not.toBe("NETWORK");
    }
  });
});
