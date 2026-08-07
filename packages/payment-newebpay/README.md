# `@paid-tw/payment-newebpay`

NewebPay 藍新金流 adapter for [`@paid-tw/payment`](../payment) — two factories
covering the two API lines that share one set of merchant credentials:

| Factory                        | `name`            | API line                                                                                                |
| ------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------- |
| `createNewebpayProvider`       | `newebpay`        | MPG 幕前支付 (NDNF-1.2.3): checkout form, query, credit-card capture/refund/cancel, notify verification |
| `createNewebpayPeriodProvider` | `newebpay-period` | 信用卡定期定額 (NDNP-1.0.7): mandate creation, AlterStatus/AlterAmt, per-period notify verification     |

## MPG checkout

```ts
import { createNewebpayProvider } from "@paid-tw/payment-newebpay";

const newebpay = createNewebpayProvider({
  merchantId: process.env.NEWEBPAY_MERCHANT_ID,
  hashKey: process.env.NEWEBPAY_HASH_KEY,
  hashIv: process.env.NEWEBPAY_HASH_IV,
  sandbox: true, // ccore.newebpay.com
});

// MPG is a BROWSER form post (server-side posts are rejected with MPG02005):
// render `form.params` as hidden fields posting to `form.action` and submit.
const form = await newebpay.createPayment({
  amount: 100,
  currency: "TWD",
  method: "card", // card | atm | cvs | barcode | linepay
  orderId: "order_123", // 1-30 alnum/underscore
  itemDesc: "商品",
  notifyUrl: "https://shop.example/newebpay/notify",
  returnUrl: "https://shop.example/newebpay/back", // must differ from notifyUrl
  params: { WEBATM: 1 }, // any other MPG field, passed through and signed
});
```

Payment results arrive at `notifyUrl` (answer **HTTP 200** — no ACK body):

```ts
const notify = newebpay.verifyPaymentNotify(req.body); // TradeSha → AES → parse
if (notify.success) fulfil(notify.merTradeNo, notify.amount);
```

ATM/CVS/barcode issue a payment code first — that result posts to
`customerUrl` and is verified with `verifyGetCodeNotify` (it means "code
issued", not "paid"; the paid notify still arrives at `notifyUrl` after the
bank clears).

Query needs the order amount (the CheckValue signs it; there is no
TradeNo-based lookup):

```ts
const data = await newebpay.getPayment({ merTradeNo: "order_123", amount: 100 });
```

Credit-card lifecycle: `refundPayment` (Close CloseType=2), `capturePayment`
(CloseType=1), `cancelCapture` / `cancelRefund` (Cancel=1), and
`cancelAuthorization` (取消授權 — `queued: true` means TRA20001, the cancel
rides the nightly bank batch).

## 定期定額 (periodic)

```ts
import { createNewebpayPeriodProvider } from "@paid-tw/payment-newebpay";

const period = createNewebpayPeriodProvider({
  /* same credentials */
});

const form = await period.createPayment({
  amount: 299, // charged EVERY period
  currency: "TWD",
  method: "card",
  orderId: "sub_202608",
  prodDesc: "Monthly plan",
  periodType: "M",
  periodPoint: "05", // charge on the 5th
  periodTimes: 12,
  startType: 2, // charge P1 immediately
  payerEmail: "buyer@example.com",
  notifyUrl: "https://shop.example/newebpay/period",
});

// Every period fires an N050 notify (failures too — the schedule keeps going):
const cycle = period.verifyPeriodCycleNotify(req.body);
// cycle.tradeNo is refundable through the MPG provider's refundPayment.

await period.alterStatus({
  orderId: "sub_202608",
  periodNo: cycle.periodNo!,
  alterType: "suspend",
});
```

The periodic envelope has **no TradeSha** — successful AES decryption under
your HashKey/HashIV is the gateway's only integrity mechanism.

## Testing

Offline (MSW, deterministic — fixtures replay the manuals' gateway-produced
ciphertexts verbatim):

```bash
pnpm vitest run packages/payment-newebpay
```

Live smoke against the real sandbox (one bogus query per run — the gateway
locks QueryTradeInfo for 4 h after too many not-found lookups):

```bash
NEWEBPAY_MERCHANT_ID=... NEWEBPAY_HASH_KEY=... NEWEBPAY_HASH_IV=... \
pnpm test:live:newebpay
```

API coverage matrix and recording notes: [`docs/newebpay-api-coverage.md`](../../docs/newebpay-api-coverage.md).
