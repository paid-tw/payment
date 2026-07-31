import { describe, expect, it } from "vitest";
import { PaymentError } from "@paid-tw/payment";
import { ECPAY_SANDBOX } from "../config.js";
import {
  ECPAY_NOTIFY_ACK,
  coerceNotifyBody,
  verifyPaymentNotify,
} from "../notify.js";
import { computeCheckMacValue, createEcpayProvider } from "../provider.js";

/** Official PHP SDK sample (GetCheckoutResponse.php) — CheckMacValue verified offline. */
const PHP_SAMPLE = {
  MerchantID: "3002607",
  MerchantTradeNo: "WPLL4E341E122DB44D62",
  PaymentDate: "2019/05/09 00:01:21",
  PaymentType: "Credit_CreditCard",
  PaymentTypeChargeFee: "1",
  RtnCode: "1",
  RtnMsg: "交易成功",
  SimulatePaid: "0",
  TradeAmt: "500",
  TradeDate: "2019/05/09 00:00:18",
  TradeNo: "1905090000188278",
  CheckMacValue: "6E7F053EF215FC851A050A2FF01D72CBE440EA138DC3E905647985DDF236FD25",
} as const;

/** Documented form-data example from developers.ecpay.com.tw/?p=2878. */
const DOC_SAMPLE_QS =
  "CustomField1=&CustomField2=&CustomField3=&CustomField4=" +
  "&MerchantID=3002607&MerchantTradeNo=D9RMXNrihUYM" +
  "&PaymentDate=2024/12/31 12:26:09&PaymentType=Credit_CreditCard" +
  "&PaymentTypeChargeFee=10&RtnCode=1&RtnMsg=交易成功&SimulatePaid=0&StoreID=" +
  "&TradeAmt=402&TradeDate=2024/12/31 12:25:43&TradeNo=2412311225437371" +
  "&CheckMacValue=85D927637935683EA756CDEF76498FEB9F5D098A7A1AC4F0CB3B3609A9D4116A";

const CREDS = {
  hashKey: ECPAY_SANDBOX.hashKey,
  hashIv: ECPAY_SANDBOX.hashIv,
  merchantId: ECPAY_SANDBOX.merchantId,
};

