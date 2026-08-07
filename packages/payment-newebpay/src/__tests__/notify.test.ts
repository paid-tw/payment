import { describe, expect, it } from "vitest";
import { isPaymentError, PaymentError } from "@paid-tw/payment";
import { encryptTradeInfo, tradeSha } from "../crypto.js";
import {
  verifyNewebpayGetCodeNotify,
  verifyNewebpayPaymentNotify,
  type NewebpayNotifyCredentials,
} from "../notify.js";
import { KEY, IV, MERCHANT, notifyEnvelope, testProvider } from "./server.js";
import {
  GETCODE_VACC_JSON,
  MANUAL_NOTIFY_TRADEINFO,
  MANUAL_NOTIFY_TRADESHA,
  NOTIFY_BARCODE_PAID_JSON,
  NOTIFY_CREDIT_DECLINED_JSON,
  NOTIFY_CREDIT_PAID_JSON,
  NOTIFY_CVS_PAID_JSON,
  NOTIFY_VACC_PAID_JSON,
} from "./fixtures.js";

const CREDENTIALS: NewebpayNotifyCredentials = {
  hashKey: KEY,
  hashIv: IV,
  merchantId: MERCHANT,
};

describe("verifyNewebpayPaymentNotify — manual's gateway-produced envelope", () => {
  // TradeInfo + TradeSha verbatim from NDNF-1.2.3 pp.23/25: real gateway output,
  // RespondType=String, so this exercises sha-verify → decrypt → flat parse.
  const envelope = {
    Status: "SUCCESS",
    MerchantID: MERCHANT,
    Version: "2.0",
    TradeInfo: MANUAL_NOTIFY_TRADEINFO,
    TradeSha: MANUAL_NOTIFY_TRADESHA,
  };

  it("verifies and normalizes the paid credit-card notify", () => {
    const notify = verifyNewebpayPaymentNotify(envelope, CREDENTIALS);

    expect(notify.success).toBe(true);
    expect(notify.status).toBe("SUCCESS");
    expect(notify.message).toBe("授權成功");
    expect(notify.merchantId).toBe(MERCHANT);
    expect(notify.merTradeNo).toBe("Vanespl_ec_1695795668");
    expect(notify.tradeNo).toBe("23092714215835071");
    expect(notify.amount).toBe(30);
    expect(notify.method).toBe("card");
    expect(notify.paidAt).toBe("2023-09-27 14:21:59");
    expect(notify.ip).toBe("123.51.237.115");
    expect(notify.escrowBank).toBe("HNCB");
    expect(notify.card).toMatchObject({
      card6No: "400022",
      card4No: "1111",
      authCode: "115468",
      authBank: "KGI",
      respondCode: "00",
      paymentMethod: "CREDIT",
    });
    // Undocumented gateway fields stay reachable through raw.
    expect(notify.raw.decrypted.Exp).toBe("2609");
  });

  it("accepts the same body as a raw string and as URLSearchParams", () => {
    const asParams = new URLSearchParams(envelope);
    expect(verifyNewebpayPaymentNotify(asParams, CREDENTIALS).success).toBe(true);
    expect(verifyNewebpayPaymentNotify(asParams.toString(), CREDENTIALS).success).toBe(true);
  });
});

