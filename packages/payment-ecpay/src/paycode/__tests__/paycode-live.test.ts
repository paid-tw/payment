import { describe, expect, it } from "vitest";
import { isPaymentError, type PaymentError } from "@paid-tw/payment";
import { ECPAY_SANDBOX } from "../../config.js";
import { ECPAY_PAYCODE_ORIGINS } from "../config.js";
import { stageProvider } from "./paycode-server.js";

/**
 * Live tests against **ecpayment-stage** (非信用卡幕後取號) using ECPay's public test
 * merchant — the same MerchantID/HashKey/HashIV as the AIO and ECPG live tests
 * (see {@link ECPAY_SANDBOX}; published by ECPay, not secrets).
 *
 * Enable with:
 *   ECPAY_LIVE=1 pnpm test:live:ecpay:paycode
 *
 * Optional:
 *   ECPAY_PAYCODE_QUERY_ID=<MerchantTradeNo>   query a known stage order
 *   PAID_DEBUG=1                               print raw gateway payloads
 *
 * `PAID_DEBUG=1` is how `paycode-fixtures.ts` was recorded: these tests print the
 * decrypted `Data` of every response, which is then pasted into the fixtures file
 * and replayed offline by `paycode.test.ts` through MSW.
 *
 * Note 取號 is a real (unpaid) stage order per run — harmless, but it does leave
 * rows in the stage 廠商後台.
 */
const live = process.env.ECPAY_LIVE === "1";
const LIVE_OPTS = { retry: 2, timeout: 30_000 } as const;

/** MerchantTradeNo must be ≤20 alphanumerics; keep a per-method prefix. */
function orderId(prefix: string): string {
  return `${prefix}${Date.now().toString().slice(-11)}`;
}

function dump(label: string, value: unknown): void {
  if (process.env.PAID_DEBUG === "1") {
    console.error(`[paycode-live] ${label}:`, JSON.stringify(value, null, 2));
  }
}

describe.skipIf(!live)("ECPay 幕後取號 live — stage merchant 3002607", LIVE_OPTS, () => {
  const provider = stageProvider();

  it("targets the ecpayment stage host (not payment-stage / ecpg-stage)", () => {
    expect(ECPAY_PAYCODE_ORIGINS.sandbox).toBe("https://ecpayment-stage.ecpay.com.tw");
    expect(provider.name).toBe("ecpay-paycode");
  });

  it("ATM 取號 returns a virtual account with no consumer redirect", async () => {
    const result = await provider.createPayment({
      amount: 123,
      currency: "TWD",
      method: "atm",
      orderId: orderId("PCATM"),
      itemDesc: "paid-tw paycode probe",
      notifyUrl: "https://example.com/ecpay/paycode/notify",
      expireDate: 3,
      atmBankCode: "822",
      customField: "paid-tw-live",
    });
    dump("GenPaymentCode ATM", result.raw);

    expect(result.mode).toBe("paycode");
    expect(result.method).toBe("atm");
    expect(result.status).toBe("unpaid");
    expect(result.atm?.vAccount).toMatch(/^\d{14,16}$/);
    expect(result.atm?.bankCode).toMatch(/^\d{3}$/);
    expect(result.atm?.expireDate).toMatch(/^\d{4}\/\d{2}\/\d{2}$/);
    expect(result.tradeNo).toBeTruthy();
    expect(result.amount).toBe(123);
  });

  it("CVS 取號 returns a 繳費代碼 plus a mobile barcode page", async () => {
    const result = await provider.createPayment({
      amount: 456,
      currency: "TWD",
      method: "cvs",
      orderId: orderId("PCCVS"),
      itemDesc: "paid-tw paycode probe",
      notifyUrl: "https://example.com/ecpay/paycode/notify",
      expireDate: 6000,
      cvsChain: "CVS",
      cvsDescriptions: ["paid-tw", "live probe"],
    });
    dump("GenPaymentCode CVS", result.raw);

    expect(result.method).toBe("cvs");
    expect(result.cvs?.paymentNo).toBeTruthy();
    expect(result.cvs?.expireDate).toMatch(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(result.cvs?.paymentUrl).toMatch(/^https:\/\//);
  });

  it("BARCODE 取號 returns three code39 segments", async () => {
    const result = await provider.createPayment({
      amount: 789,
      currency: "TWD",
      method: "barcode",
      orderId: orderId("PCBAR"),
      itemDesc: "paid-tw paycode probe",
      notifyUrl: "https://example.com/ecpay/paycode/notify",
      expireDate: 7,
    });
    dump("GenPaymentCode BARCODE", result.raw);

    expect(result.method).toBe("barcode");
    expect(result.barcode?.barcode1).toBeTruthy();
    expect(result.barcode?.barcode2).toBeTruthy();
    expect(result.barcode?.barcode3).toBeTruthy();
    expect(result.barcode?.expireDate).toMatch(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("QueryTrade + QueryPaymentInfo read back a just-created order", async () => {
    const id = orderId("PCQRY");
    const created = await provider.createPayment({
      amount: 100,
      currency: "TWD",
      method: "atm",
      orderId: id,
      itemDesc: "paid-tw paycode probe",
      notifyUrl: "https://example.com/ecpay/paycode/notify",
    });

    const trade = await provider.getPayment({ merTradeNo: id });
    dump("QueryTrade", trade.raw);
    expect(trade.status).toBe("unpaid");
    expect(trade.method).toBe("atm");
    expect(trade.merTradeNo).toBe(id);
    expect(trade.tradeNo).toBe(created.tradeNo);

    const info = await provider.getPaymentCode({ merTradeNo: id });
    dump("QueryPaymentInfo", info.raw);
    expect(info.atm?.vAccount).toBe(created.atm?.vAccount);
  });

  it("a duplicate MerchantTradeNo is rejected, not silently re-numbered", async () => {
    const id = orderId("PCDUP");
    const args = {
      amount: 100,
      currency: "TWD",
      method: "atm" as const,
      orderId: id,
      itemDesc: "paid-tw paycode probe",
      notifyUrl: "https://example.com/ecpay/paycode/notify",
    };
    await provider.createPayment(args);

    const err = await provider.createPayment(args).catch((e: unknown) => e);
    dump("duplicate order error", (err as PaymentError)?.toJSON?.() ?? err);
    expect(isPaymentError(err)).toBe(true);
    expect((err as PaymentError).rawCode).toBeTruthy();
    expect((err as PaymentError).code).not.toBe("AUTH");
    expect((err as PaymentError).code).not.toBe("NETWORK");
  });

  it("querying an order that never existed surfaces a business error, not AUTH", async () => {
    const id = process.env.ECPAY_PAYCODE_QUERY_ID ?? orderId("PCMISS");
    try {
      const data = await provider.getPayment({ merTradeNo: id });
      dump("QueryTrade (known id)", data.raw);
      expect(typeof data.status).toBe("string");
    } catch (err) {
      dump("QueryTrade miss error", (err as PaymentError).toJSON?.() ?? err);
      expect(isPaymentError(err)).toBe(true);
      const pe = err as PaymentError;
      expect(pe.rawCode).toBeTruthy();
      // A wrong HashKey/HashIV would fail at the envelope (TransCode) instead.
      expect(pe.code).not.toBe("AUTH");
      expect(pe.code).not.toBe("NETWORK");
    }
  });

  it("refund is refused locally — ECPay has no refund API for these methods", async () => {
    await expect(provider.refundPayment({ orderId: "PCNOOP" })).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  });
});
