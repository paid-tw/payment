# @paid-tw/payment-ecpay

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
