import { describe, expect, it } from "vitest";
import { decryptData, encryptData, phpUrlDecode, phpUrlEncode } from "../aes.js";
import { ECPAY_SANDBOX } from "../../config.js";

const KEY = ECPAY_SANDBOX.hashKey;
const IV = ECPAY_SANDBOX.hashIv;

describe("ECPG AES Data crypto", () => {
  it("round-trips a GetToken-like payload", () => {
    const payload = {
      MerchantID: "3002607",
      RememberCard: 0,
      PaymentUIType: 2,
      ChoosePaymentList: "1",
      OrderInfo: {
        MerchantTradeNo: "TEST001",
        TotalAmount: 100,
      },
    };
    const enc = encryptData(payload, KEY, IV);
    expect(enc).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(decryptData(enc, KEY, IV)).toEqual(payload);
  });

  it("php urlencode maps space to +", () => {
    expect(phpUrlEncode("a b")).toBe("a+b");
    expect(phpUrlDecode("a+b")).toBe("a b");
  });
});
