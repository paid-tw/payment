import crypto from "node:crypto";

/**
 * `X-LINE-Authorization` credential:
 * Base64(HMAC-SHA256(channelSecret, channelSecret + apiPath + payload + nonce)).
 *
 * `payload` must be byte-for-byte what goes on the wire — the JSON body string
 * for POST, or the query string (no leading `?`) for GET — because LINE Pay
 * recomputes the MAC over what it actually received.
 *
 * @see https://developers-pay.line.me/zh/online/prerequisites
 */
export function signLinepayRequest(
  channelSecret: string,
  apiPath: string,
  payload: string,
  nonce: string,
): string {
  return crypto
    .createHmac("sha256", channelSecret)
    .update(channelSecret + apiPath + payload + nonce)
    .digest("base64");
}

/** `X-LINE-Authorization-Nonce` — the docs accept a UUID v1/v4 (or a timestamp). */
export function linepayNonce(): string {
  return crypto.randomUUID();
}

/**
 * LINE Pay serializes transactionId as a JSON **number** of up to 19 digits —
 * beyond Number.MAX_SAFE_INTEGER, so a plain JSON.parse silently rounds the
 * low digits off (…6549310 → …6549300) and the id no longer round-trips into
 * confirm/refund calls. Quote the known int64 id fields before parsing so
 * they surface as exact strings.
 */
export function parseLinepayJson(text: string): unknown {
  const quoted = text.replace(/"(transactionId|refundTransactionId)"\s*:\s*(\d+)/g, '"$1":"$2"');
  return JSON.parse(quoted);
}
