import { describe, expect, it } from "vitest";
import { isPaymentError, type PaymentError } from "@paid-tw/payment";
import { createLinepayProvider } from "../provider.js";

/**
 * Live smoke against the real LINE Pay sandbox (sandbox-api-pay.line.me).
 * Skipped unless LINEPAY_LIVE=1 so the normal/CI suite stays offline and
 * deterministic.
 *
 *   LINEPAY_LIVE=1 \
 *   LINEPAY_CHANNEL_ID=... LINEPAY_CHANNEL_SECRET=... \
 *   pnpm test:live:linepay
 *
 * (LINEPAY_SECRET is accepted as an alias for LINEPAY_CHANNEL_SECRET.)
 * Run with PAID_DEBUG=1 to print raw gateway responses and re-record
 * field-exact fixtures.
 *
 * Confirm/capture/void cannot complete headlessly — they need a human to
 * approve the payment in the sandbox wallet (the paymentUrl this suite
 * creates). What CAN be proven server-side: request signing round-trips,
 * the check API reports the pre-auth status, and GET/POST-with-path calls
 * come back with coded errors for bogus ids (i.e. they were authenticated
 * and understood, not rejected at the header).
 */
const live = process.env.LINEPAY_LIVE === "1";

const LIVE_OPTS = { retry: 2, timeout: 30_000 } as const;

const provider = () =>
  createLinepayProvider({
    channelId: process.env.LINEPAY_CHANNEL_ID,
    channelSecret: process.env.LINEPAY_CHANNEL_SECRET ?? process.env.LINEPAY_SECRET,
    sandbox: true,
  });

describe.skipIf(!live)("LINE Pay live (sandbox)", () => {
  it("request + check: creates a payment and polls its pre-auth status", LIVE_OPTS, async () => {
    const orderId = `paidlive${Math.floor(Date.now() / 1000)}`;
    const created = await provider().createPayment({
      amount: 30,
      currency: "TWD",
      method: "linepay",
      orderId,
      itemDesc: "paid-tw live smoke",
      returnUrl: "https://example.com/linepay/confirm",
      cancelUrl: "https://example.com/linepay/cancel",
    });

    expect(created.transactionId).toMatch(/^\d{19}$/);
    expect(created.paymentUrl.web).toMatch(/^https:\/\/sandbox-web-pay\.line\.me\//);
    if (process.env.PAID_DEBUG === "1") {
      console.error("[linepay] live request:", JSON.stringify(created, null, 2));
    }

    const check = await provider().checkPaymentRequestStatus({
      transactionId: created.transactionId,
    });
    // Nobody has opened the paymentUrl → the buyer hasn't authenticated yet.
    expect(check.status).toBe("pending");
    expect(check.returnCode).toBe("0000");

    // Confirming the same pending transaction must fail with a coded error
    // (1169 recorded 2026-08-13) — proves POST-with-path-id signing too.
    const err = await provider()
      .confirmPayment({ transactionId: created.transactionId, amount: 30, currency: "TWD" })
      .then(
        () => {
          throw new Error("expected confirm to fail before the buyer authenticates");
        },
        (e) => e as PaymentError,
      );
    expect(isPaymentError(err)).toBe(true);
    expect(["1169", "1150", "1159"]).toContain(err.rawCode);
    if (process.env.PAID_DEBUG === "1") {
      console.error("[linepay] live confirm error:", err.toJSON());
    }
  });

  it("details on a bogus orderId → NOT_FOUND (GET signing round-trips)", LIVE_OPTS, async () => {
    const err = await provider()
      .getPayment({ merTradeNo: `paidnope${Math.floor(Date.now() / 1000)}` })
      .then(
        () => {
          throw new Error("expected the sandbox to know nothing about this order");
        },
        (e) => e as PaymentError,
      );
    // 1150 (無交易歷史) or an empty info list — both normalize to NOT_FOUND.
    // Anything AUTH-shaped here would mean the query-string signature broke.
    expect(isPaymentError(err)).toBe(true);
    expect(err.code).toBe("NOT_FOUND");
    if (process.env.PAID_DEBUG === "1") {
      console.error("[linepay] live details error:", err.toJSON());
    }
  });

  it("refund on a bogus transactionId → a coded error", LIVE_OPTS, async () => {
    // In int64 range on purpose: the gateway parses path ids as signed int64
    // and answers 2101 before lookup for anything past 2^63-1 (recorded
    // 2026-08-13; the adapter now rejects those locally).
    const err = await provider()
      .refundPayment({ orderId: "unused", tradeNo: "1000000000000000001", amount: 30 })
      .then(
        () => {
          throw new Error("expected the sandbox to reject a bogus refund");
        },
        (e) => e as PaymentError,
      );
    // A lookup-level code (1150/1155) proves the path-embedded id was signed
    // and parsed; AUTH would mean the signature broke.
    expect(isPaymentError(err)).toBe(true);
    expect(err.rawCode).toBeTruthy();
    expect(err.code).not.toBe("AUTH");
    if (process.env.PAID_DEBUG === "1") {
      console.error("[linepay] live refund error:", err.toJSON());
    }
  });
});
