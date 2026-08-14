# `@paid-tw/payment-linepay`

LINE Pay adapter for [`@paid-tw/payment`](../payment) — Online API **v4**
(`createLinepayProvider`, name `linepay`), authenticated with a Channel ID +
Channel Secret from the [LINE Pay Merchant Center](https://pay.line.me/)
(sandbox accounts: [developers-pay.line.me](https://developers-pay.line.me/zh/sandbox)).

## The flow: request → redirect → confirm

LINE Pay has **no server-to-server notify**. The buyer pays in three steps,
and step 3 happens on _your_ server after a front-channel redirect:

```ts
import { createLinepayProvider } from "@paid-tw/payment-linepay";

const linepay = createLinepayProvider({
  channelId: process.env.LINEPAY_CHANNEL_ID,
  channelSecret: process.env.LINEPAY_CHANNEL_SECRET,
  sandbox: true, // sandbox-api-pay.line.me
});

// 1) 付款請求 — nothing is charged yet.
const created = await linepay.createPayment({
  amount: 100,
  currency: "TWD", // TWD | USD | THB
  method: "linepay",
  orderId: "order_123", // ≤ 100 chars
  itemDesc: "商品",
  returnUrl: "https://shop.example/linepay/confirm", // LINE Pay's confirmUrl
  cancelUrl: "https://shop.example/linepay/cancel",
});

// 2) Send the buyer to created.paymentUrl.web (or .app inside LINE).
//    LINE Pay redirects them back to confirmUrl?orderId=...&transactionId=...

// 3) 付款授權 — THIS completes the payment. The redirect alone proves nothing.
const confirmed = await linepay.confirmPayment({
  transactionId: created.transactionId, // from step 1 or the redirect query
  amount: 100, // must equal the requested amount (1153 otherwise)
  currency: "TWD",
});
```

Instead of (or besides) the redirect, poll 查詢付款請求狀態:

```ts
const check = await linepay.checkPaymentRequestStatus({
  transactionId: created.transactionId,
});
// "pending" | "ready" (confirm now) | "completed" | "canceled" | "failed"
```

⚠️ **`transactionId` is a string** everywhere in this adapter. LINE Pay
serializes it as a JSON number of up to 19 digits — past
`Number.MAX_SAFE_INTEGER`, where `JSON.parse` silently rounds the low digits
off. The adapter re-quotes the id fields before parsing
(`parseLinepayJson`) and rejects number-typed ids at the boundary, because a
rounded id targets a _different_ payment.

## Query, refund, auth/capture

```ts
// 查詢付款明細 — post-confirm transactions only (pending ones answer 1150).
const data = await linepay.getPayment({ merTradeNo: "order_123" }); // or { tradeNo }

// 退款 — omit amount for a full refund. tradeNo skips the orderId lookup.
await linepay.refundPayment({ orderId: "order_123", amount: 40 });

// Auth/capture separation: request with options.payment.capture=false, then
await linepay.capturePayment({ transactionId, amount: 100, currency: "TWD" });
await linepay.voidAuthorization({ transactionId }); // only before capture
```

Fuller carts pass `packages` (per-shipment product breakdowns) and `options`
(locale, shipping, capture mode, …) straight through to the gateway —
`Σ packages[].amount` + shipping fee must equal `amount`, validated locally.

Errors are normalized `PaymentError`s: stable `code`
(`NOT_FOUND`/`CONFLICT`/`VALIDATION`/`AUTH`/…) mapped from the official
結果程式碼 table, with `rawCode`/`rawMessage`/`raw` preserved (including the
undocumented `errorDetailMap` some parameter errors carry).

## Testing

Offline (MSW, deterministic — request/check/error fixtures recorded from the
sandbox 2026-08-13):

```bash
pnpm vitest run packages/payment-linepay
```

Live smoke against the real sandbox (creates an unconfirmed 30-TWD request
per run; nothing is ever charged):

```bash
LINEPAY_CHANNEL_ID=... LINEPAY_CHANNEL_SECRET=... \
pnpm test:live:linepay
```

Confirm/capture/void cannot be exercised headlessly — they need a human
approving the payment in the sandbox wallet. See the coverage matrix for
what is recorded vs doc-derived:
[`docs/linepay-api-coverage.md`](../../docs/linepay-api-coverage.md).
