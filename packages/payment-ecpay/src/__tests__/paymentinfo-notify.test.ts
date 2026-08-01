import { describe, expect, it } from "vitest";
import type { PaymentError } from "@paid-tw/payment";
import { ECPAY_NOTIFY_ACK, verifyEcpayPaymentInfoNotify, verifyPaymentNotify } from "../notify.js";
import { computeCheckMacValue } from "../provider.js";
import { HASH_IV, HASH_KEY, MERCHANT } from "./ecpay-server.js";

/**
 * AIO 取號結果通知 (`PaymentInfoURL` / `ClientRedirectURL`).
 *
 * Same form-encoded + CheckMacValue transport as the payment-result notify, but the
 * success codes differ — `2` for ATM, `10100073` for CVS/BARCODE — which is exactly
 * why it needs its own verifier.
 *
 * Bodies are doc-derived from 2881, signed here with the real stage keys so the MAC
 * path is exercised for real. Recording one live needs a public tunnel plus a consumer
 * walking the cashier page to 取號, which cannot be scripted end to end.
 */
const credentials = { hashKey: HASH_KEY, hashIv: HASH_IV, merchantId: MERCHANT };

/** Build a signed body, the way ECPay would. */
function signed(fields: Record<string, string>): Record<string, string> {
  return { ...fields, CheckMacValue: computeCheckMacValue(fields, HASH_KEY, HASH_IV) };
}

const common = {
  MerchantID: MERCHANT,
  MerchantTradeNo: "AIOATM0001",
  StoreID: "",
  TradeNo: "2608012215090001",
  TradeAmt: "321",
  TradeDate: "2026/08/01 22:15:09",
  CustomField1: "c1",
  CustomField2: "",
  CustomField3: "",
  CustomField4: "",
};

const ATM = signed({
  ...common,
  RtnCode: "2",
  RtnMsg: "Get VirtualAccount Succeeded",
  PaymentType: "ATM_TAISHIN",
  BankCode: "812",
  vAccount: "9103522175887271",
  ExpireDate: "2026/08/08",
});

const CVS = signed({
  ...common,
  MerchantTradeNo: "AIOCVS0001",
  RtnCode: "10100073",
  RtnMsg: "Get Code Succeeded",
  PaymentType: "CVS_CVS",
  PaymentNo: "LLL26213917999",
  ExpireDate: "2026/08/08 22:15:09",
});

const BARCODE = signed({
  ...common,
  MerchantTradeNo: "AIOBAR0001",
  RtnCode: "10100073",
  RtnMsg: "Get Code Succeeded",
  PaymentType: "BARCODE_BARCODE",
  Barcode1: "1508086CY",
  Barcode2: "1557352207269145",
  Barcode3: "080829000000321",
  ExpireDate: "2026/08/08 23:59:59",
});

async function caught(fn: () => unknown): Promise<PaymentError> {
  try {
    fn();
  } catch (e) {
    return e as PaymentError;
  }
  throw new Error("expected a throw");
}

describe("verifyEcpayPaymentInfoNotify — success semantics", () => {
  it("treats ATM RtnCode 2 as a successful 取號", async () => {
    const result = verifyEcpayPaymentInfoNotify(ATM, credentials);

    expect(result.success).toBe(true);
    expect(result.rtnCode).toBe("2");
    expect(result.method).toBe("atm");
    expect(result.merTradeNo).toBe("AIOATM0001");
    expect(result.amount).toBe(321);
    expect(result.atm).toEqual({
      bankCode: "812",
      vAccount: "9103522175887271",
      expireDate: "2026/08/08",
    });
    expect(result.cvs).toBeUndefined();
    expect(result.barcode).toBeUndefined();
  });

  it("treats CVS/BARCODE RtnCode 10100073 as a successful 取號", async () => {
    const cvs = verifyEcpayPaymentInfoNotify(CVS, credentials);
    expect(cvs.success).toBe(true);
    expect(cvs.method).toBe("cvs");
    expect(cvs.cvs).toEqual({
      paymentNo: "LLL26213917999",
      expireDate: "2026/08/08 22:15:09",
    });
    expect(cvs.atm).toBeUndefined();

    const barcode = verifyEcpayPaymentInfoNotify(BARCODE, credentials);
    expect(barcode.success).toBe(true);
    expect(barcode.method).toBe("barcode");
    expect(barcode.barcode?.barcode2).toBe("1557352207269145");
    expect(barcode.cvs).toBeUndefined();
  });

  it("does NOT treat RtnCode 1 as a successful 取號", async () => {
    // 1 means "paid" on the result notify; it is not a 取號 success code. Accepting it
    // here would let a payment notify be mistaken for a code-issued event.
    const result = verifyEcpayPaymentInfoNotify(signed({ ...common, RtnCode: "1" }), credentials);
    expect(result.success).toBe(false);
    expect(result.rtnCode).toBe("1");
  });

  it("is why the payment-result verifier must not be used for this notify", async () => {
    // The trap, pinned: the same body reports success=false through verifyPaymentNotify
    // because that one checks RtnCode === "1".
    expect(verifyEcpayPaymentInfoNotify(ATM, credentials).success).toBe(true);
    expect(verifyPaymentNotify(ATM, credentials).success).toBe(false);
  });

  it("reports a failed 取號 as unsuccessful without throwing", async () => {
    // The merchant still has to answer 1|OK, so a business failure is not an exception.
    const result = verifyEcpayPaymentInfoNotify(
      signed({ ...common, RtnCode: "10100058", RtnMsg: "ATM 繳費期限已過" }),
      credentials,
    );
    expect(result.success).toBe(false);
    expect(result.rtnMsg).toBe("ATM 繳費期限已過");
    expect(ECPAY_NOTIFY_ACK).toBe("1|OK");
  });
});

