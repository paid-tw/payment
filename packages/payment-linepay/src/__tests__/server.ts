import { setupServer } from "msw/node";
import type { LinepayProviderConfig } from "../config.js";
import { signLinepayRequest } from "../crypto.js";
import { createLinepayProvider } from "../provider.js";

/**
 * Fixed host + test credentials shared by all LINE Pay MSW handlers. The
 * values are synthetic — LINE Pay signs with a per-merchant Channel Secret,
 * so unlike NewebPay there is no public documentation credential to reuse;
 * handlers verify signatures by recomputing them with this secret.
 */
export const BASE = "https://linepay.test";
export const CHANNEL_ID = "2011100000";
export const CHANNEL_SECRET = "86b0f1e29a2c4d5f8e7a6b5c4d3e2f1a";

export const REQUEST_URL = `${BASE}/v4/payments/request`;
export const DETAILS_URL = `${BASE}/v4/payments`;
export const confirmUrl = (transactionId: string) =>
  `${BASE}/v4/payments/${transactionId}/confirm`;
export const refundUrl = (transactionId: string) => `${BASE}/v4/payments/${transactionId}/refund`;
export const captureUrl = (transactionId: string) =>
  `${BASE}/v4/payments/authorizations/${transactionId}/capture`;
export const voidUrl = (transactionId: string) =>
  `${BASE}/v4/payments/authorizations/${transactionId}/void`;
export const checkUrl = (transactionId: string) =>
  `${BASE}/v4/payments/requests/${transactionId}/check`;

export const server = setupServer();

/** A provider pointed at the mocked host. */
export function testProvider(overrides: Partial<LinepayProviderConfig> = {}) {
  return createLinepayProvider({
    channelId: CHANNEL_ID,
    channelSecret: CHANNEL_SECRET,
    baseUrl: BASE,
    ...overrides,
  });
}

/**
 * Inspect a captured request the way the gateway does: recompute the MAC over
 * the exact bytes received (body for POST, query string for GET) and report
 * whether it matches `X-LINE-Authorization`, plus the parsed body/headers for
 * field assertions.
 */
export async function inspectSignedRequest(request: Request): Promise<{
  signatureValid: boolean;
  channelId: string | null;
  nonce: string | null;
  body: unknown;
}> {
  const url = new URL(request.url);
  const text = await request.text();
  const payload = request.method === "GET" ? url.searchParams.toString() : text;
  const nonce = request.headers.get("x-line-authorization-nonce");
  const expected = signLinepayRequest(CHANNEL_SECRET, url.pathname, payload, nonce ?? "");
  return {
    signatureValid: request.headers.get("x-line-authorization") === expected,
    channelId: request.headers.get("x-line-channelid"),
    nonce,
    body: text ? (JSON.parse(text) as unknown) : undefined,
  };
}

/** A success envelope. Only safe for fixtures WITHOUT int64 ids (use raw JSON strings for those). */
export function ok(info: unknown) {
  return { returnCode: "0000", returnMessage: "Success.", info };
}

/** An error envelope (returnCode ≠ 0000, no info) — the shape recorded live. */
export function gatewayError(returnCode: string, returnMessage = "") {
  return { returnCode, returnMessage };
}
