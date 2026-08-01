# `@paid-tw/payment-ecpay`

ECPay 綠界 All-in-One adapter for [`@paid-tw/payment`](../payment).

Implements `PaymentProvider` with:

- **createPayment** → AioCheckOut V5 **redirect** form (`mode: "redirect"`; always `NeedExtraPaidInfo=Y`)
- **getPayment** → QueryTradeInfo/V5
- **refundPayment** / **capturePayment** / **cancelClose** / **abandonPayment** → DoAction R/C/E/N
- **creditDoAction** → low-level DoAction
- **queryCreditTrade** → CreditDetail/QueryTrade/V2（需 `creditCheckCode`）
- **verifyPaymentNotify** → ReturnURL / OrderResultURL CheckMacValue verify

## Usage

```ts
import { createEcpayProvider, ECPAY_SANDBOX, ECPAY_NOTIFY_ACK } from "@paid-tw/payment-ecpay";

const ecpay = createEcpayProvider({
  ...ECPAY_SANDBOX, // or your production credentials
});

// 1) Create — returns a redirect form, never "already paid"
const form = await ecpay.createPayment({
  amount: 1000,
  currency: "TWD",
  method: "card",
  orderId: "ORDER123",
  notifyUrl: "https://example.com/ecpay/notify", // ReturnURL
  returnUrl: "https://example.com/ecpay/result", // OrderResultURL (optional)
});
// form.mode === "redirect" — auto-submit form.action + form.params in the browser.

// 2) ReturnURL handler (server POST from ECPay)
//    body = application/x-www-form-urlencoded fields
app.post("/ecpay/notify", (req, res) => {
  const notify = ecpay.verifyPaymentNotify(req.body);
  if (notify.success && !notify.simulated) {
    // mark order paid (idempotent on notify.merTradeNo)
  }
  res.type("text/plain").send(ECPAY_NOTIFY_ACK); // must be exactly "1|OK"
});
```

## 公開測試特店（stage）

綠界在文件公布的**模擬銀行 3D 驗證 / 中租無卡分期**測試特店（明碼，可直接用於整合測試）：

| 項目       | 值                                   |
| ---------- | ------------------------------------ |
| MerchantID | `3002607`                            |
| HashKey    | `pwFHCqoQZGmho4w6`                   |
| HashIV     | `EkRm7iFT261dpevs`                   |
| 統一編號   | `00000000`                           |
| 後台帳號   | `stagetest3`                         |
| 後台密碼   | `test1234`                           |
| 金流 stage | `https://payment-stage.ecpay.com.tw` |
| 特店後台   | `https://vendor-stage.ecpay.com.tw`  |

SDK 常數：`ECPAY_SANDBOX`、`ECPAY_SANDBOX_PORTAL`（後台登入僅供人工 QA，API 不用）。

手動刷卡測試（stage 收銀台）：卡號 `4311-9522-2222-2222`，3D OTP `1234`。

## 測試：MSW + live

| 模式               | 指令                                                           | 說明                                                            |
| ------------------ | -------------------------------------------------------------- | --------------------------------------------------------------- |
| **MSW（預設 CI）** | `pnpm test` 或 `pnpm --filter @paid-tw/payment-ecpay test:msw` | 離線；用錄製的 stage 回應 + 同一組 3002607 金鑰驗 CheckMacValue |
| **Live**           | `ECPAY_LIVE=1 pnpm test:live:ecpay`                            | 打真實 `payment-stage`；預設即用公開特店，不必設 env            |

```bash
# 離線（MSW）
pnpm --filter @paid-tw/payment-ecpay test:msw

# 真實 stage
ECPAY_LIVE=1 pnpm test:live:ecpay

# 查一筆你在 stage 完成付款的訂單 + 印 raw
ECPAY_LIVE=1 ECPAY_QUERY_ID=yourMerTradeNo PAID_DEBUG=1 pnpm test:live:ecpay
```

MSW 的 default handlers 會對已知 `MerchantTradeNo` 重放 field-exact fixtures（與 live 同一組 HashKey/HashIV），方便在無網路時重現 stage 行為。

## 三套 API 與區隔方式

綠界金流有三條產品線，**同一 npm 套件、三個 factory、三個 `name`**（詳見
[`docs/ecpay-provider-separation.md`](../../docs/ecpay-provider-separation.md)）：

| 系列                  | Factory                      | `name`            | Host               | create 結果                                 |
| --------------------- | ---------------------------- | ----------------- | ------------------ | ------------------------------------------- |
| **全方位金流 (AIO)**  | `createEcpayProvider`        | `"ecpay"`         | `payment.ecpay…`   | `{ mode: "redirect", action, params }`      |
| **站內付 2.0 (ECPG)** | `createEcpayEcpgProvider`    | `"ecpay-ecpg"`    | `ecpg.ecpay…`      | `{ mode: "token", token, merchantTradeNo }` |
| **非信用卡幕後取號**  | `createEcpayPayCodeProvider` | `"ecpay-paycode"` | `ecpayment.ecpay…` | `{ mode: "paycode", atm/cvs/barcode }`      |

