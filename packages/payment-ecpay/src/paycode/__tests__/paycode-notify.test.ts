import { describe, expect, it } from "vitest";
import type { PaymentError } from "@paid-tw/payment";
import { encryptData } from "../../ecpg/aes.js";
import { ECPAY_PAYCODE_NOTIFY_ACK, verifyEcpayPayCodeNotify } from "../notify.js";
import { HASH_IV, HASH_KEY, MERCHANT, testProvider } from "./paycode-server.js";

/**
 * ReturnURL notify coverage.
 *
 * Unlike the 取號 fixtures these payloads are **doc-derived, not recorded**: ECPay
 * only emits a 幕後取號 notify after a real convenience-store/ATM payment or a manual
 * click in 廠商後台 → 一般訂單查詢 → 模擬付款, which needs a publicly reachable
 * ReturnURL. The ATM shape below is verbatim from the official 28010 sample; the
 * CVS/BARCODE ones extend it with the fields that page documents.
 *
 * To record for real: expose a tunnel, point `notifyUrl` at it, 取號, then hit
 * 模擬付款 for that order on vendor-stage.ecpay.com.tw (stagetest3 / test1234).
 */
const credentials = { hashKey: HASH_KEY, hashIv: HASH_IV, merchantId: MERCHANT };

function notify(data: Record<string, unknown>, transCode: number | string = 1) {
  return {
    MerchantID: MERCHANT,
    RpHeader: { Timestamp: 1_754_000_000 },
    TransCode: transCode,
    TransMsg: "Success!",
    Data: encryptData(data, HASH_KEY, HASH_IV),
  };
}

/** Verbatim from https://developers.ecpay.com.tw/28010 (ATM), amounts filled in. */
const ATM_PAID = {
  RtnCode: 1,
  RtnMsg: "Success",
  MerchantID: MERCHANT,
  OrderInfo: {
    MerchantTradeNo: "PCQRY85542626369",
    TradeNo: "2608010803460239",
    TradeAmt: 100,
    TradeDate: "2026/08/01 08:03:46",
    PaymentType: "ATM",
    PaymentDate: "2026/08/02 09:15:20",
    ChargeFee: 1,
    TradeStatus: "1",
  },
  ATMInfo: { ATMAccBank: "822", ATMAccNo: "12345" },
} as const;

const CVS_PAID = {
  RtnCode: 1,
  RtnMsg: "Success",
  MerchantID: MERCHANT,
  OrderInfo: {
    MerchantTradeNo: "PCCVS85542623066",
    TradeNo: "2608010803430237",
    TradeAmt: 456,
    TradeDate: "2026/08/01 08:03:43",
    PaymentType: "CVS",
    PaymentDate: "2026/08/02 11:30:00",
    ChargeFee: 26,
    TradeStatus: "1",
  },
  CVSInfo: {
    PayFrom: "family",
    PaymentNo: "LLL26213917389",
    PaymentURL:
      "https://payment-stage.ecpay.com.tw/PaymentRule/CVSBarCode?PaymentNo=LLL26213917389",
    PayStoreID: "166843",
    PayStoreName: "板橋德民店",
  },
  CustomField: "paid-tw-live",
} as const;

const BARCODE_PAID = {
  RtnCode: 1,
  RtnMsg: "Success",
  MerchantID: MERCHANT,
  OrderInfo: {
    MerchantTradeNo: "PCBAR85542625818",
    TradeNo: "2608010803460238",
    TradeAmt: 789,
    TradeDate: "2026/08/01 08:03:46",
    PaymentType: "BARCODE",
    PaymentDate: "2026/08/03 20:00:00",
    ChargeFee: 15,
    TradeStatus: "1",
  },
  BarcodeInfo: { PayFrom: "ibon" },
} as const;

describe("ECPAY_PAYCODE_NOTIFY_ACK", () => {
  it("is the bare AIO string even though the notify is AES-JSON", () => {
    expect(ECPAY_PAYCODE_NOTIFY_ACK).toBe("1|OK");
  });
});