describe("verifyPaymentNotify", () => {
  it("accepts the official PHP GetCheckoutResponse sample", () => {
    const notify = verifyPaymentNotify({ ...PHP_SAMPLE }, CREDS);
    expect(notify.success).toBe(true);
    expect(notify.simulated).toBe(false);
    expect(notify.merTradeNo).toBe("WPLL4E341E122DB44D62");
    expect(notify.tradeNo).toBe("1905090000188278");
    expect(notify.amount).toBe(500);
    expect(notify.method).toBe("card");
    expect(notify.rtnCode).toBe("1");
    expect(notify.paidAt).toBe("2019/05/09 00:01:21");
  });

  it("accepts the documented p=2878 form-data body string", () => {
    const notify = verifyPaymentNotify(DOC_SAMPLE_QS, CREDS);
    expect(notify.success).toBe(true);
    expect(notify.merTradeNo).toBe("D9RMXNrihUYM");
    expect(notify.amount).toBe(402);
    expect(notify.tradeNo).toBe("2412311225437371");
  });

  it("accepts URLSearchParams (typical of raw Request formData)", () => {
    const params = new URLSearchParams(DOC_SAMPLE_QS);
    const notify = verifyPaymentNotify(params, CREDS);
    expect(notify.success).toBe(true);
  });

  it("flags SimulatePaid=1 so callers do not ship", () => {
    const fields = {
      MerchantID: "3002607",
      MerchantTradeNo: "SIM0001",
      RtnCode: "1",
      RtnMsg: "模擬付款",
      SimulatePaid: "1",
      TradeAmt: "100",
      PaymentType: "ATM_LAND",
      TradeNo: "T1",
      PaymentDate: "2026/01/01 00:00:00",
      TradeDate: "2026/01/01 00:00:00",
      PaymentTypeChargeFee: "0",
    };
    const body = {
      ...fields,
      CheckMacValue: computeCheckMacValue(fields, CREDS.hashKey, CREDS.hashIv),
    };
    const notify = verifyPaymentNotify(body, CREDS);
    expect(notify.success).toBe(true);
    expect(notify.simulated).toBe(true);
    expect(notify.method).toBe("atm");
  });

  it("treats RtnCode != 1 as not success (do not ship)", () => {
    const fields = {
      MerchantID: "3002607",
      MerchantTradeNo: "FAIL1",
      RtnCode: "10100248",
      RtnMsg: "拒絕交易",
      SimulatePaid: "0",
      TradeAmt: "100",
      PaymentType: "Credit_CreditCard",
      TradeNo: "T2",
      PaymentDate: "",
      TradeDate: "2026/01/01 00:00:00",
      PaymentTypeChargeFee: "0",
    };
    const body = {
      ...fields,
      CheckMacValue: computeCheckMacValue(fields, CREDS.hashKey, CREDS.hashIv),
    };
    const notify = verifyPaymentNotify(body, CREDS);
    expect(notify.success).toBe(false);
    expect(notify.rtnCode).toBe("10100248");
  });

  it("rejects a tampered CheckMacValue with AUTH", () => {
    try {
      verifyPaymentNotify({ ...PHP_SAMPLE, CheckMacValue: "DEADBEEF" }, CREDS);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PaymentError);
      expect((err as PaymentError).code).toBe("AUTH");
    }
  });

  it("rejects missing CheckMacValue with AUTH", () => {
    const { CheckMacValue: _, ...rest } = PHP_SAMPLE;
    try {
      verifyPaymentNotify(rest, CREDS);
      expect.unreachable();
    } catch (err) {
      expect((err as PaymentError).code).toBe("AUTH");
    }
  });

  it("rejects MerchantID mismatch when expected merchantId is set", () => {
    try {
      verifyPaymentNotify({ ...PHP_SAMPLE }, { ...CREDS, merchantId: "9999999" });
      expect.unreachable();
    } catch (err) {
      expect((err as PaymentError).code).toBe("VALIDATION");
    }
  });

  it("is available on createEcpayProvider instances", () => {
    const p = createEcpayProvider({ ...ECPAY_SANDBOX });
    const notify = p.verifyPaymentNotify({ ...PHP_SAMPLE });
    expect(notify.success).toBe(true);
    expect(notify.merchantId).toBe(ECPAY_SANDBOX.merchantId);
  });

  it("surfaces creditRefundId from gwsr (NeedExtraPaidInfo notify field)", () => {
    const fields = {
      MerchantID: "3002607",
      MerchantTradeNo: "GW1",
      RtnCode: "1",
      RtnMsg: "交易成功",
      SimulatePaid: "0",
      TradeAmt: "100",
      PaymentType: "Credit_CreditCard",
      TradeNo: "T9",
      PaymentDate: "2026/01/01 00:00:00",
      TradeDate: "2026/01/01 00:00:00",
      PaymentTypeChargeFee: "1",
      gwsr: "13475885",
    };
    const body = {
      ...fields,
      CheckMacValue: computeCheckMacValue(fields, CREDS.hashKey, CREDS.hashIv),
    };
    const notify = verifyPaymentNotify(body, CREDS);
    expect(notify.creditRefundId).toBe("13475885");
  });
});

describe("ECPAY_NOTIFY_ACK", () => {
  it("is exactly 1|OK (ECPay rejects variants)", () => {
    expect(ECPAY_NOTIFY_ACK).toBe("1|OK");
  });
});

describe("coerceNotifyBody", () => {
  it("flattens array values from multi-value parsers", () => {
    const body = coerceNotifyBody({ RtnCode: ["1"], MerchantID: "3002607" });
    expect(body.RtnCode).toBe("1");
    expect(body.MerchantID).toBe("3002607");
  });
});
