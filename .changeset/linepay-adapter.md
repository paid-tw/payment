---
"@paid-tw/payment-linepay": minor
---

feat: add `@paid-tw/payment-linepay` — LINE Pay Online API v4 adapter

`createLinepayProvider` (name `linepay`) covering the whole v4 online line:
付款請求 (request), 付款授權 (confirm), 請款/取消授權 (capture/void), 退款
(refund), 查詢付款明細 (details), and 查詢付款請求狀態 (check) polling.

- HMAC-SHA256 `X-LINE-Authorization` signing with byte-exact payloads; golden
  vectors pin the concatenation order.
- `transactionId` survives as a **string** end-to-end: LINE Pay serializes it
  as a 19-digit JSON number past `Number.MAX_SAFE_INTEGER`, so the adapter
  re-quotes id fields before parsing and rejects number-typed (or
  past-int64) ids at the boundary.
- Errors normalize to `PaymentError` via the official 結果程式碼 table with
  `rawCode`/`rawMessage`/`raw` (incl. the undocumented `errorDetailMap`).
- No NotifyURL exists in this API line — `createPayment` rejects `notifyUrl`
  with an explanation; the flow is confirmUrl redirect + `confirmPayment`,
  or `checkPaymentRequestStatus` polling.
- `refundPayment` accepts the shared `orderId` shape by resolving it through
  查詢付款明細; `tradeNo` (the LINE Pay transactionId) skips the lookup.

Deliberately deferred: the 預先授權 (PREAPPROVED/regKey) API family — no
sandbox path to record it — and the batch form of 查詢付款明細 (≤100 ids).

Offline suite: 41 MSW tests whose handlers re-verify each request's MAC;
request/check/1150/2101 fixtures recorded live against the sandbox
2026-08-13, confirm/refund/details successes doc-derived (approving a
sandbox payment needs a human in the wallet UI).
