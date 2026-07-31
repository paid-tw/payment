import { createCipheriv, createDecipheriv } from "node:crypto";

/**
 * ECPG (站內付 2.0) Data field crypto — same family as ECPay JSON+AES APIs
 * (invoice B2C, ECPG): `JSON → PHP urlencode → AES-128-CBC → Base64`.
 *
 * @see https://developers.ecpay.com.tw/?p=9103
 */

/** PHP `urlencode`: space → `+`; encode `!'()*~`. */
export function phpUrlEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+");
}

/** PHP `urldecode`. */
export function phpUrlDecode(value: string): string {
  return decodeURIComponent(value.replace(/\+/g, " "));
}

function assertKeyIv(hashKey: string, hashIv: string): void {
  const k = Buffer.byteLength(hashKey, "utf8");
  const v = Buffer.byteLength(hashIv, "utf8");
  if (k !== 16) {
    throw new Error(`ECPay ECPG hashKey must be 16 bytes (AES-128-CBC), got ${k}`);
  }
  if (v !== 16) {
    throw new Error(`ECPay ECPG hashIv must be 16 bytes, got ${v}`);
  }
}

export function aesEncrypt(plaintext: string, hashKey: string, hashIv: string): string {
  assertKeyIv(hashKey, hashIv);
  const cipher = createCipheriv("aes-128-cbc", hashKey, hashIv);
  return Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]).toString("base64");
}

export function aesDecrypt(base64: string, hashKey: string, hashIv: string): string {
  assertKeyIv(hashKey, hashIv);
  const decipher = createDecipheriv("aes-128-cbc", hashKey, hashIv);
  return Buffer.concat([decipher.update(Buffer.from(base64, "base64")), decipher.final()]).toString(
    "utf8",
  );
}

/** Encrypt request `Data`: object → urlencoded JSON → AES → Base64. */
export function encryptData(data: unknown, hashKey: string, hashIv: string): string {
  return aesEncrypt(phpUrlEncode(JSON.stringify(data)), hashKey, hashIv);
}

/** Decrypt response `Data`: Base64 → AES → urldecode → JSON. */
export function decryptData<T = Record<string, unknown>>(
  base64: string,
  hashKey: string,
  hashIv: string,
): T {
  return JSON.parse(phpUrlDecode(aesDecrypt(base64, hashKey, hashIv))) as T;
}
