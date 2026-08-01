---
"@paid-tw/payment-ecpay": minor
---

Add the ECPay credit queries, exported from the package root:

- `queryEcpayCreditDetail` — 查詢信用卡單筆明細紀錄 (`CreditDetail/QueryTrade`)
- `queryEcpayCardInfo` — 查詢信用卡發卡行 (`Credit/QueryCardInfo`), from a **6-9 digit
  BIN prefix**, never a full card number. ⚠️ 閘道商-only; other merchants get
  `UNSUPPORTED`.

Both are also available as `queryCreditDetail` / `queryCardInfo` on the 幕後授權
provider, which already targets the same host. They live at the **root** rather than
the `/backauth` subpath because neither handles card data.

ECPay documents these same `ecpayment` endpoints under both 站內付 2.0 and 幕後授權, so
one implementation serves both product lines.

Two behaviours worth knowing, both verified against stage:

- `CreditDetail/QueryTrade` has **two error protocols**, and success uses neither: a
  successful response has `RtnMsg: ""` and no `RtnCode`, while a real failure arrives as
  `RtnCode 10000185` — which the doc does not mention for this endpoint at all.
- Zero-padding a short BIN prefix (which the doc instructs) **changes the answer**:
  digits 7-9 select a co-branded product, so a 6-digit prefix identifies the issuer but
  loses 聯名卡 detail.

Adds `ECPAY_SANDBOX_GATEWAY`, ECPay's published 閘道商 stage merchant, needed to exercise
查詢發卡行 at all.
