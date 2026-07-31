import crypto from "node:crypto";
import { setupServer } from "msw/node";
import { createPayuniProvider } from "../provider.js";
import type { ProviderRuntimeConfig } from "@paid-tw/payment";

/** Fixed host + test credentials shared by all PAYUNi MSW handlers. */
export const BASE = "https://payuni.test";
export const MERCHANT = "TESTMER01";
export const KEY = "12345678901234567890123456789012"; // 32 bytes (AES-256)
export const IV = "1234567890123456"; // 16 bytes

export const QUERY_URL = `${BASE}/api/trade/query`;

export const server = setupServer();

/** A provider pointed at the mocked host. */
export function testProvider(overrides: Partial<ProviderRuntimeConfig> = {}) {
  return createPayuniProvider({
    merchantId: MERCHANT,
    hashKey: KEY,
    hashIv: IV,
    baseUrl: BASE,
    ...overrides,
  });
}

/**
 * Mirror the adapter's on-the-wire framing: hex( base64(ciphertext) ':::'
 * base64(gcmTag) ), AES-256-GCM. Used to both build encrypted response
 * envelopes and decrypt captured requests.
 */
export function payuniEncrypt(plain: string, key = KEY, iv = IV): string {
  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    Buffer.from(key, "utf8"),
    Buffer.from(iv, "utf8"),
  );
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const combined = `${encrypted.toString("base64")}:::${cipher.getAuthTag().toString("base64")}`;
  return Buffer.from(combined, "utf8").toString("hex");
}

export function payuniDecrypt(hex: string, key = KEY, iv = IV): string {
  const raw = Buffer.from(hex, "hex").toString("utf8");
  const [encryptedBase64, tagBase64] = raw.split(":::");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    Buffer.from(key, "utf8"),
    Buffer.from(iv, "utf8"),
  );
  decipher.setAuthTag(Buffer.from(tagBase64 ?? "", "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedBase64 ?? "", "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** Parse a captured PAYUNi request: outer form fields + decrypted query params. */
export function parseRequest(bodyText: string) {
  const form = new URLSearchParams(bodyText);
  const encryptInfo = form.get("EncryptInfo") ?? "";
  const query = new URLSearchParams(payuniDecrypt(encryptInfo));
  return {
    merId: form.get("MerID"),
    version: form.get("Version"),
    hashInfo: form.get("HashInfo"),
    encryptInfo,
    params: Object.fromEntries(query.entries()),
  };
}

/** A SUCCESS envelope whose `EncryptInfo` decrypts to `decryptedPayload`. */
export function paySuccess(decryptedPayload: string) {
  return {
    Status: "SUCCESS",
    Message: "Success",
    EncryptInfo: payuniEncrypt(decryptedPayload),
    Version: "2.0",
  };
}

/** An error envelope (Status = a PAYUNi QUERYxxxxx code). */
export function payError(status: string, message = "") {
  return { Status: status, Message: message };
}
