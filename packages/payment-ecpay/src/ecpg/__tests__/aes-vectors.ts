/**
 * ECPay's **official** AES-128-CBC test vectors, transcribed from
 * `test-vectors/aes-encryption.json` in
 * [ECPay/ECPay-API-Skill](https://github.com/ECPay/ECPay-API-Skill) (the vendor's
 * own AI-skill kit, which also ships `verify-node.js` / `verify.py` reference
 * implementations).
 *
 * These are cross-language goldens: the same plaintext must produce the same
 * ciphertext in every SDK. They pin the exact flow ECPay expects —
 * `JSON → PHP urlencode → AES-128-CBC/PKCS7 → Base64` — for every case that
 * commonly breaks a reimplementation, so they cover 站內付 2.0, 幕後取號 and 幕後授權
 * at once (all three share the crypto, only the keys differ).
 *
 * `expectedUrlEncoded` matters as much as the ciphertext: ECPay's AES encoder is
 * plain PHP `urlencode` (uppercase hex, space → `+`, `!*'()~` all escaped) and is
 * **not** the same function as the CheckMacValue encoder, which lowercases and
 * leaves `!*()` alone. Mixing them up is one of the most common integration bugs,
 * so `url-encode-comparison.json`'s divergent cases are pinned too.
 */

export interface AesVector {
  name: string;
  hashKey: string;
  hashIv: string;
  /** Exact JSON text — key order is significant, since it changes the ciphertext. */
  plaintextJson: string;
  expectedUrlEncoded?: string;
  expectedBase64: string;
  note?: string;
}

const INVOICE_KEY = "ejCk326UnaZWKisg";
const INVOICE_IV = "q9jcZX8Ib9LM8wYk";
/** The 金流 account (站內付 2.0 / 幕後取號 / 幕後授權 stage pair). */
const PAYMENT_KEY = "pwFHCqoQZGmho4w6";
const PAYMENT_IV = "EkRm7iFT261dpevs";

export const AES_VECTORS: readonly AesVector[] = [
  {
    name: "基本測試（插入順序 JSON key）",
    hashKey: INVOICE_KEY,
    hashIv: INVOICE_IV,
    plaintextJson: '{"MerchantID":"2000132","BarCode":"/1234567"}',
    expectedUrlEncoded: "%7B%22MerchantID%22%3A%222000132%22%2C%22BarCode%22%3A%22%2F1234567%22%7D",
    expectedBase64:
      "XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTW3DVa6yI7vKmjBRp2eulDhXoru/qBqFDBH3fEqlkMn3bbJfJBfGAq+v+SvttutYnc=",
    note: "Insertion-order JSON, which is what JS object literals give us.",
  },
  {
    name: "基本測試（字母序 JSON key）",
    hashKey: INVOICE_KEY,
    hashIv: INVOICE_IV,
    plaintextJson: '{"BarCode":"/1234567","MerchantID":"2000132"}',
    expectedBase64:
      "r0JSyF9wVmywUav725b3rdJs3xp/ekrC/7PGb18zhKyXkPsamV9l4rPnBkaaraPcHtMSwrmSPP3wuS7b8g/aAKGs0iGiknpgpbdXKXvFrYM=",
    note: "Same fields, alphabetical order (Go map / Java HashMap) → different ciphertext. Proves key order must not be normalized away.",
  },
  {
    name: "特殊字元測試（!*'()~）",
    hashKey: INVOICE_KEY,
    hashIv: INVOICE_IV,
    plaintextJson: '{"Name":"test!*\'()~value"}',
    expectedUrlEncoded: "%7B%22Name%22%3A%22test%21%2A%27%28%29%7Evalue%22%7D",
    expectedBase64:
      "uvI4yrErM37XNQkXGAgRgBuDOiJoVs72Xn/rum9Ejl1DSna4HyLSoY7764PmhTR7JXb9jJWLSjCGcZEDeFiABg==",
    note: "encodeURIComponent leaves !*'() unescaped; PHP urlencode does not. This is the vector that catches a missing manual replace.",
  },
  {
    name: "PKCS7 16-byte 邊界測試（url-encoded 剛好 32 bytes）",
    hashKey: INVOICE_KEY,
    hashIv: INVOICE_IV,
    plaintextJson: '{"N":"1234567890"}',
    expectedUrlEncoded: "%7B%22N%22%3A%221234567890%22%7D",
    expectedBase64: "gVwWJnIpl1m3ZDypcRAjiCctilYnQhHn4h8OzJP5IxQPov7HuysXX+jPONvrHS7Z",
    note: "Exactly 2 AES blocks, so PKCS7 must append a whole extra 16-byte block. A padding bug that skips it still 'works' locally but fails ECPay's decrypt.",
  },
  {
    name: "UTF-8 中文字元測試",
    hashKey: INVOICE_KEY,
    hashIv: INVOICE_IV,
    plaintextJson: '{"MerchantID":"2000132","ItemName":"綠界科技測試商品"}',
    expectedUrlEncoded:
      "%7B%22MerchantID%22%3A%222000132%22%2C%22ItemName%22%3A%22%E7%B6%A0%E7%95%8C%E7%A7%91%E6%8A%80%E6%B8%AC%E8%A9%A6%E5%95%86%E5%93%81%22%7D",
    expectedBase64:
      "XeEOdHpTRvxKEqs/JD9RSd16s7VtpyWVCN6AV44pKTVKsXddZRgV+Cle9oeB2PqsEC2O0oDi4kObiCtdGznG9aAX69Kj0//VjGXhieBYZ3RuGW9v20xQyBevaBwtOvg1lYjlDw6jsgfToGMUvlGsIJ2DO6/tbXjNZumnRgj2GCSj7LLDRBU3KlkUWji16nO1",
    note: "Literal UTF-8, matching JSON.stringify. PHP's default json_encode escapes to \\uXXXX and would NOT match — relevant when comparing against ECPay's PHP SDK.",
  },
  {
    name: "ECPG 金流帳號測試（GetTokenbyTrade 請求格式）",
    hashKey: PAYMENT_KEY,
    hashIv: PAYMENT_IV,
    plaintextJson: '{"MerchantID":"3002607","RespondType":"JSON"}',
    expectedUrlEncoded: "%7B%22MerchantID%22%3A%223002607%22%2C%22RespondType%22%3A%22JSON%22%7D",
    expectedBase64:
      "udqjXgM+7Q6lCrrculcvzUFnN5zv0ibax1glKFxrORoO0sl6pcoib/QDYPKCAP57ME4+3Yo84XmyabVFnxriMTuy9JK/RXS7DtEOvF+PUoU=",
    note: "Same flow on the 金流 key pair — the one our ECPG and 幕後取號 adapters actually use.",
  },
];

/**
 * From `test-vectors/url-encode-comparison.json`: cases where the AES encoder and
 * the CheckMacValue encoder disagree. Only `aesUrlEncode` is `phpUrlEncode`'s job.
 */
export const URL_ENCODE_VECTORS: readonly { input: string; aesUrlEncode: string }[] = [
  { input: "Items (Special)~Test", aesUrlEncode: "Items+%28Special%29%7ETest" },
  { input: "Tom's Shop!", aesUrlEncode: "Tom%27s+Shop%21" },
  { input: "price=100&item=test*2", aesUrlEncode: "price%3D100%26item%3Dtest%2A2" },
  // Unreserved characters: both encoders agree here, which is exactly why
  // "it worked in my test" does not prove the right function was used.
  { input: "file_name-v2.0", aesUrlEncode: "file_name-v2.0" },
];
