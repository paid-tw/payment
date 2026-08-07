import { describe, expect, it } from "vitest";
import { isPaymentError, PaymentError } from "@paid-tw/payment";
import { createNewebpayPeriodProvider } from "../provider.js";

/**
 * Live smoke for the 定期定額 line against the real sandbox. Skipped unless
 * NEWEBPAY_LIVE=1 (same env vars as the MPG live suite).
 *
 * Mandate creation cannot be exercised server-side (the consumer types the
 * card on NewebPay's hosted page), so the smoke drives AlterStatus with a
 * bogus mandate: a coded rejection (e.g. PER10067 查無委託單) proves the
 * MerchantID_/PostData_ envelope encrypts, transmits, and decrypts correctly
 * end-to-end. Record a real create-result notify the browser way (see
 * live.test.ts) to add mandate fixtures.
 */
const live = process.env.NEWEBPAY_LIVE === "1";

describe.skipIf(!live)("NewebPay 定期定額 live (sandbox)", () => {
  it(
    "alterStatus on a bogus mandate — the envelope round-trips to a coded error",
    { retry: 2, timeout: 40_000 },
    async () => {
      const provider = createNewebpayPeriodProvider({
        merchantId: process.env.NEWEBPAY_MERCHANT_ID,
        hashKey: process.env.NEWEBPAY_HASH_KEY,
        hashIv: process.env.NEWEBPAY_HASH_IV,
        sandbox: true,
      });
      const err = await provider
        .alterStatus({
          orderId: `paidnope${Math.floor(Date.now() / 1000)}`,
          periodNo: "P000000000000000000",
          alterType: "suspend",
        })
        .then(
          () => {
            throw new Error("expected the sandbox to reject a bogus mandate");
          },
          (e) => e as PaymentError,
        );
      expect(isPaymentError(err)).toBe(true);
      expect(err.rawCode).toBeTruthy();
      if (process.env.PAID_DEBUG === "1") {
        console.error("[newebpay-period] live alterStatus error:", err.toJSON());
      }
    },
  );
});
