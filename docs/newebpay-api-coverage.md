# NewebPay API coverage

Source manuals: 線上交易─幕前支付技術串接手冊 **NDNF-1.2.3** (2026/07/14) and
信用卡定期定額串接技術手冊 **NDNP-1.0.7** (2026/03/16). One package, two
factories (`newebpay` / `newebpay-period`) — same decision shape as
[ecpay-provider-separation.md](./ecpay-provider-separation.md): same vendor +
shared credentials, but different endpoints, envelopes, and error tables.

Legend: ✅ implemented + tested · 🟡 partial / notes · ❌ not implemented (deliberate).

## MPG 幕前支付 — `createNewebpayProvider` (`newebpay`)

| API                      | Doc id        | Endpoint                               | Status | Notes                                                                                                                                                                                                                                                                                                                                   |
| ------------------------ | ------------- | -------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MPG 交易 (checkout)      | NPA-F01       | `/MPG/mpg_gateway`                     | ✅     | Version 2.3. Browser form post ONLY (server-side POST → MPG02005), so `createPayment` returns a signed redirect form and never calls the network. Methods: card/atm/cvs/barcode/linepay typed; the other ~20 enable flags (WEBATM, TWQR, wallets, InstFlag, OrderDetail, CVSCOM, NTCB, TokenTerm…) pass through `params` and are signed |
| 付款結果通知             | §4.2.2        | NotifyURL / ReturnURL                  | ✅     | `verifyPaymentNotify` — TradeSha over ciphertext BEFORE decrypt; JSON + String RespondTypes; per-method extras (card/atm/cvs/barcode). Manual's gateway-produced ciphertext replayed verbatim in tests                                                                                                                                  |
| 取號完成通知             | §4.2.3        | CustomerURL                            | ✅     | `verifyGetCodeNotify` — code issued ≠ paid; ATM/CVS/barcode/CVSCOM shapes                                                                                                                                                                                                                                                               |
| 單筆交易查詢             | NPA-B02       | `/API/QueryTradeInfo`                  | ✅     | Version 1.3. Needs the order **amount** (CheckValue signs Amt). Response CheckCode verified strictly. `Gateway=Composite` auto-added for MS5-prefixed shops. TradeStatus 0/1/2/3/6 + OrderStatus 9 → pending                                                                                                                            |
| 取消授權                 | NPA-B01       | `/API/CreditCard/Cancel`               | ✅     | `cancelAuthorization` — TRA20001 surfaced as `queued: true` (nightly bank batch); response CheckCode verified                                                                                                                                                                                                                           |
| 請款 / 退款 / 取消請退款 | NPA-B031~34   | `/API/CreditCard/Close`                | ✅     | `capturePayment` / `refundPayment` (CloseType 2) / `cancelCapture` / `cancelRefund`. 分期/紅利 must be full-amount (gateway-enforced; TRA-coded errors mapped)                                                                                                                                                                          |
| 電子錢包退款             | NPA-B06       | `/API/EWallet/refund`                  | ❌     | Different envelope (`UID_`/`EncryptData_`, **JSON** inner payload, success Status `"1000"`); the manual's worked vectors were produced under a different shop's keys and cannot be verified. Add when a wallet merchant needs it                                                                                                        |
| BNPL 退款 / 請款         | NPA-B07 / B62 | `/API/Bnpl/refund`, `/API/Bnpl/settle` | ❌     | Same envelope family as B06; AFTEE-only. Deferred with it                                                                                                                                                                                                                                                                               |
| EncryptType=1 (AES-GCM)  | §4.1.1        | —                                      | ❌     | The manual specifies no GCM parameters and publishes no vectors — not implemented blind; notifies carrying `EncryptType=1` are rejected as UNSUPPORTED                                                                                                                                                                                  |

## 信用卡定期定額 — `createNewebpayPeriodProvider` (`newebpay-period`)

| API              | Doc id   | Endpoint                  | Status | Notes                                                                                                                                                                                                                                                                                         |
| ---------------- | -------- | ------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 建立委託         | NPA-B05  | `/MPG/period`             | ✅     | Version 1.5. Hosted-page form (`MerchantID_` + `PostData_`, **no TradeSha**). Schedule validated locally (PeriodType/PeriodPoint ranges, PeriodFirstdate only with D+startType 3, PeriodTimes 1–99 or `NE`); notifyUrl is adapter-required — it is the only programmatic delivery of PeriodNo |
| 委託建立結果通知 | §4.3.2   | ReturnURL / NotifyURL     | ✅     | `verifyPeriodCreateNotify` — manual's encrypted blob replayed verbatim in tests                                                                                                                                                                                                               |
| 每期授權結果通知 | NPA-N050 | mandate NotifyURL         | ✅     | `verifyPeriodCycleNotify` — parses `OrderNo = MerchantOrderNo_期數`; failures fire too (AlreadyTimes counts them); may arrive urlencoded OR multipart                                                                                                                                         |
| 修改委託狀態     | NPA-B051 | `/MPG/period/AlterStatus` | ✅     | Version 1.0. suspend/terminate/restart; response key is lowercase `period` (both casings accepted)                                                                                                                                                                                            |
| 修改委託內容     | NPA-B052 | `/MPG/period/AlterAmt`    | ✅     | Version 1.2. periodType+periodPoint enforced as a pair; cardExpiry (`Extday`, response `ExtDay`) requires periodTimes                                                                                                                                                                         |
| CAU 卡片更新通知 | §4.3.4   | fixed CAU URL             | ❌     | Requires the opt-in CAU merchant service (fixed registered URL); add with a CAU merchant                                                                                                                                                                                                      |

