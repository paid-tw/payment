# @paid-tw/payment-zingala

中租零卡分期（Zingala，中租迪和）**無卡分期 / BNPL** 串接。

依據《中租零卡分期 API 串接技術手冊 1.1.14》（2023/11，非公開文件），並在 UAT 實際錄製回應驗證。

## 這個套件**不是** `PaymentProvider`

零卡分期是**核貸流程**，不是付款授權：

```
reserve_ec  →  消費者在 payment_url 申請  →  轉專員審核  →  核准  →  請款  →  撥款
   001                    002                    003        004      005
```

「成功」的終點是 **005 已撥款**，而那是核准後好幾天的事。硬套進 `createPayment` / `getPayment`，`status` 就得對「待審核」和「已撥款」說謊。所以這裡的方法名照核貸流程命名——`applyInstallment` 開的是一份**信用申請**，不是一筆授權。

> **跨供應商的共用介面還沒定。** BNPL 有多家（中租、AFTEE、oppay…），一致介面是目標，但目前只有中租一家有實錄資料；只憑一家推出來的「通用介面」實際上就是這一家換個通用名字。等第二家的真實流程進來再抽 `BnplProvider`。
>
> 已知**可能是中租獨有**、不該進共用契約的：`comfirm_url`（中租反過來問商家訂單還有效嗎）、`fee_type` vendor/consumer、期數利率表。

## 用法

```ts
import { createZingalaClient } from "@paid-tw/payment-zingala";

const zingala = createZingalaClient({
  merchantId: process.env.ZINGALA_MERCHANT_ID!, // 0Card-Merchant-Id
  apiKey: process.env.ZINGALA_API_KEY!, // 0Card-API-Key
  aesKey: process.env.ZINGALA_AES_KEY!, // 32 字元
  aesIv: process.env.ZINGALA_AES_IV!, // 16 字元
  sandbox: true, // UAT
});

// 先問這個商家有哪些期數可用，不要猜
const schedule = await zingala.getFeeSchedule();
console.log(availablePeriods(schedule, "vendor")); // 例：[1, 3, 6, 9, 12]

const application = await zingala.applyInstallment({
  orderId: "ORDER123",
  productName: "三星 S10 手機(128GB)", // ⚠️ 會影響核准率，見下
  amount: 20_000,
  periods: 3,
  feeBearer: "vendor", // 零利率（商家負擔）
  notifyUrl: "https://shop.example/zingala/notify",
  validDays: 7,
});

redirect(application.paymentUrlWeb); // 導消費者去申請
```

**憑證只有三把**（`merchantId` 不算祕密）：`apiKey`、`aesKey`、`aesIv`。手冊從沒說 `Digest` 是哪把金鑰簽的——實測確認**就是 `aesKey`**，所以不需要向中租另外要簽章金鑰。

## 兩支「你要實作」的端點

這是這個套件跟其他 adapter 最大的差別：中租會**反過來呼叫你**。

```ts
import {
  buildZingalaConfirmResponse,
  verifyZingalaConfirmRequest,
  verifyZingalaNotify,
} from "@paid-tw/payment-zingala";

// 1. 審核結果通知 —— 這是「可以出貨了」的訊號
app.post("/zingala/notify", async (req, res) => {
  const raw = await readRawBody(req); // ⚠️ 要原始位元組，不能用 parse 過的物件
  const notify = verifyZingalaNotify(
    raw,
    { digest: req.headers.digest, apiKey: req.headers["0card-api-key"] },
    { apiKey, aesKey, aesIv },
  );

  if (notify.approved) await ship(notify.orderId);
  res.status(200).end(); // 200 本身就是 ack
});

// 2. 確認訂單效用 —— 中租問你「這筆還有效嗎」
app.post("/zingala/confirm", async (req, res) => {
  const { orderId } = verifyZingalaConfirmRequest(
    await readRawBody(req),
    { apiKey: req.headers["0card-api-key"] },
    { apiKey },
  );
  res.json(buildZingalaConfirmResponse(await stillInStock(orderId)));
});
```

⚠️ **`comfirm_url` 是 fail-open 的**：手冊寫「若未回應 false，則代表皆為 true」。所以你的 handler 掛掉、timeout、回 500，中租**都當成「訂單有效」繼續審核**。如果你的庫存檢查可能失敗，要自己決定那時該不該明確回 `false`——沉默不會。

（另外注意中租把它拼成 `comfirm_url`，拼對反而沒作用。本套件的 `confirmUrl` 會送出他們的拼法。）

## 實測踩到的雷

以下都是在 UAT 錄下真實回應才知道的，錄音存在 `src/__tests__/cassettes/`。

1. **`801` 這個代碼不在任何版本的手冊裡。** 對一筆消費者還沒確認的訂單、用**正確金額**請款，會拿到 `801 此案件消費者尚未確認交易`。手冊 1.1.14 的代碼表停在 303/900/999，完全沒有 8xx。照文件寫 switch 的實作會把它掉進 default。

