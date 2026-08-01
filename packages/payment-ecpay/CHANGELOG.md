# @paid-tw/payment-ecpay

## 0.3.0

### Minor Changes

- cd1d403: Make the whole AIO parameter surface reachable, and add the AIO 取號結果通知.

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
    pre-release build, the `params` value silently took precedence over the typed option;
    it now throws instead.
  - **Object-internal names, and any name that is not a valid field name** — `__proto__`,
    `constructor`, `prototype`, plus anything that does not match
    `/^[A-Za-z][A-Za-z0-9_]*$/`. Note the leading character must be a **letter**, so
    `_Foo` throws as well as `9foo` and `has-dash`. ECPay has no fields by any of those
    names, and `constructor`/`prototype` were previously signed and sent.

  New `verifyEcpayPaymentInfoNotify` for the 取號結果通知 that `PaymentInfoURL` and
  `ClientRedirectURL` deliver.

  ⚠️ **Use it instead of `verifyPaymentNotify` for that notify.** 取號成功 is `RtnCode 2`
  for ATM and `10100073` for CVS/BARCODE — not `1` — so the payment-result verifier
  reports a perfectly successful 取號 as `success: false`. Same transport, different
  success codes and field set.

- 771a255: Add the ECPay credit queries, exported from the package root:

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

- 6716a77: feat(ecpay): 定期定額 (recurring credit) on the 幕後授權 provider

  `@paid-tw/payment-ecpay/backauth` can now run the full recurring-credit lifecycle:

  - `createPayment({ period })` starts a schedule (`D`/`M`/`Y`, with the ranges validated
    before the request goes out)
  - `queryPeriodOrder()` reads its progress, including the per-cycle history
  - `creditCardPeriodAction()` does `ReAuth` / `Cancel`

  There is no dedicated create endpoint at ECPay — a schedule is an ordinary `BackAuth`
  call carrying four extra `CardInfo` fields — so this adds no new provider and no new
  config.

  Two fields ECPay returns but does not document are surfaced, both verified against
  stage:

  - `executions` (`ExecLog`) — the only per-cycle history. Counters report _how many_
    cycles succeeded; this reports which, when, for how much, and under which `TradeNo`
    (each cycle gets its own), which is what reconciliation needs.
  - `isActive` / `execStatus` (`ExecStatus`) — whether the schedule is still running.
    `status`/`TradeStatus` cannot answer this: it stays `"paid"` on a cancelled schedule
    because the first cycle really was charged.

  Also fixes `EcpayBackAuthAuthorizedResult.period`, which was declared but never
  populated, so the schedule ECPay echoes on the create response was always dropped.

  Note for anyone testing this: **the first cycle is charged at create time**, so
  `execTimes: 2` means "now plus one more", not "two future charges".

## 0.2.0

### Minor Changes

- 4ad7fd6: Add ECPay 信用卡幕後授權 (BackAuth): `createEcpayBackAuthProvider`
  (`name: "ecpay-backauth"`) authorizes a card server-side with no ECPay page in the
  flow — `createPayment` returns `{ mode: "3ds" }` or `{ mode: "authorized" }`, plus
  `getPayment`, `creditDoAction` and `verifyPaymentNotify`.

  ⚠️ **This adapter accepts a raw card number and therefore puts the calling process
  in PCI-DSS SAQ D scope**, where the other three ECPay adapters keep you at SAQ A
  because card data never reaches you.

  It is published on its own subpath rather than the package root:

  ```ts
  import { createEcpayBackAuthProvider } from "@paid-tw/payment-ecpay/backauth";
  ```

  Scope follows from _handling_ card data, so not calling it keeps you at SAQ A either
  way — the separate entry point is what lets a build prove by import graph that it
  excludes the card-accepting surface, which is a mechanically checkable answer during
  an audit rather than a statement of intent. The package root exports only the three
  adapters that never see card data.

  ECPay also requires OTP off and 3D verification enabled on the merchant before
  BackAuth works.

  Two behaviours worth knowing before you integrate, both verified against stage:

  - The 3D response carries **no `RtnCode`** — check `result.mode` before anything
    else, or a valid 3DS hand-off looks like a failure.
  - `Credit/DoAction` (請退款) is **production only**; ECPay does not expose it on
    stage, so a sandbox-configured provider throws `UNSUPPORTED`.

- f354685: Complete the ECPay 非信用卡幕後取號 surface:

  - `getCvsBarcode` (`QueryCVSBarcode`) converts a 超商代碼 into three barcode segments.
    Segments are **chain-specific** (verified against stage), and `chain` accepts only
    `Family` / `Hilife` / `iBon` — the `CVS` and `OK` values usable at 取號 time cannot
    be converted.
  - `downloadTradeMedia` (`QueryTradeMedia`) downloads the 撥款對帳檔. This endpoint
    answers **CSV, not the AES envelope**, and every cell is Excel-armoured as
    `="value"` — use the new `parseTradeMediaCsv` export rather than splitting it by
    hand. The real file carries a 13th column (`金流處理費`) that ECPay's doc omits.

- cdc2654: Add ECPay 非信用卡幕後取號 (background 取號) support: `createEcpayPayCodeProvider`
  (`name: "ecpay-paycode"`) obtains an ATM 虛擬帳號, 超商代碼 or 超商條碼 server-side on
  `ecpayment(-stage).ecpay.com.tw`, with no consumer redirect — the create response
  carries the payment code itself.

  - `createPayment` → `GenPaymentCode` for `method: "atm" | "cvs" | "barcode"`
  - `getPayment` → `QueryTrade`; `getPaymentCode` → `QueryPaymentInfo` (the only way
    to re-read a code, since `QueryTrade`'s `ATMInfo` describes the payer)
  - `verifyPaymentNotify` + `ECPAY_PAYCODE_NOTIFY_ACK` for the AES-JSON ReturnURL
  - `refundPayment` throws `UNSUPPORTED`: ECPay ships no refund API for these methods
  - `expireDate` is validated per method, because the unit differs (ATM/BARCODE count
    days, CVS counts minutes)

  `PaymentMethod` gains `"barcode"`, and the AIO adapter maps it to
  `ChoosePayment=BARCODE` instead of falling through to `ALL`.

### Patch Changes

- Updated dependencies [cdc2654]
  - @paid-tw/payment@0.2.0

## 0.1.0

### Minor Changes

- **AIO（`createEcpayProvider`，name `ecpay`）**
  - create → AioCheckOut V5，`mode: "redirect"`
  - get → QueryTradeInfo/V5
  - refund / capture / cancelClose / abandon → DoAction R/C/E/N
  - `queryCreditTrade`（CreditDetail/QueryTrade/V2）
  - `verifyPaymentNotify` + `ECPAY_NOTIFY_ACK`（ReturnURL form CheckMacValue）
  - 公開 stage 常數 `ECPAY_SANDBOX` / `ECPAY_SANDBOX_PORTAL`
  - create 固定 `NeedExtraPaidInfo=Y`
- **站內付 2.0（`createEcpayEcpgProvider`，name `ecpay-ecpg`）**
  - create → GetTokenbyTrade，`mode: "token"`
  - `createPaymentWithPayToken`
  - AES-JSON client
  - `verifyEcpgPaymentNotify` + `ECPG_NOTIFY_ACK`
- MSW + live（`ECPAY_LIVE=1`）測試與覆蓋文件。