describe("verifyNewebpayPaymentNotify — JSON RespondType and failures", () => {
  it("parses a JSON-RespondType paid notify", () => {
    const notify = verifyNewebpayPaymentNotify(
      notifyEnvelope(NOTIFY_CREDIT_PAID_JSON),
      CREDENTIALS,
    );
    expect(notify.success).toBe(true);
    expect(notify.method).toBe("card");
    expect(notify.amount).toBe(30);
    expect(notify.card?.authBank).toBe("KGI");
  });

  it("reports a declined card as success:false with the MPG code preserved", () => {
    const notify = verifyNewebpayPaymentNotify(
      notifyEnvelope(NOTIFY_CREDIT_DECLINED_JSON, { Status: "MPG03009" }),
      CREDENTIALS,
    );
    expect(notify.success).toBe(false);
    expect(notify.status).toBe("MPG03009");
    expect(notify.merTradeNo).toBe("order_declined_001");
    expect(notify.paidAt).toBeUndefined();
  });

  it("surfaces paid-CVS extras (CodeNo / store)", () => {
    const notify = verifyNewebpayPaymentNotify(notifyEnvelope(NOTIFY_CVS_PAID_JSON), CREDENTIALS);
    expect(notify.method).toBe("cvs");
    expect(notify.cvs).toMatchObject({ codeNo: "GW26080100001234", storeId: "990088" });
  });

  it("surfaces paid-VACC extras (payer bank/account) — the ATM completion event", () => {
    const notify = verifyNewebpayPaymentNotify(notifyEnvelope(NOTIFY_VACC_PAID_JSON), CREDENTIALS);
    expect(notify.success).toBe(true);
    expect(notify.method).toBe("atm");
    expect(notify.paidAt).toBe("2026-08-02 10:15:00");
    expect(notify.atm).toMatchObject({ payBankCode: "012", payerAccount5Code: "12345" });
    expect(notify.card).toBeUndefined();
  });

  it("surfaces paid-barcode extras (three segments + paying chain)", () => {
    const notify = verifyNewebpayPaymentNotify(
      notifyEnvelope(NOTIFY_BARCODE_PAID_JSON),
      CREDENTIALS,
    );
    expect(notify.method).toBe("barcode");
    expect(notify.barcode).toMatchObject({
      barcode1: "150808A3",
      barcode2: "3453011122223333",
      barcode3: "060517000000700",
      payStore: "SEVEN",
    });
  });

  it("a get-code SUCCESS envelope through the PAYMENT verifier has no paidAt", () => {
    // 取號完成 ≠ paid: same envelope, but the get-code payload has
    // ExpireDate/ExpireTime and no PayTime — paidAt undefined is the only
    // field-level distinction, so pin it.
    const notify = verifyNewebpayPaymentNotify(notifyEnvelope(GETCODE_VACC_JSON), CREDENTIALS);
    expect(notify.success).toBe(true);
    expect(notify.method).toBe("atm");
    expect(notify.paidAt).toBeUndefined();
  });

  it("accepts a JSON payload whose Result is a one-element array", () => {
    const payload = JSON.parse(NOTIFY_CREDIT_PAID_JSON) as { Result: unknown };
    const wrapped = JSON.stringify({ ...payload, Result: [payload.Result] });
    const notify = verifyNewebpayPaymentNotify(notifyEnvelope(wrapped), CREDENTIALS);
    expect(notify.success).toBe(true);
    expect(notify.merTradeNo).toBe("Vanespl_ec_1695795668");
  });

  it("rejects a tampered TradeSha with AUTH before decrypting", () => {
    const envelope = notifyEnvelope(NOTIFY_CREDIT_PAID_JSON, { TradeSha: "0".repeat(64) });
    const err = capture(() => verifyNewebpayPaymentNotify(envelope, CREDENTIALS));
    expect(err.code).toBe("AUTH");
    expect(err.message).toContain("TradeSha");
  });

  it("rejects a missing TradeSha / TradeInfo with AUTH", () => {
    const { TradeSha: _dropped, ...withoutSha } = notifyEnvelope(NOTIFY_CREDIT_PAID_JSON);
    expect(capture(() => verifyNewebpayPaymentNotify(withoutSha, CREDENTIALS)).code).toBe("AUTH");
  });

  it("rejects a ciphertext from another shop's keys with AUTH (sha ok, decrypt fails)", () => {
    // Sign the foreign ciphertext with OUR key so TradeSha passes and the
    // failure has to come from decryption — the deeper of the two defenses.
    const foreignHex = encryptTradeInfo(NOTIFY_CREDIT_PAID_JSON, "X".repeat(32), "Y".repeat(16));
    const envelope = {
      Status: "SUCCESS",
      MerchantID: MERCHANT,
      Version: "2.0",
      TradeInfo: foreignHex,
      TradeSha: tradeSha(foreignHex, KEY, IV),
    };
    const err = capture(() => verifyNewebpayPaymentNotify(envelope, CREDENTIALS));
    expect(err.code).toBe("AUTH");
    expect(err.message).toContain("解密");
  });

  it("rejects a MerchantID mismatch with VALIDATION", () => {
    const err = capture(() =>
      verifyNewebpayPaymentNotify(notifyEnvelope(NOTIFY_CREDIT_PAID_JSON), {
        ...CREDENTIALS,
        merchantId: "MS999999999",
      }),
    );
    expect(err.code).toBe("VALIDATION");
  });

  it("rejects EncryptType=1 (AES-GCM) as UNSUPPORTED", () => {
    const err = capture(() =>
      verifyNewebpayPaymentNotify(
        notifyEnvelope(NOTIFY_CREDIT_PAID_JSON, { EncryptType: "1" }),
        CREDENTIALS,
      ),
    );
    expect(err.code).toBe("UNSUPPORTED");
  });

  it("rejects missing HashKey/HashIV with AUTH before touching the body", () => {
    const err = capture(() =>
      verifyNewebpayPaymentNotify(notifyEnvelope(NOTIFY_CREDIT_PAID_JSON), {
        hashKey: "",
        hashIv: "",
      }),
    );
    expect(err.code).toBe("AUTH");
  });

  it("rejects a payload without MerchantOrderNo with VALIDATION", () => {
    const payload = JSON.parse(NOTIFY_CREDIT_PAID_JSON) as {
      Result: Record<string, unknown>;
    };
    delete payload.Result.MerchantOrderNo;
    const err = capture(() =>
      verifyNewebpayPaymentNotify(notifyEnvelope(JSON.stringify(payload)), CREDENTIALS),
    );
    expect(err.code).toBe("VALIDATION");
  });

  it("falls back to the envelope MerchantID when the decrypted Result omits it", () => {
    const payload = JSON.parse(NOTIFY_CREDIT_PAID_JSON) as {
      Result: Record<string, unknown>;
    };
    delete payload.Result.MerchantID;
    const notify = verifyNewebpayPaymentNotify(
      notifyEnvelope(JSON.stringify(payload)),
      CREDENTIALS,
    );
    expect(notify.merchantId).toBe(MERCHANT);
  });
});

