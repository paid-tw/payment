import { describe, expect, it } from "vitest";
import { ECPAY_SANDBOX } from "../../config.js";
import { aesEncrypt, decryptData, encryptData, phpUrlDecode, phpUrlEncode } from "../aes.js";
import { AES_VECTORS, URL_ENCODE_VECTORS } from "./aes-vectors.js";
import type { AesVector } from "./aes-vectors.js";

const KEY = ECPAY_SANDBOX.hashKey;
const IV = ECPAY_SANDBOX.hashIv;

describe("ECPay AES Data crypto", () => {
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

  it("round-trips a nested 幕後取號 payload", () => {
    const payload = {
      MerchantID: "3002607",
      ChoosePayment: "CVS",
      OrderInfo: {
        MerchantTradeNo: "PCCVS1",
        MerchantTradeDate: "2026/08/01 08:03:43",
        TotalAmount: 456,
        ReturnURL: "https://shop.test/notify?a=1&b=2",
        ItemName: "測試商品#第二項",
      },
      CVSInfo: { ExpireDate: 6000, CVSCode: "FAMILY", Desc_1: "line (1)" },
    };
    expect(decryptData(encryptData(payload, KEY, IV), KEY, IV)).toEqual(payload);
  });

  it("php urlencode maps space to +", () => {
    expect(phpUrlEncode("a b")).toBe("a+b");
    expect(phpUrlDecode("a+b")).toBe("a b");
  });

  it("rejects keys or IVs that are not 16 bytes", () => {
    expect(() => aesEncrypt("x", "short", IV)).toThrowError(/hashKey must be 16 bytes/);
    expect(() => aesEncrypt("x", KEY, "short")).toThrowError(/hashIv must be 16 bytes/);
    // Multi-byte characters count as bytes, not code units.
    expect(() => aesEncrypt("x", "中文中文中文中文", IV)).toThrowError(/16 bytes/);
  });
});

/**
 * Look a golden vector up by name instead of by position. Indexing is `| undefined`
 * under `noUncheckedIndexedAccess`, and — worse — a positional reference silently
 * points at a different vector if anyone reorders the fixture list.
 */
function vectorNamed(fragment: string): AesVector {
  const found = AES_VECTORS.find((v) => v.name.includes(fragment));
  if (!found) throw new Error(`no AES vector matching ${fragment}`);
  return found;
}

describe("ECPay official AES vectors", () => {
  it.each(AES_VECTORS.map((v) => [v.name, v] as const))("%s", (_name, vector) => {
    const { hashKey, hashIv, plaintextJson, expectedUrlEncoded, expectedBase64 } = vector;

    if (expectedUrlEncoded) {
      expect(phpUrlEncode(plaintextJson)).toBe(expectedUrlEncoded);
    }
    // encryptData JSON.stringify's its input, so feed the vector's exact JSON text
    // through the same pipeline by encrypting the url-encoded form directly.
    expect(aesEncrypt(phpUrlEncode(plaintextJson), hashKey, hashIv)).toBe(expectedBase64);
    // And the reverse direction, which is what a ReturnURL notify exercises.
    expect(decryptData(expectedBase64, hashKey, hashIv)).toEqual(
      JSON.parse(plaintextJson) as unknown,
    );
  });

  it("produces byte-identical output for an object literal in the documented key order", () => {
    // Guards the whole encryptData path (JSON.stringify → urlencode → AES) against
    // the golden, not just the crypto tail.
    const vector = vectorNamed("插入順序");
    expect(
      encryptData({ MerchantID: "2000132", BarCode: "/1234567" }, vector.hashKey, vector.hashIv),
    ).toBe(vector.expectedBase64);
  });

  it("key order changes the ciphertext, so it must never be normalized", () => {
    const insertionOrder = vectorNamed("插入順序");
    const alphabetical = vectorNamed("字母序");
    expect(insertionOrder.expectedBase64).not.toBe(alphabetical.expectedBase64);
    expect(
      encryptData(
        { BarCode: "/1234567", MerchantID: "2000132" },
        alphabetical.hashKey,
        alphabetical.hashIv,
      ),
    ).toBe(alphabetical.expectedBase64);
  });

  it.each(URL_ENCODE_VECTORS.map((v) => [v.input, v.aesUrlEncode] as const))(
    "aesUrlEncode(%j) === %j",
    (input, expected) => {
      expect(phpUrlEncode(input)).toBe(expected);
      expect(phpUrlDecode(expected)).toBe(input);
    },
  );
});
