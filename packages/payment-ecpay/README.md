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

## 四套 API 與區隔方式

綠界金流有四條產品線，**同一 npm 套件、四個 factory、四個 `name`**（詳見
[`docs/ecpay-provider-separation.md`](../../docs/ecpay-provider-separation.md)）：

| 系列                  | Factory                                              | `name`             | Host               | create 結果                                   |
| --------------------- | ---------------------------------------------------- | ------------------ | ------------------ | --------------------------------------------- |
| **全方位金流 (AIO)**  | `createEcpayProvider`                                | `"ecpay"`          | `payment.ecpay…`   | `{ mode: "redirect", action, params }`        |
| **站內付 2.0 (ECPG)** | `createEcpayEcpgProvider`                            | `"ecpay-ecpg"`     | `ecpg.ecpay…`      | `{ mode: "token", token, merchantTradeNo }`   |
| **非信用卡幕後取號**  | `createEcpayPayCodeProvider`                         | `"ecpay-paycode"`  | `ecpayment.ecpay…` | `{ mode: "paycode", atm/cvs/barcode }`        |
| **信用卡幕後授權** ⚠️ | `createEcpayBackAuthProvider`（`/backauth` subpath） | `"ecpay-backauth"` | `ecpayment.ecpay…` | `{ mode: "3ds" }` 或 `{ mode: "authorized" }` |

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
- **不要用 `TradeStatus` 判斷付款成功**。實測模擬付款的通知是 `RtnCode: 1` +
  真的 `PaymentDate`，但 `TradeStatus` 還是 `"0"`（綠界明說模擬付款不改付款狀態），
  拿 `TradeStatus === "1"` 當條件會直接漏掉這筆通知。
- 條碼只回三段號碼，不回圖檔，需自行轉 Code39。`barcode1` 不是純數字
  （實測 `1508086CY`）。

### 超商代碼轉三段式條碼

消費者不想在超商機台輸入代碼時，可以把 `paymentNo` 轉成可掃的三段條碼：

```ts
const bar = await paycode.getCvsBarcode({ paymentNo: "LLL26213917403", chain: "iBon" });
// bar.barcode1/2/3 + bar.expireDate
```

⚠️ **每家超商的條碼不一樣**（實測：同一個 `paymentNo` 三家回傳的 `Barcode1`/`Barcode3`
全不同，`Barcode2` 在 iBon 是一組 token、全家/萊爾富則是補零後的代碼）。所以要先知道
消費者去哪家，不能拿一家的條碼去另一家用。

其他限制：`chain` 只支援 `Family` / `Hilife` / `iBon`（**取號時**的 `CVS`、`OK` 不支援
轉條碼；而且注意大小寫是 `iBon` 不是取號用的 `IBON`），訂單已付款或已過期會失敗，
每次轉換有效 10 分鐘。

### 下載撥款對帳檔

```ts
const media = await paycode.downloadTradeMedia({
  dateType: "1", // 1=結算日期 2=撥款日期
  beginDate: "2026-07-01",
  endDate: "2026-07-31", // 區間最大 1 個月
  paymentType: "04", // 選填：03 ATM / 04 超商代碼 / 05 超商條碼
});

import { parseTradeMediaCsv } from "@paid-tw/payment-ecpay";
const rows = parseTradeMediaCsv(media.csv);
```

⚠️ **這支 API 回傳 CSV，不是 AES 信封**，而且**每個欄位都被包成 `="值"`**（Excel 強制
文字的寫法，避免長交易編號被轉成科學記號）。直接 `split(",")` 會拿到字面上帶
`="…"` 的內容，請用 `parseTradeMediaCsv()`。

實測還有兩點文件沒寫：真實檔案有**第 13 個欄位 `金流處理費`**（文件只列 12 個），
`Content-Type` 是 `text/plain`。查無資料時回傳只有標題列，不是錯誤。

綠界端另有限制：**呼叫 IP 需在廠商後台加白名單**（系統開發管理 → 系統介接設定），
且**一分鐘只能下載一個檔**。呼叫太快會拿到 HTTP 403，要等 30 分鐘。

### 錄製真實的付款通知

通知沒辦法用測試觸發——綠界只在真的有人繳費、或有人在後台按「模擬付款」時才發，
而且只發到公開可達的 HTTPS 網址。要重新錄製：

```bash
pnpm capture:ecpay-notify                        # :8787，收到就解密印出，並回 "1|OK"
cloudflared tunnel --url http://localhost:8787   # 另一個 shell，取得公開 URL
```