describe("verifyEcpayPaymentInfoNotify — field handling", () => {
  it("does not invent an empty cvs/barcode object from the shared ExpireDate", async () => {
    // ExpireDate is common to all three families, so keying off it would make an ATM
    // notify report a phantom `cvs: { expireDate }`.
    const result = verifyEcpayPaymentInfoNotify(ATM, credentials);
    expect(result.cvs).toBeUndefined();
    expect(result.barcode).toBeUndefined();
    expect(result.atm?.expireDate).toBe("2026/08/08");
  });

  it("drops blank optional fields rather than surfacing empty strings", async () => {
    const result = verifyEcpayPaymentInfoNotify(ATM, credentials);
    expect(result.storeId).toBeUndefined();
    expect(result.customFields).toEqual(["c1", undefined, undefined, undefined]);
  });

  it("accepts a raw form string and URLSearchParams", async () => {
    const body = new URLSearchParams(ATM).toString();
    expect(verifyEcpayPaymentInfoNotify(body, credentials).success).toBe(true);
    expect(verifyEcpayPaymentInfoNotify(new URLSearchParams(ATM), credentials).merTradeNo).toBe(
      "AIOATM0001",
    );
  });
});

describe("verifyEcpayPaymentInfoNotify — authenticity", () => {
  it("rejects a tampered body", async () => {
    // Amount changed after signing — the MAC must catch it.
    const err = await caught(() =>
      verifyEcpayPaymentInfoNotify({ ...ATM, TradeAmt: "1" }, credentials),
    );
    expect(err.code).toBe("AUTH");
    expect(err.message).toMatch(/CheckMacValue 驗證失敗/);
  });

  it("rejects a body with no CheckMacValue", async () => {
    const { CheckMacValue: _drop, ...unsigned } = ATM;
    const err = await caught(() => verifyEcpayPaymentInfoNotify(unsigned, credentials));
    expect(err.code).toBe("AUTH");
    expect(err.message).toMatch(/缺少 CheckMacValue/);
  });

  it("rejects a notify for a different merchant", async () => {
    const other = signed({ ...common, MerchantID: "9999999", RtnCode: "2" });
    const err = await caught(() => verifyEcpayPaymentInfoNotify(other, credentials));
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toMatch(/MerchantID 不符/);
  });

  it("rejects a body missing the identity fields", async () => {
    const err = await caught(() =>
      verifyEcpayPaymentInfoNotify(signed({ RtnCode: "2" }), credentials),
    );
    expect(err.code).toBe("VALIDATION");
  });

  it("requires credentials", async () => {
    const err = await caught(() => verifyEcpayPaymentInfoNotify(ATM, { hashKey: "", hashIv: "" }));
    expect(err.code).toBe("AUTH");
    expect(err.message).toMatch(/憑證/);
  });

  it("accepts a lowercase CheckMacValue, as ECPay sometimes sends", async () => {
    const lower = { ...ATM, CheckMacValue: ATM.CheckMacValue.toLowerCase() };
    expect(verifyEcpayPaymentInfoNotify(lower, credentials).success).toBe(true);
  });
});

describe("PaymentType normalization", () => {
  it.each([
    ["ATM_TAISHIN", "atm"],
    ["CVS_CVS", "cvs"],
    ["BARCODE_BARCODE", "barcode"],
    ["Credit_CreditCard", "card"],
    ["WebATM_TAISHIN", "webatm"],
    ["ApplePay", "applepay"],
    ["TWQR_OPAY", "twqr"],
    ["BNPL_MFN", "bnpl"],
    ["", "unknown"],
    ["SomethingNew_X", "SomethingNew"],
  ] as const)("collapses %s to %s", (paymentType, expected) => {
    // The family prefix is what identifies the method; the suffix is the acquirer or
    // sub-method and varies. An unrecognised family passes through rather than becoming
    // "unknown", so a new ECPay method is still legible to the caller.
    const result = verifyEcpayPaymentInfoNotify(
      signed({ ...common, RtnCode: "2", PaymentType: paymentType }),
      credentials,
    );
    expect(result.method).toBe(expected);
  });
});