2. **`capture` 先檢查金額、後檢查狀態，`110` 會遮住真正原因。** 同一筆未核准訂單：金額對 → `801`（真原因）；金額錯 → `110 請款金額訂單金額不符`。拿到 110 的人會去改金額，改對才發現訂單根本還沒確認。

3. **查不到的訂單不是錯誤。** `inquiry` 回 `result: "000"` + `info: []`，也就是「成功」。本套件的 `getOrder()` 會把它轉成 `NOT_FOUND`；`getOrders()` 則誠實回空陣列。

4. **`reserve_ec` 完全不檢查額度。** `amount: 99999999` 照樣成功——額度是消費者流程才評估的。**reserve 成功不代表買得起。**

5. **同 `order_id` 重送會靜默覆寫訂單**，不是重複錯誤：連結不變、但金額換成最後一次送的值。

6. **無效的 enum 回 `900 系統發生錯誤`**（例如 `fee_type: "bogus"`），不是 `200 參數錯誤`。所以 **`900` 不能當成可重試的服務中斷**。本套件會在送出前擋掉未知的 `feeBearer`。

7. **`200` 的訊息帶欄位名**：`參數錯誤 : product_name 錯誤`。冒號後面是唯一線索，所以正規化時保留中租的原文。

8. **`check_is_member` 不驗身分證格式**：`cust_id: "NOTANID"` 回 `000` + `is_member: "N"`。也就是 `"N"` 同時代表「非會員」和「根本不是有效 ID」——**不能拿來驗 ID**。

9. **`payment_url_web` 和 `payment_url_app` 字串完全一樣**（儘管手冊當成兩種用途、1.1.0 還說移除了 app 那個）。

10. **`product_name` 會影響核准率**，不只是必填：中租用它做大數據判斷，帶假名稱會降低核准機率。本套件的錯誤訊息會講這件事。

11. **分期金額公式：手冊標「四捨五入」，算式其實是捨去。** 它自己的算例 1000 元／6 期／6% 得出每期 176，但 `round(1060/6) = 177`——只有捨去才是 176。所以 `calculateInstalmentPlan()` 照數字實作、不照標籤。捨去不會溢出，因此**首期永遠 ≥ 每期**（吸收餘數）。

12. **`vender/get_fee` 回傳沒有排序**（實測是 `9, 6, 3, 12, 1`），所以用位置索引沒有意義；用 `findFeeOption()` 依期數查。而 `consumer_fee_list: null` 才是 `201 無配合費率外加(低利率)報價` 的真正原因——那是商家沒配置費率，不是期數寫錯。

13. **版本差異會咬人**：`get_fee` 在 1.1.7 從 `payments/` 搬到 `vender/`；`refund_id` 在 1.1.8 從 Int 改成 string。照舊版文件寫會 404 或型別錯。

## 測試

```bash
pnpm test                              # 離線，MSW 重播錄音
pnpm test:live:zingala                 # UAT，需要 .env 憑證
```

離線測試重播的是 **UAT 真實回應的原始位元組**，不是照文件編的 payload。Digest 在重播時用測試金鑰重算，所以離線測試不需要你的金鑰也能走完整簽章驗證；而「我們的 HMAC 慣例真的跟中租一致」由 `crypto.test.ts` 裡一組 **13 個真實 (body, digest) golden** 證明（env-gated，因為只有真金鑰能驗；HMAC 不會洩漏金鑰，所以 commit 是安全的）。

### UAT 到不了的地方

手冊 1.1.14 第 38 頁自己寫了：「測試環境無法測試需人工處理的項目，如專人審核交易、撥款不會有變化」。具體來說：

|                                                               | UAT 可達？                                                 |
| ------------------------------------------------------------- | ---------------------------------------------------------- |
| `reserve_ec` 成功與所有驗證錯誤                               | ✅                                                         |
| `inquiry`、`get_fee`、`get_bank_branch`、`check_is_member`    | ✅                                                         |
| `capture`／`refund` 的狀態守衛錯誤（`801`/`110`/`100`/`103`） | ✅                                                         |
| `transaction_state` 003／004／005                             | ❌ 需測試版消費者 APP + 專人審核；004/005 要中租人員手動改 |
| `capture` 成功                                                | ❌ UAT 批次不跑，只回 `199`                                |
| **審核結果通知（notify）**                                    | ❌ 需要走完 APP 流程                                       |

因此 **`notify.ts` 是本套件唯一沒有實錄資料背書的模組**——它的測試 fixture 依據手冊 p.11-13（含手冊自己的範例值）。錄到真實 notify 之後應該取代它們。需要跑核准後的測試時，把 `ZINGALA_QUERY_ORDER_ID` 指向一筆已經有人手動推過去的訂單，否則那些測試會 skip 而不是假裝通過。

## 尚未實作

- `reserve_pos`（現場 POS 交易，需要消費者 APP 出示的付款條碼）
- `recommend_member`（電商推薦會員資料）——這支會把**消費者的會員等級、一年內消費金額級距、是否用過信用卡、帳號歷史**送給中租。那是行銷／個資分享而不是金流，刻意不包進來。
