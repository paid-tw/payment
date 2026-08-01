---
"@paid-tw/payment-ecpay": minor
---

Make the whole AIO parameter surface reachable, and add the AIO 取號結果通知.

`createPayment` previously sent a fixed set of 11 fields with no way to pass anything
else, so most of AIO was simply unreachable. It now accepts:

- the **13 typed common optional fields** (`storeId`, `clientBackUrl`, `itemUrl`,
  `remark`, `chooseSubPayment`, `orderResultUrl`, `ignorePayment`, `platformId`,
  `customField1`-`4`, `language`)
- `paymentInfoUrl` / `clientRedirectUrl` for the take-number notify
- a **`params` escape hatch** for method-specific fields (`ExpireDate`,
  `StoreExpireDate`, `Desc_1..4`, `CreditInstallment`, `Period*`, …), merged **before**
  the CheckMacValue is computed so passed-through fields are actually signed

Fields the adapter derives or signs cannot be overridden through `params` — they throw
`VALIDATION` rather than silently creating two sources of truth for a signed value.

New `verifyEcpayPaymentInfoNotify` for the 取號結果通知 that `PaymentInfoURL` and
`ClientRedirectURL` deliver.

⚠️ **Use it instead of `verifyPaymentNotify` for that notify.** 取號成功 is `RtnCode 2`
for ATM and `10100073` for CVS/BARCODE — not `1` — so the payment-result verifier
reports a perfectly successful 取號 as `success: false`. Same transport, different
success codes and field set.
