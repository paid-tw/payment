import crypto from "node:crypto";

/**
 * NewebPay crypto primitives (NDNF-1.2.3 §4.1, NDNP-1.0.7 §4.2), all verified
 * byte-for-byte against the worked examples in the official manuals and the
 * golden vectors in OSS SDK test suites (see crypto.test.ts).
 *
 * One cipher, three DIFFERENT integrity formulas — the classic NewebPay trap:
 *
 * | Formula                | Input                          | Prefix          | Suffix           |
 * |------------------------|--------------------------------|-----------------|------------------|
 * | TradeSha / HashData_   | AES ciphertext hex             | `HashKey=<key>&`| `&HashIV=<iv>`   |
 * | CheckCode (responses)  | ksorted Amt,MerchantID,MerchantOrderNo,TradeNo | `HashIV=<iv>&` | `&HashKey=<key>` |
 * | CheckValue (query req) | ksorted Amt,MerchantID,MerchantOrderNo         | `IV=<iv>&`     | `&Key=<key>`     |
 *
 * All three: SHA-256, hex digest, UPPERCASE.
 *
 * The periodic APIs (`PostData_`) and wallet/BNPL APIs (`EncryptData_`) reuse
 * the same AES primitive; the periodic line has NO hash field at all.
 */

/** AES key/iv from the merchant HashKey (32 chars) / HashIV (16 chars), used raw. */
function aesKeyIv(hashKey: string, hashIv: string): { key: Buffer; iv: Buffer } {
  const key = Buffer.from(hashKey, "utf8");
  const iv = Buffer.from(hashIv, "utf8");
  if (key.length !== 32) {
    throw new Error(`NewebPay HashKey must be 32 bytes (got ${key.length})`);
  }
  if (iv.length !== 16) {
    throw new Error(`NewebPay HashIV must be 16 bytes (got ${iv.length})`);
  }
  return { key, iv };
}

/**
 * AES-256-CBC + PKCS7 (16-byte blocks) → lowercase hex.
 *
 * The manual's own BNPL-refund vector proves the current gateway pads to 16
 * bytes (`openssl_encrypt(..., OPENSSL_RAW_DATA, ...)`); the legacy official
 * PHP sample — still copied by most OSS SDKs — pads to a 32-byte block. The
 * gateway accepts either because it strips by last-byte value, as does
 * {@link decryptTradeInfo}.
 */
export function encryptTradeInfo(plaintext: string, hashKey: string, hashIv: string): string {
  const { key, iv } = aesKeyIv(hashKey, hashIv);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]).toString("hex");
}

/**
 * hex → plaintext. Decrypts with auto-unpad DISABLED, then strips PKCS7-style
 * padding manually by last-byte value, accepting pad 1..32: senders that pad
 * to a 32-byte block emit pad bytes 0x11–0x20, which standard PKCS7 unpadding
 * (and Node's auto-unpad) would reject.
 *
 * @throws {Error} when the padding is absent or inconsistent — for gateway
 *   payloads that means the ciphertext was not produced under this
 *   HashKey/HashIV (or was corrupted in transit).
 */
export function decryptTradeInfo(hex: string, hashKey: string, hashIv: string): string {
  const { key, iv } = aesKeyIv(hashKey, hashIv);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(false);
  const buf = Buffer.concat([decipher.update(Buffer.from(hex, "hex")), decipher.final()]);
  if (buf.length === 0) throw new Error("empty ciphertext");
  const pad = buf[buf.length - 1] as number;
  if (pad < 1 || pad > 32 || pad > buf.length) {
    throw new Error(`invalid PKCS7 padding byte: ${pad}`);
  }
  for (let i = buf.length - pad; i < buf.length; i++) {
    if (buf[i] !== pad) throw new Error("corrupt PKCS7 padding");
  }
  return buf.subarray(0, buf.length - pad).toString("utf8");
}

/**
 * TradeSha (MPG) / HashData_ (EWallet, BNPL):
 * `UPPER(SHA256("HashKey=<key>&<cipherHex>&HashIV=<iv>"))` — the hex exactly
 * as transmitted (lowercase).
 */
export function tradeSha(tradeInfoHex: string, hashKey: string, hashIv: string): string {
  return crypto
    .createHash("sha256")
    .update(`HashKey=${hashKey}&${tradeInfoHex}&HashIV=${hashIv}`)
    .digest("hex")
    .toUpperCase();
}

/**
 * PHP `urlencode` (RFC 1738): like encodeURIComponent but `!'()*~` are also
 * percent-encoded and space becomes `+`. NewebPay hashes/serializes with PHP
 * semantics, so parity matters (proven by the OSS CheckCode encoding vector).
 */
function phpUrlEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+");
}

/**
 * PHP `http_build_query` over the fields in the given order (no sorting):
 * `k=v` pairs joined with `&`, keys/values {@link phpUrlEncode}d, `undefined`
 * entries dropped. This is the TradeInfo / PostData_ plaintext serialization.
 */
export function buildQuery(fields: Record<string, string | number | undefined>): string {
  return Object.entries(fields)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([k, v]) => `${phpUrlEncode(k)}=${phpUrlEncode(String(v))}`)
    .join("&");
}

/** ksort (byte order) + http_build_query — the hash-input serialization. */
function sortedQuery(fields: Record<string, string | number>): string {
  return Object.keys(fields)
    .sort()
    .map((k) => `${phpUrlEncode(k)}=${phpUrlEncode(String(fields[k]))}`)
    .join("&");
}

/**
 * QueryTradeInfo REQUEST integrity (NDNF §4.1.6):
 * `UPPER(SHA256("IV=<iv>&<ksorted fields>&Key=<key>"))`.
 * Canonical field set: `{ Amt, MerchantID, MerchantOrderNo }`.
 */
export function checkValue(
  fields: Record<string, string | number>,
  hashKey: string,
  hashIv: string,
): string {
  return crypto
    .createHash("sha256")
    .update(`IV=${hashIv}&${sortedQuery(fields)}&Key=${hashKey}`)
    .digest("hex")
    .toUpperCase();
}

/**
 * Query/Cancel RESPONSE integrity (NDNF §4.1.5) — note the labels and
 * positions are inverted vs {@link tradeSha}:
 * `UPPER(SHA256("HashIV=<iv>&<ksorted fields>&HashKey=<key>"))`.
 * Canonical field set: `{ Amt, MerchantID, MerchantOrderNo, TradeNo }`.
 */
export function checkCode(
  fields: Record<string, string | number>,
  hashKey: string,
  hashIv: string,
): string {
  return crypto
    .createHash("sha256")
    .update(`HashIV=${hashIv}&${sortedQuery(fields)}&HashKey=${hashKey}`)
    .digest("hex")
    .toUpperCase();
}
