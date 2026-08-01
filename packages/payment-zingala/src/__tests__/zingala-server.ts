import { readFileSync } from "node:fs";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { computeDigest } from "../crypto.js";
import { type ZingalaConfig, ZINGALA_PATHS } from "../config.js";
import { createZingalaClient } from "../provider.js";

/**
 * Offline host for the 中租零卡分期 suite, replaying the recorded cassette.
 *
 * The cassette holds the **raw response bodies** exactly as UAT sent them, so these tests
 * exercise the real payload shapes rather than shapes invented from the manual. Digests
 * are recomputed with {@link TEST_KEY} at serve time: the real signatures were made with
 * the account holder's key, which is not in this repo, and recomputing keeps the offline
 * suite deterministic while still forcing the client through genuine verification.
 *
 * The env-gated golden in `crypto.test.ts` is what proves our HMAC convention matches
 * 中租's; this file proves the client behaves correctly given a valid signature.
 */
export const BASE = "https://zingala.test";
export const TEST_MERCHANT = "99999999";
export const TEST_API_KEY = "0123456789abcdef0123456789abcdef";
export const TEST_KEY = "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
export const TEST_IV = "0123456789ABCDEF";

export const config: ZingalaConfig = {
  merchantId: TEST_MERCHANT,
  apiKey: TEST_API_KEY,
  aesKey: TEST_KEY,
  aesIv: TEST_IV,
  baseUrl: BASE,
};

export function testClient(overrides: Partial<ZingalaConfig> = {}) {
  return createZingalaClient({ ...config, ...overrides });
}

export interface Exchange {
  label: string;
  request?: Record<string, unknown>;
  status: number;
  body: string;
  digest?: string;
  redacted?: boolean;
}

export const CASSETTE: Exchange[] = JSON.parse(
  readFileSync(new URL("./cassettes/uat-2026-08-02.json", import.meta.url), "utf8"),
) as Exchange[];

/**
 * Find a recorded exchange by its label.
 *
 * Prefers an exact match, then a unique substring, and **refuses an ambiguous one** — the
 * labels overlap (`reserve_ec valid` is a prefix of `reserve_ec valid_days=31`), so
 * picking the first hit silently binds a test to the wrong recorded response.
 */
export function recorded(fragment: string): Exchange {
  const trimmed = (e: Exchange) => e.label.trim();
  const exact = CASSETTE.filter((e) => trimmed(e) === fragment);
  if (exact.length === 1) return exact[0] as Exchange;

  const partial = CASSETTE.filter((e) => e.label.includes(fragment));
  if (partial.length === 1) return partial[0] as Exchange;
  if (partial.length === 0) {
    throw new Error(`no recorded exchange matching ${JSON.stringify(fragment)}`);
  }
  throw new Error(
    `ambiguous cassette lookup ${JSON.stringify(fragment)} matched ${partial.length}: ` +
      partial.map((e) => JSON.stringify(trimmed(e))).join(", "),
  );
}

/** Serve a body with a freshly computed, valid `Digest`. */
export function signed(body: string, status = 200) {
  return HttpResponse.text(body, {
    status,
    headers: { "Content-Type": "application/json", Digest: computeDigest(body, TEST_KEY) },
  });
}

/** Reply to `path` with a recorded body, correctly signed. */
export function replay(path: string, fragment: string) {
  const exchange = recorded(fragment);
  return http.post(`${BASE}${path}`, () => signed(exchange.body, exchange.status));
}

/** Reply with an arbitrary payload, correctly signed. */
export function respondWith(path: string, payload: unknown) {
  return http.post(`${BASE}${path}`, () => signed(JSON.stringify(payload)));
}

/** Capture the request body and headers a handler received. */
export function capture(path: string, payload: unknown) {
  const seen: { body?: Record<string, unknown>; headers?: Record<string, string> } = {};
  server.use(
    http.post(`${BASE}${path}`, async ({ request }) => {
      seen.body = (await request.json()) as Record<string, unknown>;
      seen.headers = Object.fromEntries(request.headers.entries());
      return signed(JSON.stringify(payload));
    }),
  );
  return seen;
}

export const PATHS = ZINGALA_PATHS;
export const server = setupServer();