## Testing status

- **Crypto**: every formula (AES-CBC pad-16 + tolerant 1..32 unpad, TradeSha,
  CheckValue, CheckCode) pinned to golden vectors from both manuals + OSS test
  suites — including the padding-deciding BNPL-refund vector and both NDNP
  blobs. Known-bad manual vectors (EWallet, BNPL settle — foreign-shop keys)
  documented in crypto.test.ts and deliberately untested.
- **Offline**: MSW suites for both factories; fixtures replay the manuals'
  gateway-produced ciphertexts verbatim, synthesized fixtures follow the field
  tables and carry re-recording instructions.
- **Live**: `pnpm test:live:newebpay` (+`:period`) smoke the sandbox with the
  merchant's own credentials: checkout-form round-trip, one query, one
  cancel-auth, one alterStatus — each expecting either normalized data or a
  coded, mapped PaymentError. ⚠️ QueryTradeInfo locks for 4 h (TRA10071) after
  too many not-found queries in 1 h; the suites fire one each per run.
  **Verified against ccore 2026-08-07** (real merchant credentials, PAID*DEBUG
  recordings): query on a bogus order → `{"Status":"TRA10021","Message":
"查無交易資料","Result":[]}` (error shape carries an empty `Result` array);
  Cancel on a bogus order → TRA10021 with a `Result` OBJECT whose CheckCode is
  computed over the empty MerchantOrderNo/TradeNo strings; AlterStatus on a
  bogus mandate → PER10067 delivered INSIDE the encrypted `period` envelope.
  All three prove CheckValue signing, the PostData* envelope, and periodic
  response decryption end-to-end against the real gateway.
- **E2E creation verified 2026-08-08**: a real VACC order was created through
  the MPG page by browser automation (localhost-served auto-submit form — the
  file:// scheme is blocked but a local HTTP origin passes the MPG02005 source
  check), the 取號 result POSTed to CustomerURL (webhook.site) verified with
  `verifyGetCodeNotify`, and the order queried live (TradeStatus 0 +
  `PayInfo "(004)TestAccount12345"`). Recording deltas folded into fixtures:
  unpaid `PayTime` arrives as the ZERO-DATE `0000-00-00 00:00:00` (not empty),
  and the get-code `ExpireTime` arrives coloned (`23:59:59`), not `His`.
  The order was then paid via 會員專區 模擬觸發: the paid notify arrived at
  NotifyURL (verified — VACC extras PayBankCode/PayerAccount5Code present) and
  the re-query showed TradeStatus 0→1 with FundTime populated and the
  CheckCode unchanged (it signs only Amt/MerchantID/MerchantOrderNo/TradeNo).
  ⚠️ NewebPay marks a simulated payment ONLY in the Message text
  (`模擬付款成功`) — there is no SimulatePaid-style flag, so shipping decisions
  must not rely on distinguishing simulated from real notifies by shape.
  ⚠️ The 1Password extension's inline card-save overlay steals browser-automation
  focus on the credit-card form — use VACC/WebATM flows for automated runs, or
  a profile without password-manager extensions for card runs.
- **Paid-notify recording**: MPG and the mandate page are browser-only —
  record real paid notifies via tunnel + sandbox test card
  `4000-2211-1111-1111` (any expiry/CVC); VACC/CVS/BARCODE support 模擬觸發
  from 會員專區 → 銷售記錄查詢 after taking a code. LINE Pay needs a real
  scan; UnionPay is not testable in the sandbox.

## Deviations / traps found while implementing

- Three near-identical integrity formulas (TradeSha vs CheckValue vs
  CheckCode) differ in labels, label order, AND field sets — see
  `src/crypto.ts` header table.
- The current manual pads AES to 16 bytes but the legacy official PHP sample
  (copied by most OSS SDKs) pads to 32; the gateway strips by last-byte value.
  Decrypt must therefore disable auto-unpad and accept pad 1..32.
- Manual sample defects: the EWallet request/response and BNPL-settle vectors
  were generated under a different shop's HashKey/HashIV (unverifiable by
  anyone); p.19's PHP source and printed output disagree on NotifyURL; the
  notify example carries an undocumented `Exp` field; p.59 spells wallet
  PaymentMethod values EZALIPAY/EZWECHAT vs PaymentType EZPALIPAY/EZPWECHAT.
- NDNP casing wobbles: `Period` vs `period` envelope key, `MerchantOrderNo`
  vs `MerOrderNo`, request `Extday` vs response `ExtDay` — all tolerated.
- ReturnURL and NotifyURL must NOT share one URL (double-delivery corrupts
  order accounting) — rejected locally at create.
- TimeStamp tolerance is ±120 s — clock skew kills requests server-side.