describe("verifyNewebpayGetCodeNotify — 取號完成 (CustomerURL)", () => {
  it("normalizes an ATM virtual-account issuance", () => {
    const notify = verifyNewebpayGetCodeNotify(notifyEnvelope(GETCODE_VACC_JSON), CREDENTIALS);
    expect(notify.success).toBe(true);
    expect(notify.method).toBe("atm");
    expect(notify.merTradeNo).toBe("order_atm_001");
    expect(notify.amount).toBe(1200);
    expect(notify.expireDate).toBe("2026-08-08");
    expect(notify.expireTime).toBe("235959");
    expect(notify.atm).toMatchObject({ bankCode: "031", codeNo: "1234567890123" });
    expect(notify.cvs).toBeUndefined();
  });

  it("shares the authenticity check with the payment verifier", () => {
    const envelope = notifyEnvelope(GETCODE_VACC_JSON, { TradeSha: "0".repeat(64) });
    expect(capture(() => verifyNewebpayGetCodeNotify(envelope, CREDENTIALS)).code).toBe("AUTH");
  });
});

describe("provider notify methods", () => {
  it("verifyPaymentNotify / verifyGetCodeNotify use the instance credentials", () => {
    const provider = testProvider();
    expect(
      provider.verifyPaymentNotify({
        Status: "SUCCESS",
        MerchantID: MERCHANT,
        Version: "2.0",
        TradeInfo: MANUAL_NOTIFY_TRADEINFO,
        TradeSha: MANUAL_NOTIFY_TRADESHA,
      }).success,
    ).toBe(true);
    expect(provider.verifyGetCodeNotify(notifyEnvelope(GETCODE_VACC_JSON)).atm?.codeNo).toBe(
      "1234567890123",
    );
  });
});

function capture(fn: () => unknown): PaymentError {
  try {
    fn();
  } catch (err) {
    expect(isPaymentError(err)).toBe(true);
    return err as PaymentError;
  }
  throw new Error("expected the verifier to throw");
}