然後把 `notifyUrl` 指向該 URL 取號，再到
[vendor-stage](https://vendor-stage.ecpay.com.tw) 的
**一般訂單查詢 → 全方位金流訂單** 找到那筆訂單按「模擬付款」。腳本印出來的內容可以
直接貼進 `paycode-fixtures.ts`。

⚠️ 模擬付款**不會**產生 `TradeStatus: "1"`，也不會帶繳費門市——那個形狀只有真的去
超商繳費才拿得到。

完整缺口表：[`docs/ecpay-api-coverage.md`](../../docs/ecpay-api-coverage.md)。

## 信用卡幕後授權（BackAuth）⚠️ 收原始卡號

### 先讀這段：PCI-DSS 範圍

**這是本套件唯一會碰到原始卡號的 adapter。** 其他三條（AIO、站內付 2.0、幕後取號）卡號
都不會經過你的主機，所以你落在 PCI-DSS **SAQ A**；一旦自己收卡號，就變成 **SAQ D**，
稽核與基礎架構的要求完全不同等級。

範圍是由「**你是否處理卡號**」決定，不是由「程式碼在不在 bundle 裡」決定 —— 所以只要
不呼叫 `createEcpayBackAuthProvider`，你仍然在 SAQ A。

不過 BackAuth **不從套件根目錄匯出**，而是放在自己的 subpath：

```ts
import { createEcpayBackAuthProvider } from "@paid-tw/payment-ecpay/backauth";
```

這樣你可以**只靠 import graph 就證明**某個 app 不含 raw-PAN 介面 —— 稽核時是個機械可查的
答案，而不是一句「我們沒有用到」。根目錄的 `@paid-tw/payment-ecpay` 只有另外三條卡號不
經手的 adapter。

請確定你真的需要「後端直接拿卡號授權、消費者不看任何付款頁」這個能力，而不是因為它
用起來比較方便。如果只是要收信用卡，用 AIO 或站內付 2.0。

綠界端另有前置條件：需**申請關閉 OTP** 並**申請開啟信用卡 3D 驗證**才能使用。

### 用法

```ts
// 注意 import 路徑：BackAuth 在 /backauth subpath，不在套件根目錄
import { createEcpayBackAuthProvider, ECPAY_SANDBOX_NO_3D } from "@paid-tw/payment-ecpay/backauth";

const backauth = createEcpayBackAuthProvider({ ...ECPAY_SANDBOX_NO_3D });

const result = await backauth.createPayment({
  amount: 199,
  currency: "TWD",
  method: "card",
  orderId: "ORDER123",
  itemDesc: "測試商品",
  notifyUrl: "https://example.com/ecpay/backauth/notify",
  orderResultUrl: "https://example.com/ecpay/backauth/result", // ⚠️ 必填，見下
  card: { cardNo: "4311952222222222", expiryMonth: "12", expiryYear: "30", cvv: "222" },
  phone: "886912345678",
  cardholderName: "TEST USER",
});

// ⚠️ 一定要先看 mode，不要先看 RtnCode
if (result.mode === "3ds") {
  redirectFullPage(result.threeDUrl); // 不可用 iframe
} else {
  console.log(result.success, result.card?.card4No, result.card?.gwsr);
}
```

### 四個實測踩到的雷

1. **3D 驗證的回應「沒有 `RtnCode`」。** 只有 `ThreeDURL`、`MerchantID`、
   `MerchantTradeNo` 三個欄位。文件 45958 的 3D 章節有列 RtnCode，所以「先檢查
   `RtnCode === 1`、再看 ThreeDURL」這個最直覺的寫法**會把正常的 3DS 轉導判成失敗**。
   這就是回傳值設計成 discriminated union 的原因。
2. **`OrderResultURL` 實際上必填**，文件沒標必填。沒帶會拿到
   `RtnCode 5000029`，連 3D 關閉的特店也一樣。
3. **`MerchantID` 在 3D 分支是數字、在授權分支是字串。** 同一支 API 同一個欄位。
4. **刷卡失敗回 `RtnCode 10100058`，而這個號碼在「幕後取號」的代碼表裡是
   「ATM 繳費期限已過」。** 綠界的錯誤碼跨服務會撞號，所以錯誤表必須分服務維護。

### 請退款只有正式環境

`creditDoAction()`（`C` 關帳 / `R` 退刷 / `E` 取消 / `N` 放棄）與 `refundPayment()`
**只能在正式環境用** —— 綠界明講測試環境無法提供實際授權、因此不開放這支 API。所以
sandbox 設定下 adapter 會直接丟 `UNSUPPORTED`，不會發一個註定 404 的請求。

`refundPayment()` 需要你自己帶 `tradeNo`（綠界交易編號），不會偷偷先查一次 —— 退款
路徑上多一次查詢值得講清楚。`tradeNo` 從授權結果（`result.tradeNo`）或 notify
（`notify.tradeNo`）拿，**請保存它**。

⚠️ 別跟 `gwsr` 搞混：`gwsr`（notify 的 `creditRefundId`）是銀行授權碼，DoAction
**不吃這個欄位**（文件 45919 的請求參數只有 MerchantID / MerchantTradeNo / TradeNo /
Action / TotalAmount）。`gwsr` 是「信用卡單筆明細查詢」和對帳用的，那支 API 本 adapter
尚未實作。

### 測試卡與測試特店

`ECPAY_TEST_CARD` = `4311952222222222` / CVV `222`（綠界公開，非真卡）。有效月年必須
**晚於當下**，所以測試要自己算，不要寫死年份。

`ECPAY_SANDBOX_NO_3D` = 特店 `2000132`（3D **關閉**）。要測「直接授權成功」必須用它 ——
預設的 `ECPAY_SANDBOX`（3002607）3D 是開的，每次都只會回 `ThreeDURL`。

⚠️ adapter **刻意不做 Luhn 檢查**：綠界自己的測試卡號 Luhn 是不通過的，加了會讓官方
測試卡不能用。只驗長度與數字。
