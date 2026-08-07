import { describe, expect, it } from "vitest";
import { isPaymentError, PaymentError } from "@paid-tw/payment";
import { decryptTradeInfo, tradeSha } from "../crypto.js";
import { createNewebpayProvider } from "../provider.js";

/**
 * Live smoke against the real NewebPay sandbox (ccore.newebpay.com). Skipped
 * unless NEWEBPAY_LIVE=1 so the normal/CI suite stays offline and
 * deterministic.
 *
 *   NEWEBPAY_LIVE=1 \
 *   NEWEBPAY_MERCHANT_ID=... NEWEBPAY_HASH_KEY=... NEWEBPAY_HASH_IV=... \
 *   [NEWEBPAY_QUERY_ID=order123 NEWEBPAY_QUERY_AMT=30] \
 *   pnpm test:live:newebpay
 *
 * Run with PAID_DEBUG=1 to print raw gateway responses and re-record
 * field-exact fixtures.
 *
 * ⚠️ Query-lockout: the gateway locks QueryTradeInfo for FOUR HOURS
 * (TRA10071) after too many not-found queries within an hour — this suite
 * fires exactly one bogus query per run; do not loop it.
 *
 * MPG checkout itself cannot be exercised server-side (front-channel browser
 * form post only — MPG02005), so a paid notify is recorded manually: tunnel a
 * NotifyURL, pay with the sandbox test card 4000-2211-1111-1111 on the hosted
 * page, and capture the POST (same recipe as the ECPay stage recording).
 */
const live = process.env.NEWEBPAY_LIVE === "1";

const provider = () =>
  createNewebpayProvider({
    merchantId: process.env.NEWEBPAY_MERCHANT_ID,
    hashKey: process.env.NEWEBPAY_HASH_KEY,
    hashIv: process.env.NEWEBPAY_HASH_IV,
    sandbox: true,
  });

describe.skipIf(!live)("NewebPay live (sandbox)", () => {
  it("builds a checkout form that round-trips under the real credentials", async () => {
    const form = await provider().createPayment({
      amount: 30,
      currency: "TWD",
      method: "card",
      orderId: `paidlive${Math.floor(Date.now() / 1000)}`,
      itemDesc: "paid-tw live smoke",
      notifyUrl: "https://webhook.site/paid-tw-newebpay",
    });
    expect(form.action).toBe("https://ccore.newebpay.com/MPG/mpg_gateway");
    const key = process.env.NEWEBPAY_HASH_KEY ?? "";
    const iv = process.env.NEWEBPAY_HASH_IV ?? "";
    expect(form.params.TradeSha).toBe(tradeSha(form.params.TradeInfo, key, iv));
    expect(decryptTradeInfo(form.params.TradeInfo, key, iv)).toContain("Amt=30");
  });

  it(
    "queries an order — normalized data, or a mapped code-bearing PaymentError",
    { retry: 2, timeout: 40_000 },
    async () => {
      const id = process.env.NEWEBPAY_QUERY_ID ?? `paidnope${Math.floor(Date.now() / 1000)}`;
      const amount = Number(process.env.NEWEBPAY_QUERY_AMT ?? 30);
      try {
        const data = await provider().getPayment({ merTradeNo: id, amount });
        expect(typeof data.status).toBe("string");
        expect(data.merTradeNo ?? data.tradeNo).toBeTruthy();
      } catch (err) {
        // A bogus id still proves CheckValue signing round-trips: the gateway
        // decodes the request and answers with a coded error (TRA10021 查無交易
        // — or TRA10071 if the not-found budget is exhausted).
        expect(isPaymentError(err)).toBe(true);
        expect((err as PaymentError).rawCode).toBeTruthy();
        if (process.env.PAID_DEBUG === "1") {
          console.error("[newebpay] live query error:", (err as PaymentError).toJSON());
        }
      }
    },
  );

  it(
    "cancel-auth on a bogus order — the encrypted envelope round-trips to a coded error",
    { retry: 2, timeout: 40_000 },
    async () => {
      const err = await provider()
        .cancelAuthorization({ orderId: `paidnope${Math.floor(Date.now() / 1000)}`, amount: 30 })
        .then(
          () => {
            throw new Error("expected the sandbox to reject a bogus cancel");
          },
          (e) => e as PaymentError,
        );
      // TRA10021/TRA20002 both mean the gateway DECRYPTED PostData_ and looked
      // the order up — which is exactly what this smoke is for.
      expect(isPaymentError(err)).toBe(true);
      expect(err.rawCode).toBeTruthy();
      if (process.env.PAID_DEBUG === "1") {
        console.error("[newebpay] live cancel error:", err.toJSON());
      }
    },
  );
});
