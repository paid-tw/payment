import { describe, expect, it } from "vitest";
import { createCipheriv } from "node:crypto";
import { readFileSync } from "node:fs";
import type { PaymentError } from "@paid-tw/payment";
import {
  computeDigest,
  decryptCustomerInfo,
  encryptCustomerInfo,
  phpUrlEncode,
  verifyDigest,
} from "../crypto.js";

/**
 * Test keys — 32 and 16 bytes, matching what 中租 issues. Not real credentials: the UAT
 * keys are the account holder's, and nothing in this repo may contain them.
 */
const KEY = "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
const IV = "0123456789ABCDEF";

const CASSETTE = new URL("./cassettes/uat-2026-08-02.json", import.meta.url);

interface Exchange {
  label: string;
  body: string;
  digest?: string;
  redacted?: boolean;
}

const exchanges = JSON.parse(readFileSync(CASSETTE, "utf8")) as Exchange[];

function caught(fn: () => unknown): PaymentError {
  try {
    fn();
  } catch (e) {
    return e as PaymentError;
  }
  throw new Error("expected a throw");
}

describe("Digest (HMAC-SHA256)", () => {
  it("is 64 lowercase hex characters", () => {
    const digest = computeDigest('{"result":"000"}', KEY);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("signs the raw bytes, so re-serialized JSON does not reproduce it", () => {
    // The trap: parsing and re-stringifying changes key order and whitespace. Anyone
    // verifying against `JSON.stringify(parsed)` gets a mismatch on every real response.
    const raw = '{"result":"000",  "result_message":"成功"}';
    const reserialized = JSON.stringify(JSON.parse(raw));
    expect(computeDigest(raw, KEY)).not.toBe(computeDigest(reserialized, KEY));
  });

  it("changes when a single character of the body changes", () => {
    const a = computeDigest('{"result":"000"}', KEY);
    const b = computeDigest('{"result":"001"}', KEY);
    expect(a).not.toBe(b);
  });

  it("changes when the key changes", () => {
    const body = '{"result":"000"}';
    expect(computeDigest(body, KEY)).not.toBe(computeDigest(body, `${KEY.slice(0, 31)}X`));
  });

  it("accepts a correct digest and tolerates upper case", () => {
    const body = '{"result":"000"}';
    const digest = computeDigest(body, KEY);
    expect(verifyDigest(body, digest, KEY)).toBe(true);
    expect(verifyDigest(body, digest.toUpperCase(), KEY)).toBe(true);
    expect(verifyDigest(body, ` ${digest} `, KEY)).toBe(true);
  });

  it.each([
    ["a tampered body", '{"result":"999"}'],
    ["an empty body", ""],
  ])("rejects %s", (_label, body) => {
    const digest = computeDigest('{"result":"000"}', KEY);
    expect(verifyDigest(body, digest, KEY)).toBe(false);
  });

  it.each([undefined, null, "", "deadbeef", "z".repeat(64)])(
    "rejects the malformed digest %j without throwing",
    (digest) => {
      // A missing or junk header must be a plain `false` — an adapter decides whether an
      // unsigned response is fatal, and a throw here would take that choice away.
      expect(verifyDigest('{"result":"000"}', digest, KEY)).toBe(false);
    },
  );

  it("rejects a digest of the right length but wrong content", () => {
    const digest = computeDigest('{"result":"000"}', KEY);
    const flipped = `${digest.slice(0, 63)}${digest.endsWith("a") ? "b" : "a"}`;
    expect(verifyDigest('{"result":"000"}', flipped, KEY)).toBe(false);
  });
});

describe("Digest against recorded UAT responses", () => {
  const signed = exchanges.filter((e) => e.digest && !e.redacted);

  it("has golden exchanges to check", () => {
    // Guards the cassette itself: if a re-record dropped every digest, the env-gated
    // golden test below would silently pass by iterating nothing.
    expect(signed.length).toBeGreaterThan(5);
  });

  /**
   * The only test that can prove our HMAC convention matches 中租's, because it needs
   * the real key. Env-gated: the key is the account holder's, so it is never committed.
   *
   *     set -a; source .env; set +a
   *     pnpm vitest run packages/payment-zingala
   */
  const realKey = process.env.ZINGALA_AES_KEY;
  it.skipIf(!realKey)("reproduces every recorded digest with the real key", () => {
    for (const e of signed) {
      expect(computeDigest(e.body, realKey as string), e.label).toBe(e.digest);
      expect(verifyDigest(e.body, e.digest, realKey as string), e.label).toBe(true);
    }
  });

  it("cannot verify recorded digests with a wrong key", () => {
    // Runs unconditionally: it needs no secret, and it proves the goldens are not
    // trivially satisfiable.
    for (const e of signed) {
      expect(verifyDigest(e.body, e.digest, KEY)).toBe(false);
    }
  });
});

describe("info_customer_json (AES-256-CBC)", () => {
  const customer = { cust_name: "王小明", cust_id: "A123456789", cust_phone: "0912345678" };

  it("round-trips the customer envelope", () => {
    const encrypted = encryptCustomerInfo(customer, KEY, IV);
    const decrypted = decryptCustomerInfo(encrypted, KEY, IV);
    expect(decrypted).toMatchObject({
      name: "王小明",
      id: "A123456789",
      phone: "0912345678",
    });
  });

  it("accepts plaintext JSON that was never URL-encoded", () => {
    // laravel-zingala URL-encodes before encrypting but never decodes after, so which
    // form 中租 sends is unverified until we record a real notify. Both must work.
    const cipher = createCipheriv("aes-256-cbc", KEY, IV);
    const raw = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(customer), "utf8")),
      cipher.final(),
    ]).toString("base64");
    expect(decryptCustomerInfo(raw, KEY, IV)?.name).toBe("王小明");
  });

  it.each([undefined, null, ""])("treats the empty value %j as absent, not an error", (value) => {
    // UAT returns "" until an order reaches 專人審核, and production returns "" when
    // customer_info was 0. Neither is a failure.
    expect(decryptCustomerInfo(value, KEY, IV)).toBeUndefined();
  });

  it("reports a wrong key as AUTH rather than crashing", () => {
    const encrypted = encryptCustomerInfo(customer, KEY, IV);
    const err = caught(() => decryptCustomerInfo(encrypted, `${KEY.slice(0, 31)}X`, IV));
    expect(err.code).toBe("AUTH");
    expect(err.message).toContain("解密失敗");
  });

  it("reports plaintext that decrypts but is not JSON", () => {
    const cipher = createCipheriv("aes-256-cbc", KEY, IV);
    const notJson = Buffer.concat([
      cipher.update(Buffer.from("this is not json", "utf8")),
      cipher.final(),
    ]).toString("base64");
    const err = caught(() => decryptCustomerInfo(notJson, KEY, IV));
    expect(err.code).toBe("PROVIDER");
    expect(err.message).toContain("不是 JSON");
  });

  it.each([
    ["short key", "tooshort", IV],
    ["long key", `${KEY}extra`, IV],
    ["short iv", KEY, "short"],
    ["long iv", KEY, `${IV}extra`],
  ])("rejects a %s before touching the cipher", (_label, key, iv) => {
    const err = caught(() => decryptCustomerInfo("cGF5bG9hZA==", key, iv));
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toMatch(/aes(Key|Iv)/);
  });

  it("never leaks the plaintext beyond a short excerpt on a parse failure", () => {
    const secretish = "X".repeat(500);
    const cipher = createCipheriv("aes-256-cbc", KEY, IV);
    const blob = Buffer.concat([
      cipher.update(Buffer.from(secretish, "utf8")),
      cipher.final(),
    ]).toString("base64");
    const err = caught(() => decryptCustomerInfo(blob, KEY, IV));
    const raw = (err.raw as { raw?: string } | undefined)?.raw ?? "";
    expect(raw.length).toBeLessThanOrEqual(200);
  });
});

describe("phpUrlEncode", () => {
  it.each([
    [" ", "+"],
    ["'", "%27"],
    ["~", "%7E"],
    ["!", "%21"],
    ["*", "%2A"],
    ["(", "%28"],
    [")", "%29"],
  ])("encodes %j as %j, unlike encodeURIComponent", (input, expected) => {
    // The quirk shared with ECPay's AES envelope: these seven differ from the JS default,
    // and getting them wrong changes the ciphertext.
    expect(phpUrlEncode(input)).toBe(expected);
  });

  it("leaves ordinary JSON structure intact enough to round-trip", () => {
    const json = JSON.stringify({ cust_name: "王小明 test!'~", n: 1 });
    const decoded = decodeURIComponent(phpUrlEncode(json).replace(/\+/g, " "));
    expect(JSON.parse(decoded)).toEqual({ cust_name: "王小明 test!'~", n: 1 });
  });
});