describe("verifyEcpayPayCodeNotify", () => {
  it("verifies a paid ATM notify and exposes the payer's account digits", () => {
    const result = verifyEcpayPayCodeNotify(notify(ATM_PAID), credentials);

    expect(result.success).toBe(true);
    expect(result.simulated).toBe(false);
    expect(result.method).toBe("atm");
    expect(result.tradeStatus).toBe("1");
    expect(result.merTradeNo).toBe("PCQRY85542626369");
    expect(result.amount).toBe(100);
    expect(result.paidAt).toBe("2026/08/02 09:15:20");
    // Only returned for banks 007/822/118/013 — the reconciliation hook.
    expect(result.atm).toEqual({ bankCode: "822", accountNo: "12345" });
  });

  it("verifies a paid CVS notify and exposes the paying store", () => {
    const result = verifyEcpayPayCodeNotify(notify(CVS_PAID), credentials);

    expect(result.success).toBe(true);
    expect(result.method).toBe("cvs");
    expect(result.cvs).toMatchObject({
      payFrom: "family",
      paymentNo: "LLL26213917389",
      payStoreId: "166843",
      payStoreName: "板橋德民店",
    });
  });

  it("verifies a paid BARCODE notify (PayFrom only — segments came back at 取號)", () => {
    const result = verifyEcpayPayCodeNotify(notify(BARCODE_PAID), credentials);

    expect(result.success).toBe(true);
    expect(result.method).toBe("barcode");
    expect(result.barcode).toEqual({ payFrom: "ibon" });
    expect(result.cvs).toBeUndefined();
  });

  it("accepts a JSON string body (raw request text)", () => {
    const result = verifyEcpayPayCodeNotify(JSON.stringify(notify(ATM_PAID)), credentials);
    expect(result.merTradeNo).toBe("PCQRY85542626369");
  });

  it("flags SimulatePaid so callers do not ship on a 模擬付款", () => {
    const result = verifyEcpayPayCodeNotify(notify({ ...ATM_PAID, SimulatePaid: 1 }), credentials);
    expect(result.success).toBe(true);
    expect(result.simulated).toBe(true);
  });

  it("reports RtnCode != 1 as not-success rather than throwing", () => {
    // ECPay is explicit that a non-1 RtnCode must not trigger fulfilment, but the
    // merchant still has to answer 1|OK, so this must not be an exception.
    const result = verifyEcpayPayCodeNotify(
      notify({ ...ATM_PAID, RtnCode: 10_100_058, RtnMsg: "ATM 繳費期限已過" }),
      credentials,
    );
    expect(result.success).toBe(false);
    expect(result.rtnCode).toBe(10_100_058);
    expect(result.rtnMsg).toBe("ATM 繳費期限已過");
  });

  it("rejects a tampered envelope (TransCode != 1)", () => {
    const err = (() => {
      try {
        verifyEcpayPayCodeNotify(notify(ATM_PAID, 0), credentials);
      } catch (e) {
        return e as PaymentError;
      }
    })();
    expect(err?.code).toBe("PROVIDER");
    expect(err?.provider).toBe("ecpay-paycode");
  });

  it("rejects Data encrypted with someone else's keys", () => {
    const foreign = {
      MerchantID: MERCHANT,
      TransCode: 1,
      Data: encryptData(ATM_PAID, "0123456789abcdef", "abcdef0123456789"),
    };
    expect(() => verifyEcpayPayCodeNotify(foreign, credentials)).toThrowError(/解密失敗/);
  });

  it("rejects a notify for a different merchant", () => {
    expect(() =>
      verifyEcpayPayCodeNotify(notify({ ...ATM_PAID, MerchantID: "9999999" }), credentials),
    ).toThrowError(/MerchantID 不符/);
  });

  it("rejects a body that is not JSON", () => {
    expect(() => verifyEcpayPayCodeNotify("<html>oops</html>", credentials)).toThrowError(
      /不是合法 JSON/,
    );
  });

  it("rejects an envelope with no Data at all", () => {
    expect(() =>
      verifyEcpayPayCodeNotify({ MerchantID: MERCHANT, TransCode: 1 }, credentials),
    ).toThrowError(/缺少 Data/);
  });

  it("requires credentials", () => {
    expect(() =>
      verifyEcpayPayCodeNotify(notify(ATM_PAID), { hashKey: "", hashIv: "" }),
    ).toThrowError(/憑證/);
  });

  it("is reachable from the provider with the configured credentials", () => {
    const result = testProvider().verifyPaymentNotify(notify(ATM_PAID));
    expect(result.success).toBe(true);
    expect(result.merchantId).toBe(MERCHANT);
  });
});
