# ECPay API coverage map

Sources (official):

- [全方位金流 API 技術文件](https://developers.ecpay.com.tw/?p=2509) — AIO redirect cashier
- [站內付 2.0 Web](https://developers.ecpay.com.tw/?p=8972) — embedded payment (ECPG)
- [SDK_PHP `example/Payment/Aio`](https://github.com/ECPay/SDK_PHP/tree/master/example/Payment/Aio)
- [SDK_PHP `example/Payment/Ecpg`](https://github.com/ECPay/SDK_PHP/tree/master/example/Payment/Ecpg)
- [ECPayAIO_Python `sample/`](https://github.com/ECPay/ECPayAIO_Python/tree/master/sample)

Package today: `@paid-tw/payment-ecpay` implements a **subset of 全方位金流 (AIO)** only.

## Two product lines (do not mix)

| | 全方位金流 **AIO** | 站內付 2.0 **ECPG** |
| --- | --- | --- |
| Docs | [p=2509](https://developers.ecpay.com.tw/?p=2509) | [p=8972](https://developers.ecpay.com.tw/?p=8972) |
| UX | Redirect to ECPay cashier page | Embed ECPay payment UI on merchant site (JS SDK) |
| Host (stage) | `payment-stage.ecpay.com.tw` | `ecpg-stage.ecpay.com.tw` (+ AES ops on `ecpayment-stage…` for some credit actions) |
| Wire format | `application/x-www-form-urlencoded` + **CheckMacValue** (SHA256) | JSON envelope `MerchantID` + `RqHeader` + AES-encrypted **`Data`** |
| Create flow | Auto-submit form → `Cashier/AioCheckOut/V5` | Server `GetTokenbyTrade` → browser `ECPay.createPayment(Token)` → `getPayToken` → server `CreatePayment` |
| PCI | Card data never on merchant (cashier hosted) | Card UI hosted by ECPay JS (no PCI-DSS for merchant) |
| Official PHP samples | `example/Payment/Aio/*` | `example/Payment/Ecpg/*` |
| Official Python samples | `ECPayAIO_Python/sample/*` | (not in AIO_Python repo) |

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

| Sample / doc scenario | ChoosePayment | Status | Notes |
| --- | --- | --- | --- |
| ALL | ALL | 🟡 | We map unknown methods → `ALL`; no `IgnorePayment` / language / custom fields |
| Credit 一次付清 | Credit | ✅ | via `method: "card"` |
| Credit 分期 | Credit + installment params | ❌ | Python/PHP `CreateInstallmentOrder` |
| Credit 定期定額 | Credit + period params | ❌ | `CreatePeriodicOrder` / `CreditCardPeriodAction` |
| ATM | ATM | ✅ | method `atm` → ChoosePayment ATM |
| CVS | CVS | ✅ | method `cvs` |
| BARCODE | BARCODE | ❌ | no method enum yet |
| WebATM | WebATM | ❌ | |
| Apple Pay | ApplePay | ❌ | |
| TWQR | TWQR | ❌ | |
| BNPL 無卡分期 | BNPL | ❌ | |
| WeiXin | WeiXin | ❌ | |
| Digital / Google Pay (legacy samples) | varies | ❌ | |
| Extra create params | — | 🟡 | We set core fields + OrderResultURL/ClientBackURL; missing StoreID, Remark, IgnorePayment, NeedExtraPaidInfo, CustomField*, Language, PlatformID, ChooseSubPayment, ItemURL |

### Server lifecycle (AIO)

| Operation | Endpoint (typical) | Sample | Status |
| --- | --- | --- | --- |
| CheckMacValue sign/verify | — | all Aio | ✅ golden tests + stage live |
| Query order | `Cashier/QueryTradeInfo/V5` | `QueryTrade.php` / `sample_order_search.py` | ✅ |
| Credit DoAction refund (R) | `CreditDetail/DoAction` | `sample_credit_do_action.py` | ✅ `refundPayment` |
| Credit DoAction capture/close (C) | same | Capture (AIO form style) | ✅ `capturePayment` |
| Credit DoAction cancel (E) / abandon (N) | same | docs p=2885 | ✅ `cancelClose` / `abandonPayment` |
| Period order action | period APIs | `CreditCardPeriodAction` | ❌ |
| Query credit single detail | credit detail API | `QueryCreditTrade` | ✅ `queryCreditTrade` (needs creditCheckCode; prod-oriented) |
| Query period trade | | `QueryPeridicTrade` | ❌ |
| Query ATM/CVS/BARCODE payment info | | `QueryPaymentInfo` | ❌ |
| Download reconcile / disbursement CSV | | Download* samples | 🔌 |
| **Verify payment notify (ReturnURL)** | inbound POST | `GetCheckoutResponse.php` | ✅ `verifyPaymentNotify` + `ECPAY_NOTIFY_ACK` |
| **Verify client OrderResultURL** | inbound POST | same shape | ✅ same helper (shared payload) |

### AIO create optional product knobs (from Python credit sample)

Not exposed on `CreatePaymentRequest` today: `BindingCard`, `MerchantMemberID`, `Redeem`, `UnionPay`, invoice-on-payment (`InvoiceMark` + inv fields).

---

## ECPG (站內付 2.0) — coverage vs official samples

**Status: entirely missing** from `@paid-tw/payment-ecpay`.

| Sample | Server API (stage host) | Status |
| --- | --- | --- |
| `Create*Order/GetToken.php` | `POST ecpg-stage…/Merchant/GetTokenbyTrade` | ❌ |
| `CreateOrder.php` (after PayToken) | `POST ecpg-stage…/Merchant/CreatePayment` | ❌ |
| `CreateAllOrder` / Credit / ATM / CVS / Barcode / Installment / ApplePay / UnionPay | GetToken variants + WebJS | ❌ |
| `CreatePaymentWithCardID.php` | pay with bound card | ❌ |
| `CreateBindCard.php` / bind-card order / delete / query member cards | card-on-file | ❌ |
| `GetTokenbyBindingCard.php` | | ❌ |
| `Capture.php` | `ecpayment-stage…/1.0.0/Credit/DoAction` **AES JSON** | ❌ (different host/crypto than AIO form DoAction) |
| `QueryTrade` / `QueryCreditTrade` / `QueryPaymentInfo` / `QueryTradeMedia` / period | ECPG query family | ❌ |
| `GetResponse.php` / notify verify | AES JSON response verify | ❌ |
| Frontend `WebJS.html` + `ECPay.createPayment` | browser SDK | 🔌 document only (out of Node SDK scope) |

### ECPG server flow (must implement for “完整站內付”)

1. **GetTokenbyTrade** — AES JSON; returns `Token` for JS SDK  
2. Merchant page loads ECPay JS → `createPayment(Token)` → user pays → `getPayToken()`  
3. **CreatePayment** — server sends `PayToken` + `MerchantTradeNo`  
4. Optional 3DS URL redirect for cards  
5. **ReturnURL** notify (verify AES envelope)  
6. Credit lifecycle via ECPG AES DoAction where required  

Crypto stack ≠ AIO CheckMacValue: PHP uses `PostWithAesJsonResponseService` (AES encrypt `Data`, JSON RqHeader).

---

## Mapping to `@paid-tw/payment` core

| Core method | AIO today | ECPG (planned) |
| --- | --- | --- |
| `createPayment` | Redirect form (`mode: "redirect"`) | Should return `{ mode: "token", token, merchantTradeNo }` or separate `createCheckoutToken()` |
| `getPayment` | QueryTradeInfo | ECPG QueryTrade (AES) or shared query if merchant uses both |
| `refundPayment` | DoAction R | ECPG Credit/DoAction AES |
| (extension) `verifyNotify` | CheckMacValue on form body | AES decrypt + validate Data |
| (extension) `capture` / `void` / `abandon` | DoAction C/E/N | AES DoAction |
| (extension) `createPaymentWithPayToken` | n/a | ECPG step 3 |

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

6. New package or `src/ecpg/*`: AES JSON client + `getTokenByTrade` + `createPaymentWithPayToken`.  
7. MSW fixtures from stage + live tests (same public merchant 3002607 where ECPG is enabled).  
8. Notify verify for AES callbacks.  
9. README for required frontend JS steps (out of Node SDK).  

### P3 — long tail

10. Period / installment / bind-card / reconcile downloads.  

---

## Checklist vs repos (summary counts)

| Area | Official sample count (approx.) | Implemented |
| --- | --- | --- |
| AIO create methods (Python samples) | ~14 create variants | ~4 (ALL/Credit/ATM/CVS via ChoosePayment) |
| AIO ops (query/refund/period/download/notify) | ~8 | 2 (query + refund R) |
| ECPG samples | ~25+ files/dirs | 0 |
| Crypto primitives | CMV + AES JSON | CMV only |

**Conclusion:** AIO **core path** (create redirect + query + credit refund R + MAC) is solid and stage-tested. Coverage is **not** complete against ECPay’s full surface: missing notify verification, full DoAction set, many payment methods/params, and the entire **站內付 2.0 / ECPG** stack.
