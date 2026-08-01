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

**Breaking, despite being a `minor` on 0.x:** `params` rejects three groups of names
rather than merging them, each throwing `VALIDATION`.

- **Derived or signed by the adapter** — `MerchantID`, `MerchantTradeNo`,
  `MerchantTradeDate`, `PaymentType`, `TotalAmount`, `ReturnURL`, `ChoosePayment`,
  `EncryptType`, `CheckMacValue`. Two sources of truth for a signed value is how you get
  a MAC that does not match what you meant to send.
- **Already covered by a typed option** — `StoreID`, `ClientBackURL`, `ItemURL`, `Remark`,
  `ChooseSubPayment`, `OrderResultURL`, `IgnorePayment`, `PlatformID`,
  `CustomField1`-`4`, `Language`, `PaymentInfoURL`, `ClientRedirectURL`. Use the named
  option (`storeId`, `remark`, …). If you passed one of these through `params` against a
  pre-release build it silently won over the typed field; it now throws instead.
- **Object-internal names and malformed identifiers** — `__proto__`, `constructor`,
  `prototype`, and anything that is not an ASCII identifier. ECPay has no such fields, and
  `constructor`/`prototype` were previously signed and sent.

New `verifyEcpayPaymentInfoNotify` for the 取號結果通知 that `PaymentInfoURL` and
`ClientRedirectURL` deliver.

⚠️ **Use it instead of `verifyPaymentNotify` for that notify.** 取號成功 is `RtnCode 2`
for ATM and `10100073` for CVS/BARCODE — not `1` — so the payment-result verifier
reports a perfectly successful 取號 as `success: false`. Same transport, different
success codes and field set.
