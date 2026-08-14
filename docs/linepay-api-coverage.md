# LINE Pay API coverage — `@paid-tw/payment-linepay`

Source: [LINE Pay Online API v4](https://developers-pay.line.me/zh/online-api-v4)
(developers-pay.line.me, fetched 2026-08-13; the site carries no document
version number — watch the [API change log](https://developers-pay.line.me/zh/api-change-log)).

Hosts: sandbox `https://sandbox-api-pay.line.me` · production `https://api-pay.line.me`.
Auth: `X-LINE-Authorization` = Base64(HMAC-SHA256(channelSecret,
channelSecret + apiPath + body|queryString + nonce)), nonce = UUID.

✅ implemented + tested · 🟡 partial / notes · ❌ not implemented (deliberate)

## `createLinepayProvider` (name `linepay`)

| API                | Endpoint                                          | Status | Notes                                                                                     |
| ------------------ | ------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------- |
| 付款請求           | `POST /v4/payments/request`                       | ✅     | `createPayment` — synthesizes a single package from `amount`+`itemDesc` when none given   |
| 查詢付款請求狀態   | `GET /v4/payments/requests/{txId}/check`          | ✅     | `checkPaymentRequestStatus` — 0000/0110/0121/0122/0123 → status enum, not errors          |
| 付款授權 (confirm) | `POST /v4/payments/{txId}/confirm`                | ✅     | `confirmPayment`                                                                          |
| 請款 (capture)     | `POST /v4/payments/authorizations/{txId}/capture` | ✅     | `capturePayment` — for `options.payment.capture=false` requests                           |
| 取消授權 (void)    | `POST /v4/payments/authorizations/{txId}/void`    | ✅     | `voidAuthorization` — empty `{}` body, still signed                                       |
| 查詢付款明細       | `GET /v4/payments`                                | 🟡     | `getPayment` — single `transactionId`/`orderId`; the batch form (≤100 ids) is not exposed |
| 退款               | `POST /v4/payments/{txId}/refund`                 | ✅     | `refundPayment` — omit `amount` for full refund; resolves orderId→txId via 明細           |
| 預先授權付款 3 API | `/v4/payments/preapprovedPay/{regKey}/…`          | ❌     | PREAPPROVED/regKey flows — no sandbox path to record them; revisit on demand              |

## Testing status

- **Crypto**: golden HMAC vectors pin the concatenation order (secret + path +
  payload + nonce) and the GET/POST payload difference; `parseLinepayJson`
  precision tests use a live-recorded 19-digit id.
- **Offline**: MSW handlers re-verify every request's MAC the way the gateway
  does; 41 tests over create/details/refund/confirm/capture/void/check plus
  local-validation and returnCode→PaymentError mapping.
- **Live** (`LINEPAY_LIVE=1`, sandbox channel 2011100170): request → check
  (pending) → confirm-before-auth (1169), bogus-id details/refund → coded
  errors. All green 2026-08-13. Confirm/capture/void success paths need a
  human approving in the sandbox wallet — their fixtures are doc-derived and
  marked as such in `__tests__/fixtures.ts`.

## Deviations / traps found while implementing

- **int64 ids everywhere.** `transactionId`/`refundTransactionId` are JSON
  _numbers_ up to 19 digits — past `Number.MAX_SAFE_INTEGER`. A live id
  (`2026081402375151710`) rounds to `…600` under plain `JSON.parse`. The
  adapter re-quotes them before parsing and keeps ids as strings end-to-end.
- **Path ids are parsed as SIGNED int64** (recorded 2026-08-13): a 19-digit
  id past 2^63−1 fails with `2101` + `errorDetailMap:
{"unrecognizedPathVariable":"transactionId","requiredType":"Number"}`
  before lookup. `errorDetailMap` appears in no documentation table. The
  adapter rejects out-of-range ids locally.
- **HTTP is always 200** — success/failure lives in the body `returnCode`
  (`"0000"` = ok); non-200 means infrastructure, not business errors.
- **The check API overloads `returnCode` as a status** (0110 authenticated,
  0121 canceled, 0122 failed, 0123 completed) — those must not be treated as
  errors, and `0000` there means "buyer hasn't authenticated yet", not done.
- **查詢付款明細 answers 1150 for pending transactions** — a
  requested-but-unconfirmed payment is invisible to `GET /v4/payments`
  (recorded: same 1150 as a nonexistent id). Poll the check API for those.
- **No server notify exists in this API line.** `createPayment` rejects
  `notifyUrl` with an explanation instead of silently ignoring it. The
  confirmUrl redirect carries `orderId` + `transactionId` query params, but
  only `confirmPayment` (or 明細) proves payment.
- **190X temporary errors** are documented as a literal `190X` row;
  `linepayErrorMessage` expands the prefix (1900/1902/… → retriable message).
