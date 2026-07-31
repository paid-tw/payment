import { describe, expect, it } from "vitest";
import { createPayuniProvider } from "../provider.js";
import { isPaymentError, PaymentError } from "@paid-tw/payment";

/**
 * Live trade-query against the real PAYUNi sandbox. Skipped unless
 * PAYUNI_LIVE=1 so the normal/CI suite stays offline and deterministic.
 *
 *   PAYUNI_LIVE=1 \
 *   PAYUNI_MERCHANT_ID=... PAYUNI_HASH_KEY=... PAYUNI_HASH_IV=... \
 *   PAYUNI_QUERY_ID=ORDER-123 \
 *   npm run test -- live
 *
 * Use it to re-record field-exact fixtures: run with PAID_DEBUG=1 and copy the
 * decrypted payload into fixtures.ts.
 */
const live = process.env.PAYUNI_LIVE === "1";

describe.skipIf(!live)("PAYUNi live trade-query (sandbox)", () => {
  const provider = createPayuniProvider({
    merchantId: process.env.PAYUNI_MERCHANT_ID,
    hashKey: process.env.PAYUNI_HASH_KEY,
    hashIv: process.env.PAYUNI_HASH_IV,
    sandbox: true,
  });

  it("queries an order — returns normalized data, or a mapped PaymentError", async () => {
    const id = process.env.PAYUNI_QUERY_ID ?? "NONEXISTENT-ORDER";
    try {
      const data = await provider.getPayment({ merTradeNo: id });
      expect(typeof data.status).toBe("string");
      expect(data.merTradeNo ?? data.tradeNo).toBeTruthy();
    } catch (err) {
      // A bogus id should still round-trip signing/encryption and come back as
      // a normalized, code-bearing error (e.g. QUERY03001 -> NOT_FOUND).
      expect(isPaymentError(err)).toBe(true);
      expect((err as PaymentError).rawCode).toBeTruthy();
    }
  });
});
