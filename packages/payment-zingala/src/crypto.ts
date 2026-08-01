/**
 * 中租零卡分期 crypto: the `Digest` HMAC and the AES-256 customer envelope.
 *
 * Both are documented ambiguously, and both were pinned against UAT on 2026-08-02.
 */
import { createCipheriv, createDecipheriv, createHmac, timingSafeEqual } from "node:crypto";
import { PaymentError } from "@paid-tw/payment";

const PROVIDER = "zingala";

/**
 * PHP/.NET `urlencode` applied to the JSON **before** AES, exactly as ECPay's AES
 * envelope does it — `%20` becomes `+`, and `'` / `~` are escaped rather than left
 * literal. Zingala's own reference implementation (LouisLun/laravel-zingala) does this on
 * encrypt.
 *
 * Note it is asymmetric there: that library never calls its own `urldecode` when
 * decrypting. Whether Zingala applies the transform to what *it* sends is therefore
 * unverified — we have not yet recorded a notify carrying a non-empty
 * `info_customer_json` (UAT returns `""` until an order reaches 專人審核). So
 * {@link decryptCustomerInfo} tolerates both: it parses the plaintext as JSON directly
 * and retries after a URL-decode.
 */
export function phpUrlEncode(input: string): string {
  return encodeURIComponent(input)
    .replace(/[!*'()~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+");
}

function assertKeyShape(aesKey: string, aesIv: string): void {
  if (Buffer.byteLength(aesKey, "utf8") !== 32) {
    throw new PaymentError(
      "VALIDATION",
      `${PROVIDER} aesKey 必須是 32 bytes（收到 ${Buffer.byteLength(aesKey, "utf8")}）`,
      PROVIDER,
    );
  }
  if (Buffer.byteLength(aesIv, "utf8") !== 16) {
    throw new PaymentError(
      "VALIDATION",
      `${PROVIDER} aesIv 必須是 16 bytes（收到 ${Buffer.byteLength(aesIv, "utf8")}）`,
      PROVIDER,
    );
  }
}

/**
 * The `Digest` header: HMAC-SHA256 over the **raw response body bytes**, hex, lowercase.
 *
 * ⚠️ Must be computed over the body exactly as it arrived. Re-serializing the parsed
 * JSON changes key order and whitespace and will not reproduce the digest.
 *
 * The key is the AES key. Verified across 25 UAT responses on 2026-08-02; the manual
 * only hints at it.
 */
export function computeDigest(rawBody: string, aesKey: string): string {
  return createHmac("sha256", aesKey).update(rawBody, "utf8").digest("hex");
}

/**
 * Constant-time compare of a received `Digest` against the expected one.
 *
 * Returns `false` for a missing or malformed header rather than throwing, so callers can
 * decide whether an unsigned response is fatal.
 */
export function verifyDigest(
  rawBody: string,
  receivedDigest: string | null | undefined,
  aesKey: string,
): boolean {
  if (!receivedDigest) return false;
  const expected = computeDigest(rawBody, aesKey);
  const received = receivedDigest.trim().toLowerCase();
  if (received.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(received, "utf8"), Buffer.from(expected, "utf8"));
  } catch {
    return false;
  }
}

/** 申請人資料, as carried encrypted in `info_customer_json`. */
export interface ZingalaCustomerInfo {
  /** 申請人姓名. */
  name?: string;
  /** 申請人身分證字號. */
  id?: string;
  /** 申請人手機. */
  phone?: string;
  raw: Record<string, unknown>;
}

/**
 * Decrypt `info_customer_json` — AES-256-CBC, PKCS#7, base64.
 *
 * Returns `undefined` for an empty field, which is what UAT sends for an order the
 * consumer has not been through yet, and what production sends when `customer_info` was
 * `0` (不接收申請人資料). An empty value is not an error.
 */
export function decryptCustomerInfo(
  payload: string | null | undefined,
  aesKey: string,
  aesIv: string,
): ZingalaCustomerInfo | undefined {
  if (!payload) return undefined;
  assertKeyShape(aesKey, aesIv);

  let plaintext: string;
  try {
    const decipher = createDecipheriv("aes-256-cbc", aesKey, aesIv);
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(payload, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch (cause) {
    throw new PaymentError(
      "AUTH",
      `${PROVIDER} info_customer_json 解密失敗（金鑰不符或內容非 AES-256-CBC）`,
      PROVIDER,
      { cause },
    );
  }

  const parsed = parseMaybeUrlEncoded(plaintext);
  if (!parsed) {
    throw new PaymentError("PROVIDER", `${PROVIDER} info_customer_json 解密後不是 JSON`, PROVIDER, {
      raw: plaintext.slice(0, 200),
    });
  }

  return {
    name: asText(parsed.cust_name),
    id: asText(parsed.cust_id),
    phone: asText(parsed.cust_phone),
    raw: parsed,
  };
}

/** Encrypt in the same envelope. Used by the offline suite to build notify fixtures. */
export function encryptCustomerInfo(
  data: Record<string, unknown>,
  aesKey: string,
  aesIv: string,
): string {
  assertKeyShape(aesKey, aesIv);
  const cipher = createCipheriv("aes-256-cbc", aesKey, aesIv);
  return Buffer.concat([
    cipher.update(Buffer.from(phpUrlEncode(JSON.stringify(data)), "utf8")),
    cipher.final(),
  ]).toString("base64");
}

/** Tolerates plaintext that is JSON, or JSON that was URL-encoded before encryption. */
function parseMaybeUrlEncoded(plaintext: string): Record<string, unknown> | null {
  for (const candidate of [plaintext, tryDecode(plaintext)]) {
    if (!candidate) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      /* try the next form */
    }
  }
  return null;
}

function tryDecode(input: string): string | null {
  try {
    return decodeURIComponent(input.replace(/\+/g, " "));
  } catch {
    return null;
  }
}

function asText(input: unknown): string | undefined {
  return typeof input === "string" && input ? input : undefined;
}
