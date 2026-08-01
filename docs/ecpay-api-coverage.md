# ECPay API coverage map

Sources (official):

- [全方位金流 API 技術文件](https://developers.ecpay.com.tw/?p=2509) — AIO redirect cashier
- [站內付 2.0 Web](https://developers.ecpay.com.tw/?p=8972) — embedded payment (ECPG)
- [非信用卡幕後取號 API](https://developers.ecpay.com.tw/27950) — server-side ATM/CVS/BARCODE 取號
- [ECPay-API-Skill `references/` + `test-vectors/`](https://github.com/ECPay/ECPay-API-Skill) — every doc page as markdown (append `.md` to a page id, e.g. `28005.md`), plus official AES/CMV goldens
- [SDK_PHP `example/Payment/Aio`](https://github.com/ECPay/SDK_PHP/tree/master/example/Payment/Aio)
- [SDK_PHP `example/Payment/Ecpg`](https://github.com/ECPay/SDK_PHP/tree/master/example/Payment/Ecpg)
- [ECPayAIO_Python `sample/`](https://github.com/ECPay/ECPayAIO_Python/tree/master/sample)

Package today: `@paid-tw/payment-ecpay` implements a subset of **全方位金流 (AIO)**, the
core **站內付 2.0 (ECPG)** path, and the **非信用卡幕後取號** create + query + notify path.

## Three product lines (do not mix)

|                         | 全方位金流 **AIO**                                               | 站內付 2.0 **ECPG**                                                                                      |
| ----------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Docs                    | [p=2509](https://developers.ecpay.com.tw/?p=2509)                | [p=8972](https://developers.ecpay.com.tw/?p=8972)                                                        |
| UX                      | Redirect to ECPay cashier page                                   | Embed ECPay payment UI on merchant site (JS SDK)                                                         |
| Host (stage)            | `payment-stage.ecpay.com.tw`                                     | `ecpg-stage.ecpay.com.tw` (+ AES ops on `ecpayment-stage…` for some credit actions)                      |
| Wire format             | `application/x-www-form-urlencoded` + **CheckMacValue** (SHA256) | JSON envelope `MerchantID` + `RqHeader` + AES-encrypted **`Data`**                                       |
| Create flow             | Auto-submit form → `Cashier/AioCheckOut/V5`                      | Server `GetTokenbyTrade` → browser `ECPay.createPayment(Token)` → `getPayToken` → server `CreatePayment` |
| PCI                     | Card data never on merchant (cashier hosted)                     | Card UI hosted by ECPay JS (no PCI-DSS for merchant)                                                     |
| Official PHP samples    | `example/Payment/Aio/*`                                          | `example/Payment/Ecpg/*`                                                                                 |
| Official Python samples | `ECPayAIO_Python/sample/*`                                       | (not in AIO_Python repo)                                                                                 |

Plus a third line, **非信用卡幕後取號** (`ecpayment(-stage).ecpay.com.tw`): the AES-JSON
envelope of ECPG, but no browser step at all — the create response _is_ the payment
code. Credit card has its own sibling (幕後授權 `BackAuth`), not implemented.

|              | 非信用卡幕後取號                                                              |
| ------------ | ----------------------------------------------------------------------------- |
| Docs         | [27950](https://developers.ecpay.com.tw/27950)                                |
| UX           | none — merchant delivers the code (email/SMS/own page)                        |
| Host (stage) | `ecpayment-stage.ecpay.com.tw`                                                |
| Wire format  | same AES-JSON envelope as ECPG (`RqHeader` = `Timestamp` only, no `Revision`) |
| Create flow  | one call: `POST /1.0.0/Cashier/GenPaymentCode`                                |
| Methods      | ATM 虛擬帳號 / CVS 超商代碼 / BARCODE 超商條碼 (no card)                      |
| Refund       | **none** — ECPay ships no refund API for these; 廠商後台 by hand              |

**Implication for our monorepo:** keep AIO and ECPG as separate modules (or clear subpaths), e.g.

```
@paid-tw/payment-ecpay          # AIO (current)
@paid-tw/payment-ecpay-ecpg     # 站內付 2.0 server APIs (future)
# frontend: document ECPay JS SDK only — not a Node package responsibility
```

Do **not** overload `createPayment()` to mean both “redirect form” and “GetToken + CreatePayment” without an explicit mode/capability.

---

## AIO (全方位金流) — coverage vs official samples

Legend: ✅ implemented · 🟡 partial · ❌ missing · 🔌 optional / rarely needed for MVP

### Create order (AioCheckOut/V5)

| Sample / doc scenario                 | ChoosePayment               | Status | Notes                                                                                                                                                                        |
| ------------------------------------- | --------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ALL                                   | ALL                         | 🟡     | We map unknown methods → `ALL`; no `IgnorePayment` / language / custom fields                                                                                                |
| Credit 一次付清                       | Credit                      | ✅     | via `method: "card"`                                                                                                                                                         |
| Credit 分期                           | Credit + installment params | ❌     | Python/PHP `CreateInstallmentOrder`                                                                                                                                          |
| Credit 定期定額                       | Credit + period params      | ❌     | `CreatePeriodicOrder` / `CreditCardPeriodAction`                                                                                                                             |
| ATM                                   | ATM                         | ✅     | method `atm` → ChoosePayment ATM                                                                                                                                             |
| CVS                                   | CVS                         | ✅     | method `cvs`                                                                                                                                                                 |
| BARCODE                               | BARCODE                     | ❌     | no method enum yet                                                                                                                                                           |
| WebATM                                | WebATM                      | ❌     |                                                                                                                                                                              |
| Apple Pay                             | ApplePay                    | ❌     |                                                                                                                                                                              |
| TWQR                                  | TWQR                        | ❌     |                                                                                                                                                                              |
| BNPL 無卡分期                         | BNPL                        | ❌     |                                                                                                                                                                              |
| WeiXin                                | WeiXin                      | ❌     |                                                                                                                                                                              |
| Digital / Google Pay (legacy samples) | varies                      | ❌     |                                                                                                                                                                              |
| Extra create params                   | —                           | 🟡     | We set core fields + OrderResultURL/ClientBackURL; missing StoreID, Remark, IgnorePayment, NeedExtraPaidInfo, CustomField\*, Language, PlatformID, ChooseSubPayment, ItemURL |

### Server lifecycle (AIO)

| Operation                                | Endpoint (typical)          | Sample                                      | Status                                                       |
| ---------------------------------------- | --------------------------- | ------------------------------------------- | ------------------------------------------------------------ |
| CheckMacValue sign/verify                | —                           | all Aio                                     | ✅ golden tests + stage live                                 |
| Query order                              | `Cashier/QueryTradeInfo/V5` | `QueryTrade.php` / `sample_order_search.py` | ✅                                                           |
| Credit DoAction refund (R)               | `CreditDetail/DoAction`     | `sample_credit_do_action.py`                | ✅ `refundPayment`                                           |
| Credit DoAction capture/close (C)        | same                        | Capture (AIO form style)                    | ✅ `capturePayment`                                          |
| Credit DoAction cancel (E) / abandon (N) | same                        | docs p=2885                                 | ✅ `cancelClose` / `abandonPayment`                          |
| Period order action                      | period APIs                 | `CreditCardPeriodAction`                    | ❌                                                           |
| Query credit single detail               | credit detail API           | `QueryCreditTrade`                          | ✅ `queryCreditTrade` (needs creditCheckCode; prod-oriented) |
| Query period trade                       |                             | `QueryPeridicTrade`                         | ❌                                                           |
| Query ATM/CVS/BARCODE payment info       |                             | `QueryPaymentInfo`                          | ❌                                                           |
| Download reconcile / disbursement CSV    |                             | Download\* samples                          | 🔌                                                           |
| **Verify payment notify (ReturnURL)**    | inbound POST                | `GetCheckoutResponse.php`                   | ✅ `verifyPaymentNotify` + `ECPAY_NOTIFY_ACK`                |
| **Verify client OrderResultURL**         | inbound POST                | same shape                                  | ✅ same helper (shared payload)                              |

### AIO create optional product knobs (from Python credit sample)

Not exposed on `CreatePaymentRequest` today: `BindingCard`, `MerchantMemberID`, `Redeem`, `UnionPay`, invoice-on-payment (`InvoiceMark` + inv fields).

---

## ECPG (站內付 2.0) — coverage vs official samples

**Status: core path landed** as `createEcpayEcpgProvider` (`name: "ecpay-ecpg"`).  
See [ecpay-provider-separation.md](./ecpay-provider-separation.md).

| Sample                                                                              | Server API (stage host)                               | Status                                            |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------- |
| `Create*Order/GetToken.php`                                                         | `POST ecpg-stage…/Merchant/GetTokenbyTrade`           | ✅ `createPayment` → `mode: "token"`              |
| `CreateOrder.php` (after PayToken)                                                  | `POST ecpg-stage…/Merchant/CreatePayment`             | ✅ `createPaymentWithPayToken`                    |
| `CreateAllOrder` / Credit / ATM / CVS / Barcode / Installment / ApplePay / UnionPay | GetToken variants + WebJS                             | ❌                                                |
| `CreatePaymentWithCardID.php`                                                       | pay with bound card                                   | ❌                                                |
| `CreateBindCard.php` / bind-card order / delete / query member cards                | card-on-file                                          | ❌                                                |
| `GetTokenbyBindingCard.php`                                                         |                                                       | ❌                                                |
| `Capture.php`                                                                       | `ecpayment-stage…/1.0.0/Credit/DoAction` **AES JSON** | ❌ (different host/crypto than AIO form DoAction) |
| `QueryTrade` / `QueryCreditTrade` / `QueryPaymentInfo` / `QueryTradeMedia` / period | ECPG query family                                     | ❌                                                |
| `GetResponse.php` / notify verify                                                   | AES JSON response verify                              | ✅ `verifyEcpgPaymentNotify` / `ECPG_NOTIFY_ACK`  |
| Frontend `WebJS.html` + `ECPay.createPayment`                                       | browser SDK                                           | 🔌 document only (out of Node SDK scope)          |

### ECPG server flow (must implement for “完整站內付”)

1. **GetTokenbyTrade** — AES JSON; returns `Token` for JS SDK
2. Merchant page loads ECPay JS → `createPayment(Token)` → user pays → `getPayToken()`
3. **CreatePayment** — server sends `PayToken` + `MerchantTradeNo`
4. Optional 3DS URL redirect for cards
5. **ReturnURL** notify (verify AES envelope)
6. Credit lifecycle via ECPG AES DoAction where required

Crypto stack ≠ AIO CheckMacValue: PHP uses `PostWithAesJsonResponseService` (AES encrypt `Data`, JSON RqHeader).

---

## 非信用卡幕後取號 — coverage

**Status: create + query + notify landed** as `createEcpayPayCodeProvider`
(`name: "ecpay-paycode"`), under `src/paycode/*`, reusing `src/ecpg/{aes,client,notify}.ts`.

| Doc                                                                              | Endpoint (`ecpayment(-stage)…`)        | Status                                                     |
| -------------------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------- |
| [幕後取號 虛擬帳號 / 超商代碼 / 超商條碼](https://developers.ecpay.com.tw/28005) | `POST /1.0.0/Cashier/GenPaymentCode`   | ✅ `createPayment` → `mode: "paycode"` (all three methods) |
| [付款結果通知](https://developers.ecpay.com.tw/28010)                            | ReturnURL (AES-JSON in, `1\|OK` out)   | ✅ `verifyPaymentNotify` / `ECPAY_PAYCODE_NOTIFY_ACK`      |
| [查詢訂單](https://developers.ecpay.com.tw/28020)                                | `POST /1.0.0/Cashier/QueryTrade`       | ✅ `getPayment`                                            |
| [查詢 ATM/CVS/BARCODE 取號結果](https://developers.ecpay.com.tw/28025)           | `POST /1.0.0/Cashier/QueryPaymentInfo` | ✅ `getPaymentCode`                                        |
| [超商代碼 CVS 轉三段式條碼](https://developers.ecpay.com.tw/39086)               | `POST /1.0.0/Cashier/QueryCVSBarcode`  | ❌                                                         |
| [下載撥款對帳檔](https://developers.ecpay.com.tw/41186)                          | `POST /1.0.0/Cashier/QueryTradeMedia`  | ❌                                                         |
| 退款                                                                             | —                                      | 🚫 no API exists; `refundPayment` throws `UNSUPPORTED`     |

Stage-verified 2026-08-01 against merchant 3002607 (`paycode-live.test.ts`), with the
real payloads recorded into `paycode-fixtures.ts` — **including the ReturnURL
notifies**, captured through an HTTPS tunnel plus 廠商後台 模擬付款 (recipe in
`paycode-notify.test.ts`).

Deviations from the docs found while recording, all documented in that fixtures file:

- duplicate order is `RtnCode 10300028`, not AIO's `10200047`
- missing order is `10000185` under `TransCode: 1` — invisible to an envelope-only check
- a 模擬付款 notify sends `RtnCode: 1` with `TradeStatus` still `"0"`, so code gated on
  `TradeStatus === "1"` drops the notify it was written to test
- `CVSInfo.PaymentURL` uses a different host on the notify than at 取號 time
- `PayStoreID`/`PayStoreName` never appear on a simulated payment
- `ChargeFee` is fractional; `Barcode1` is not numeric
- `QueryTrade`'s `ATMInfo` is the payer (JSON `null`), not the virtual account
- `RtnMsg`/`TransMsg` have three different spellings across endpoints

Only shape still doc-derived: a **genuinely paid** notify (`TradeStatus: "1"` with
store fields), since 模擬付款 deliberately never settles.

---

## 信用卡幕後授權 (BackAuth) — coverage

**Status: core path landed** as `createEcpayBackAuthProvider` (`name: "ecpay-backauth"`),
under `src/backauth/*` and published on the **`@paid-tw/payment-ecpay/backauth`
subpath**, not the package root. ⚠️ **Raw-PAN adapter — PCI-DSS SAQ D**, unlike every
other adapter here; the separate entry point lets a build prove by import graph that it
excludes the card-accepting surface.

| Doc                                                          | Endpoint (`ecpayment(-stage)…`)         | Status                                                              |
| ------------------------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------- |
| [信用卡卡號交易授權](https://developers.ecpay.com.tw/45958)  | `POST /1.0.0/Cashier/BackAuth`          | ✅ `createPayment` → `mode: "3ds" \| "authorized"`                  |
| [付款結果通知](https://developers.ecpay.com.tw/45907)        | ReturnURL (AES-JSON, `1\|OK`)           | ✅ `verifyPaymentNotify`                                            |
| [查詢訂單](https://developers.ecpay.com.tw/45927)            | `POST /1.0.0/Cashier/QueryTrade`        | ✅ `getPayment`                                                     |
| [信用卡請退款](https://developers.ecpay.com.tw/45919)        | `POST /1.0.0/Credit/DoAction`           | ✅ `creditDoAction` — **production only**, stage does not expose it |
| [查詢信用卡發卡行](https://developers.ecpay.com.tw/49623)    | `/1.0.0/Cashier/QueryCardInfo`          | ❌                                                                  |
| [查詢信用卡單筆明細](https://developers.ecpay.com.tw/45925)  | `/1.0.0/CreditDetail/QueryTrade`        | ❌                                                                  |
| [定期定額查詢 / 作業](https://developers.ecpay.com.tw/46100) | `QueryTrade` / `CreditCardPeriodAction` | ❌ (create accepts the period fields; management does not)          |
| [下載撥款對帳檔](https://developers.ecpay.com.tw/45931)      | `/1.0.0/Cashier/QueryTradeMedia`        | ❌ (the 幕後取號 provider has the equivalent)                       |

Stage-verified 2026-08-01 against **both** published test merchants, since they take
different paths: `2000132` (3D off) authorizes directly, `3002607` (3D on) returns a
`ThreeDURL`. Deviations found, documented in `backauth-fixtures.ts`:

- the 3D response has **no `RtnCode`/`RtnMsg`** at all, so a RtnCode-first check
  rejects a valid hand-off
- `MerchantID` is a number on the 3D branch, a string on the authorized branch
- `OrderResultURL` is required in practice (`5000029` without it), undocumented as such
- a declined card returns `10100058`, which means something entirely different in the
  幕後取號 table — error tables must stay per-service
- `IssuingBank` is English on stage; `ChargeFee` fractional; `ProcessFee` present

Not implemented: 定期定額 management (`CreditCardPeriodAction`) and the BackAuth-side
`QueryTradeMedia`.

---

## 信用卡查詢 — one surface, documented twice

**Status: landed** as standalone functions in `src/credit/*`, exported from the package
**root** (neither takes card data: 單筆明細 takes order ids, 發卡行 takes a 6-9 digit BIN
prefix), and mirrored as methods on the 幕後授權 provider for convenience.

The important structural finding: ECPG and 幕後授權 **document the same `ecpayment`
endpoints twice**, so these are not two implementations.

| Doc                                                                                                         | Endpoint                                | Note                                                                                             |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------ |
| ECPG [9088](https://developers.ecpay.com.tw/9088) + 幕後授權 [45925](https://developers.ecpay.com.tw/45925) | `/1.0.0/CreditDetail/QueryTrade`        | same endpoint, two doc trees                                                                     |
| 幕後授權 [49623](https://developers.ecpay.com.tw/49623)                                                     | `/1.0.0/Credit/QueryCardInfo`           | 閘道商-only                                                                                      |
| ECPG [9093](https://developers.ecpay.com.tw/9093) 定期定額查詢                                              | `/1.0.0/Cashier/QueryTrade`             | **already the endpoint** paycode/BackAuth call — a response-shape difference, not a new endpoint |
| ECPG [12130](https://developers.ecpay.com.tw/12130) 定期定額作業                                            | `/1.0.0/Cashier/CreditCardPeriodAction` | open                                                                                             |

Stage-verified 2026-08-01 across **three** published merchants (`2000132` no-3D,
`3002607` with-3D, `3085779` 閘道商). Deviations found, documented in
`credit-fixtures.ts`:

- **`CloseData` is a top-level sibling of `RtnValue`, not nested inside it** — reading
  it from `RtnValue`, as the doc's layout suggests, yields an empty list forever
- **failure arrives as an `RtnCode` the doc never mentions** (`10000185`), while the doc
  describes a different protocol entirely (`RtnMsg` = `error_Stop`/`error_nopay`/`error`);
  success carries _neither_ — `RtnMsg: ""` and no RtnCode at all
- an unknown order, a non-credit order and a wrong-merchant order are **indistinguishable**
  (all 10000185)
- field casing is PascalCase here but snake/lowercase on the AIO form transport
- **zero-padding a BIN prefix is not semantically neutral** despite the doc telling you
  to pad: digits 7-9 select a co-branded product
- 查詢發卡行 is 閘道商-only (`5000095`), and an unknown BIN returns a generic `RtnCode: 0`

Not stage-reachable, so doc-derived and labelled: a **captured** order (`CloseData` as a
populated array), because capture needs `Credit/DoAction`, which stage does not expose.

---

## Mapping to `@paid-tw/payment` core

| Core method                                | AIO today                          | ECPG (planned)                                                                                |
| ------------------------------------------ | ---------------------------------- | --------------------------------------------------------------------------------------------- |
| `createPayment`                            | Redirect form (`mode: "redirect"`) | Should return `{ mode: "token", token, merchantTradeNo }` or separate `createCheckoutToken()` |
| `getPayment`                               | QueryTradeInfo                     | ECPG QueryTrade (AES) or shared query if merchant uses both                                   |
| `refundPayment`                            | DoAction R                         | ECPG Credit/DoAction AES                                                                      |
| (extension) `verifyNotify`                 | CheckMacValue on form body         | AES decrypt + validate Data                                                                   |
| (extension) `capture` / `void` / `abandon` | DoAction C/E/N                     | AES DoAction                                                                                  |
| (extension) `createPaymentWithPayToken`    | n/a                                | ECPG step 3                                                                                   |

Capabilities to add later:

- `CREATE_REDIRECT` (AIO)
- `CREATE_EMBEDDED_TOKEN` (ECPG GetToken)
- `CAPTURE` / `VOID` / `ABANDON`
- `VERIFY_NOTIFY`
- method-specific: `PERIOD`, `INSTALLMENT`, `BNPL`, …

---

## Priority roadmap (recommended)

### P0 — production AIO completeness

1. ~~**`verifyPaymentNotify`**~~ — done (`notify.ts`, PHP + doc goldens).
2. ~~create result `mode: "redirect"`~~ — done on `EcpayCheckoutForm`.
3. Expand `ChoosePayment` mapping: BARCODE, WebATM, ApplePay, TWQR, BNPL (and optional `IgnorePayment` when ALL). → still open (P0.5 / with method enum)

### P1 — AIO credit lifecycle

4. ~~DoAction **C / E / N**~~ — done (`creditDoAction` + capture/cancelClose/abandon).
5. ~~Query credit single detail~~ — done (`queryCreditTrade`).

### P2 — 站內付 2.0 (ECPG)

6. ~~AES JSON + GetToken + CreatePayment~~ — done under `src/ecpg/*`, factory `createEcpayEcpgProvider`.
7. Live tests against ecpg-stage (when merchant has ECPG enabled) — open.
8. ~~Notify verify for AES callbacks~~ — done (`verifyEcpgPaymentNotify`).
9. README frontend JS steps — partial (README + separation doc).

### P3 — long tail

10. Period / installment / bind-card / reconcile downloads.

---

## Checklist vs repos (summary counts)

| Area                                          | Official sample count (approx.) | Implemented                               |
| --------------------------------------------- | ------------------------------- | ----------------------------------------- |
| AIO create methods (Python samples)           | ~14 create variants             | ~4 (ALL/Credit/ATM/CVS via ChoosePayment) |
| AIO ops (query/refund/period/download/notify) | ~8                              | 2 (query + refund R)                      |
| ECPG samples                                  | ~25+ files/dirs                 | 3 (GetToken + CreatePayment + notify)     |
| 幕後取號 endpoints                            | 6                               | 6 (all — 取號, 3 queries, media, notify)  |
| Crypto primitives                             | CMV + AES JSON                  | both (AES pinned to ECPay's own vectors)  |

### P2.5 — 非信用卡幕後取號

- ~~GenPaymentCode (ATM/CVS/BARCODE) + QueryTrade + QueryPaymentInfo + notify~~ — done
  under `src/paycode/*`, stage-verified 2026-08-01.
- ~~Record real ReturnURL notifies~~ — done 2026-08-01 for all three methods via
  tunnel + 模擬付款.
- ~~QueryCVSBarcode (三段式條碼) and QueryTradeMedia (撥款對帳檔)~~ — done, both
  stage-verified 2026-08-01. Further doc deviations found: barcode segments are
  chain-specific; the 對帳檔 is Excel-armoured CSV with a 13th undocumented column.
- A truly-paid notify (`TradeStatus: "1"` + 繳費門市) still needs a real
  convenience-store payment; that one fixture stays doc-derived.

---

**Conclusion:** four paths are stage-tested — AIO core (create redirect + query +
credit refund R + MAC), ECPG core (GetToken + CreatePayment + notify), and
非信用卡幕後取號 (all 6 endpoints), and 信用卡幕後授權 (authorize + query + notify;
請退款 is production-only by ECPay's design). Coverage is still **not** complete against
ECPay's full surface: most ECPG card-on-file/period APIs, 定期定額 management,
`QueryCardInfo`, and many AIO payment methods/params remain missing.