```ts
import { createEcpayEcpgProvider, ECPAY_SANDBOX } from "@paid-tw/payment-ecpay";

const ecpg = createEcpayEcpgProvider({ ...ECPAY_SANDBOX });

// 1) Server: GetTokenbyTrade
const { token, merchantTradeNo } = await ecpg.createPayment({
  amount: 100,
  currency: "TWD",
  method: "card",
  orderId: "ORDER123",
  notifyUrl: "https://example.com/notify",
  email: "buyer@example.com",
});

// 2) Browser: ECPay JS SDK createPayment(token) → getPayToken()
// 3) Server: CreatePayment
const paid = await ecpg.createPaymentWithPayToken({
  payToken: "...",
  merchantTradeNo,
});
// paid.threeDUrl? → full-page 3DS; or atm/cvs take-number fields

// 4) ReturnURL — JSON + AES Data（與 AIO form CheckMac 不同）
app.post("/ecpay/ecpg/notify", (req, res) => {
  const notify = ecpg.verifyPaymentNotify(req.body);
  if (notify.success && !notify.simulated) {
    // mark paid (idempotent on notify.merTradeNo)
  }
  res.type("text/plain").send(ECPG_NOTIFY_ACK); // "1|OK"
});
```

前端 JS 與樣式不在此 Node SDK 範圍內，請依綠界站內付 2.0 Web 文件載入官方 SDK。

## 非信用卡幕後取號（背景取號）

不跳轉綠界頁面，後端直接拿到 ATM 虛擬帳號 / 超商代碼 / 超商條碼，再自行交付消費者
（Email / SMS / 自家頁面）。信用卡不走這條，請用幕後授權 BackAuth。

```ts
import {
  createEcpayPayCodeProvider,
  ECPAY_PAYCODE_NOTIFY_ACK,
  ECPAY_SANDBOX,
} from "@paid-tw/payment-ecpay";

const paycode = createEcpayPayCodeProvider({ ...ECPAY_SANDBOX });

// 取號：回應就帶著繳費資訊，沒有 redirect
const atm = await paycode.createPayment({
  amount: 1234,
  currency: "TWD",
  method: "atm", // "atm" | "cvs" | "barcode"
  orderId: "ORDER123",
  itemDesc: "測試商品",
  notifyUrl: "https://example.com/ecpay/paycode/notify", // ReturnURL，必填
  expireDate: 3, // ⚠️ 單位依付款方式而異，見下表
  atmBankCode: "822", // ATM 選填：指定繳費銀行
});
// atm.atm → { bankCode: "822", vAccount: "9251…", expireDate: "2026/08/04" }
// atm.status === "unpaid" — 取號成功不等於已付款

// 查詢：訂單狀態 vs 繳費資訊是兩支 API
const state = await paycode.getPayment({ merTradeNo: "ORDER123" }); // QueryTrade
const code = await paycode.getPaymentCode({ merTradeNo: "ORDER123" }); // QueryPaymentInfo

// ReturnURL — AES-JSON 進來，但要回純字串 "1|OK"
app.post("/ecpay/paycode/notify", (req, res) => {
  const notify = paycode.verifyPaymentNotify(req.body);
  if (notify.success && !notify.simulated) {
    // mark paid (idempotent on notify.merTradeNo)
  }
  res.type("text/plain").send(ECPAY_PAYCODE_NOTIFY_ACK); // "1|OK"
});
```

### 各付款方式差異

| method      | ChoosePayment | `expireDate` 單位 | 預設  | 範圍    | 回傳                               |
| ----------- | ------------- | ----------------- | ----- | ------- | ---------------------------------- |
| `"atm"`     | `ATM`         | **天**            | 3     | 1–60    | `atm.bankCode` + `atm.vAccount`    |
| `"cvs"`     | `CVS`         | **分鐘**          | 10080 | 1–43200 | `cvs.paymentNo` + `cvs.paymentUrl` |
| `"barcode"` | `BARCODE`     | **天**            | 7     | 1–30    | `barcode.barcode1/2/3`             |

`expireDate` 單位不同是最容易踩的雷，adapter 會先驗證再送出——把 CVS 的分鐘數當成
ATM 天數傳，會拿到完全不同期限的帳號。超過 30 天需另向綠界申請特約賣家。

### 使用時要知道的事

- **無線上退款**：ATM / 超商代碼 / 超商條碼都是消費者付現，綠界沒有退款 API，
  `refundPayment()` 一律丟 `UNSUPPORTED`。要退款請走廠商後台人工處理。
- **繳費資訊只在取號時回傳一次**，務必自行保存；忘了存只能用
  `getPaymentCode()`（QueryPaymentInfo）補回來——`getPayment()`（QueryTrade）的
  `ATMInfo` 是「付款人」帳號後五碼，不是虛擬帳號。
- **超商條碼的付款通知會延遲約 2 天**（超商端作業時間），barcode 訂單卡在未付款
  不代表消費者沒繳。
- **`SimulatePaid: 1`** 代表這是廠商後台按「模擬付款」發出的測試通知，綠界不會撥款，
  出貨就是實際損失——所以判斷條件是 `success && !simulated`。
- 條碼只回三段號碼，不回圖檔，需自行轉 Code39。`barcode1` 不是純數字
  （實測 `1508086CY`）。

完整缺口表：[`docs/ecpay-api-coverage.md`](../../docs/ecpay-api-coverage.md)。
