import { describe, expect, it } from "vitest";
import { PaymentError } from "@paid-tw/payment";
import { ECPAY_SANDBOX } from "../../config.js";
import { encryptData } from "../aes.js";
import { createEcpayEcpgProvider } from "../provider.js";
import { ECPG_NOTIFY_ACK, verifyEcpgPaymentNotify } from "../notify.js";

const KEY = ECPAY_SANDBOX.hashKey;
const IV = ECPAY_SANDBOX.hashIv;
const MERCHANT = ECPAY_SANDBOX.merchantId;
const CREDS = { hashKey: KEY, hashIv: IV, merchantId: MERCHANT };

/** Doc-style paid card notify Data (p=9058 sample shape). */
function paidCardData(overrides: Record<string, unknown> = {}) {
  return {
    RtnCode: 1,
    RtnMsg: "Success",
    MerchantID: MERCHANT,
    OrderInfo: {
      MerchantTradeNo: "20180914001",
      TradeNo: "1809261503338172",
      TradeAmt: 100,
      TradeDate: "2018/09/26 14:59:54",
      PaymentType: "Credit",
      PaymentDate: "2018/09/26 14:59:54",
      TradeStatus: "1",
    },
    CardInfo: {
      Gwsr: 10735183,
      ProcessDate: "2018/09/26 14:59:54",
      AuthCode: "777777",
      Amount: 100,
      Eci: 2,
      Card4No: "2222",
      Card6No: "491122",
    },
    ...overrides,
  };
}

function envelope(data: Record<string, unknown>, transCode = 1) {
  return {
    MerchantID: MERCHANT,
    RpHeader: { Timestamp: 1_700_000_000 },
    TransCode: transCode,
    TransMsg: "Success",
    Data: encryptData(data, KEY, IV),
  };
}

describe("verifyEcpgPaymentNotify", () => {
  it("decrypts AES Data and normalizes a paid card notify", () => {
    const notify = verifyEcpgPaymentNotify(envelope(paidCardData()), CREDS);
    expect(notify.success).toBe(true);
    expect(notify.simulated).toBe(false);
    expect(notify.merTradeNo).toBe("20180914001");
    expect(notify.tradeNo).toBe("1809261503338172");
    expect(notify.amount).toBe(100);
    expect(notify.method).toBe("card");
    expect(notify.creditRefundId).toBe("10735183");
    expect(notify.card?.authCode).toBe("777777");
    expect(notify.card?.card6No).toBe("491122");
  });

  it("accepts a JSON string body", () => {
    const notify = verifyEcpgPaymentNotify(JSON.stringify(envelope(paidCardData())), CREDS);
    expect(notify.success).toBe(true);
  });

  it("flags SimulatePaid=1", () => {
    const notify = verifyEcpgPaymentNotify(
      envelope(paidCardData({ SimulatePaid: 1 })),
      CREDS,
    );
    expect(notify.success).toBe(true);
    expect(notify.simulated).toBe(true);
  });

  it("treats RtnCode != 1 as not success", () => {
    const notify = verifyEcpgPaymentNotify(
      envelope(paidCardData({ RtnCode: 10100248, RtnMsg: "拒絕交易" })),
      CREDS,
    );
    expect(notify.success).toBe(false);
    expect(notify.rtnCode).toBe(10100248);
  });

  it("rejects TransCode != 1", () => {
    try {
      verifyEcpgPaymentNotify(envelope(paidCardData(), 0), CREDS);
      expect.unreachable();
    } catch (err) {
      expect((err as PaymentError).code).toBe("PROVIDER");
    }
  });

  it("rejects tampered ciphertext with AUTH", () => {
    const env = envelope(paidCardData());
    env.Data = "not-valid-base64-ciphertext!!!";
    try {
      verifyEcpgPaymentNotify(env, CREDS);
      expect.unreachable();
    } catch (err) {
      expect((err as PaymentError).code).toBe("AUTH");
    }
  });

  it("rejects MerchantID mismatch", () => {
    try {
      verifyEcpgPaymentNotify(envelope(paidCardData()), {
        ...CREDS,
        merchantId: "9999999",
      });
      expect.unreachable();
    } catch (err) {
      expect((err as PaymentError).code).toBe("VALIDATION");
    }
  });

  it("is available on createEcpayEcpgProvider", () => {
    const p = createEcpayEcpgProvider({ ...ECPAY_SANDBOX });
    const notify = p.verifyPaymentNotify(envelope(paidCardData()));
    expect(notify.success).toBe(true);
    expect(notify.merchantId).toBe(MERCHANT);
  });
});

describe("ECPG_NOTIFY_ACK", () => {
  it("is exactly 1|OK", () => {
    expect(ECPG_NOTIFY_ACK).toBe("1|OK");
  });
});
