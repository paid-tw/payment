# @paid-tw/payment-zingala

中租零卡分期（Zingala）串接 —— 讓消費者**免綁信用卡、免綁帳戶**分期付款，商家照約定週期一次拿到全額。

依據《中租零卡分期 API 串接技術手冊 1.1.14》，並在 UAT 實際錄製回應驗證。

```bash
pnpm add @paid-tw/payment-zingala
```

## 交易怎麼跑

跟刷卡最大的差別：**中租要先審核消費者的信用**，所以「送出申請」和「可以出貨」是兩個不同的時間點，中間可能隔幾小時到幾天。

```
① 你建立申請  →  ② 消費者在中租頁面／APP 送出  →  ③ 中租審核  →  ④ 通知你結果  →  ⑤ 你請款
   applyInstallment          （含實名認證）          （可能轉專人）    notify_url      capture
```

## 1. 建立 client

```ts
import { createZingalaClient } from "@paid-tw/payment-zingala";

const zingala = createZingalaClient({
  merchantId: process.env.ZINGALA_MERCHANT_ID!, // 商家編號
  apiKey: process.env.ZINGALA_API_KEY!, // API 連線金鑰
  aesKey: process.env.ZINGALA_AES_KEY!, // 32 字元
  aesIv: process.env.ZINGALA_AES_IV!, // 16 字元
  sandbox: true, // UAT；正式環境改成 false
});
```

中租只會發你**三把**金鑰（商家編號不算祕密）。`aesKey` 同時用來解密申請人資料**和驗證簽章**——手冊沒寫這件事，是實測確認的，所以不用再去要第四把。

## 2. 先問可用的期數

期數和利率是「各別議定」的，不同商家不一樣。**先查再送**，可以省下一輪 `201 分期期數錯誤`：

```ts
import { availablePeriods, calculateInstalmentPlan, findFeeOption } from "@paid-tw/payment-zingala";

const schedule = await zingala.getFeeSchedule();

availablePeriods(schedule, "vendor"); // 零利率可用期數，例：[1, 3, 6, 9, 12]
availablePeriods(schedule, "consumer"); // 利息外加可用期數；空陣列 = 這個商家沒開

// 想先讓消費者看到每期多少錢
const plan = calculateInstalmentPlan(20_000, 6, findFeeOption(schedule, "vendor", 6)!.feeRate);
plan.first; // 首期（吸收餘數，會 >= 每期）
plan.each; // 之後每期
plan.total; // 總應繳；零利率時等於原金額
```

## 3. 建立申請，把消費者導過去

```ts
const application = await zingala.applyInstallment({
  orderId: "ORDER123", // 你自己的訂單編號
  productName: "三星 S10 手機(128GB)", // 用真實商品名稱，見下
  amount: 20_000,
  periods: 6,
  feeBearer: "vendor", // vendor = 零利率（商家吸收）｜consumer = 利息外加
  notifyUrl: "https://shop.example/zingala/notify",
  validDays: 7, // 連結有效天數，1-30
});

redirect(application.paymentUrlWeb);
```

`productName` **要帶真的商品名稱**：中租會用它做風險判斷，帶「測試商品」這種佔位字串會直接降低核准率。

⚠️ `applyInstallment` 成功**不代表消費者買得起**——額度是消費者流程才評估的，`amount` 帶到近億元一樣會成功建立申請。

## 4. 收審核結果（這才是「可以出貨」的訊號）

中租會 POST 到你的 `notifyUrl`。

```ts
import { verifyZingalaNotify } from "@paid-tw/payment-zingala";

app.post("/zingala/notify", async (req, res) => {
  const raw = await readRawBody(req); // ⚠️ 要原始文字，不能用 parse 過的物件
  const notify = verifyZingalaNotify(
    raw,
    { digest: req.headers.digest, apiKey: req.headers["0card-api-key"] },
    { apiKey, aesKey, aesIv },
  );

  if (notify.approved) await ship(notify.orderId); // 003/004/005
  if (notify.failed) await cancel(notify.orderId); // 婉拒／取消／逾時

  res.status(200).end(); // 200 本身就是 ack
});
```

**必須用原始 request body**：簽章是對位元組算的，框架 parse 完再 `JSON.stringify` 回去就驗不過（`express.raw()`、Hono `c.req.text()`、Next `await request.text()`）。

**同一筆訂單會收到多次通知**（審核中 → 核准），`orderId` 都一樣。去重要用 `orderId` + `rawState`，只用 `orderId` 會把核准當成重複通知丟掉。

## 5. 請款與退款

```ts
await zingala.capture({ orderId: "ORDER123", amount: 20_000 }); // 不支援部分請款
await zingala.refund({ orderId: "ORDER123", refundAmount: 20_000 });
```

想主動查狀態（而不是等通知）：

```ts
const order = await zingala.getOrder("ORDER123");
order.state; // "pending-consumer" | "in-review" | "approved" | "capturing" | "disbursed" | …
order.stateLabel; // 中文說明
order.captureDeadline; // 授權過期日，請款要在這之前

// 一次查多筆（上限 100）
const orders = await zingala.getOrders({ orderIds: ["A", "B"] });
```

`getOrder` 查不到會丟 `NOT_FOUND`；`getOrders` 回空陣列。

### 訂單狀態

| `state`              | 代碼 | 意思                 | 可以出貨？ |
| -------------------- | ---- | -------------------- | ---------- |
| `pending-consumer`   | 001  | 消費者還沒操作       | ❌         |
| `in-review`          | 002  | 轉專人審核中         | ❌         |
| `approved`           | 003  | 已核准、未請款       | ✅         |
| `capturing`          | 004  | 請款中               | ✅         |
| `disbursed`          | 005  | 已撥款（錢進來了）   | ✅         |
| `declined`           | 006  | 婉拒                 | ❌         |
| `cancelled`          | 007  | 核准後取消或全額退款 | ❌         |
| `expired`            | 008  | 審核時取消或逾時     | ❌         |
| `partial-cancelling` | 009  | 部分取消處理中       | —          |

**核准（003）就可以出貨，不用等撥款（005）。** 撥款是你拿到錢的時間，通常晚幾天。

## 其他

```ts
// 這個人有沒有零卡分期額度（可用來決定要不要顯示這個付款選項）
const { isMember, signupUrl } = await zingala.checkMember("A123456789");

// 審核通知函 PDF
const order = await zingala.getOrder("ORDER123");
if (order.approvalNoticeAvailable) {
  const pdf = await zingala.downloadApprovalNotice("ORDER123");
}

// 金融機構代碼表
const banks = await zingala.getBankBranches();
```

⚠️ `checkMember` **不能拿來驗證身分證格式**：亂填 `"NOTANID"` 也會回成功 + `isMember: false`，所以 `false` 同時代表「非會員」和「根本不是有效 ID」。

### 選用：確認訂單效用

如果你在建立申請時帶了 `confirmUrl`，中租在審核過程中會**反過來問你「這筆訂單還有效嗎」**（庫存還在嗎、有沒有被取消）。

```ts
import { buildZingalaConfirmResponse, verifyZingalaConfirmRequest } from "@paid-tw/payment-zingala";

app.post("/zingala/confirm", async (req, res) => {
  const { orderId } = verifyZingalaConfirmRequest(
    await readRawBody(req),
    { apiKey: req.headers["0card-api-key"] },
    { apiKey },
  );
  res.json(buildZingalaConfirmResponse(await stillInStock(orderId)));
});
```

⚠️ 這支是 **fail-open** 的：手冊寫「若未回應 false，則代表皆為 true」。你的 handler 掛掉、timeout、回 500，中租都會**當成訂單有效繼續審核**。如果庫存檢查本身可能失敗，要自己決定那時該不該明確回 `false`。

## 踩到會痛的地方

除了上面標 ⚠️ 的，還有這些是實測才知道、而且會影響你怎麼寫程式的：

- **同一個 `order_id` 重送會靜默覆寫訂單**，不是「重複訂單」錯誤：連結不變，但金額換成最後一次送的值。想改金額就重送；不想改就別重送。
- **`900 系統發生錯誤` 不一定是對方壞了**——送出無效的 enum（例如 `feeBearer` 打錯字）也會回 900。所以**不要對 900 做無限重試**。本套件會在送出前擋掉這類值。真正該重試的只有 `112` 和 `199`（中租明說「請隔日或稍後再試」）。
- **請款會先檢查金額、後檢查狀態。** 金額錯就回「金額不符」，把「訂單根本還沒被消費者確認」蓋掉；改對金額才會看到真正的原因。
- **分期金額用捨去、不是四捨五入**（手冊標了四捨五入，但它自己的算例只有捨去才對得上）。所以首期會 >= 每期，吸收餘數。
- **`getFeeSchedule()` 的回傳沒有排序**，用 `findFeeOption()` 依期數查，不要用位置索引。

## 測試

```bash
pnpm test                 # 離線，重播錄製的 UAT 回應
pnpm test:live:zingala    # 打 UAT，需要 .env 憑證
```

離線測試重播的是**真實 UAT 回應的原始位元組**，不是照文件編的 payload。

**UAT 有兩個到不了的地方**（手冊 p.38 自己寫的：「測試環境無法測試需人工處理的項目」）：

1. **核准之後的狀態（003/004/005）**——需要測試版消費者 APP 加專人審核；請款在 UAT 只會回 `199`。要測這段就把 `ZINGALA_QUERY_ORDER_ID` 指向一筆已經有人手動推過去的訂單，否則那些測試會 skip。
2. **審核結果通知**——所以 `notify.ts` 是本套件唯一**依據文件而非實錄**的模組。錄到真實 notify 之後應該取代它的 fixture。

## 附註：為什麼不是 `PaymentProvider`

本 repo 其他 adapter 都實作共用的 `PaymentProvider`（`createPayment` / `getPayment` / `refundPayment`），這個沒有，是刻意的。

刷卡是**當下授權**：送出去，要嘛成功要嘛失敗。零卡分期是**核貸**：送出去之後有審核、有可能被婉拒、成功了還要等撥款。`status` 只有 `paid` / `unpaid` 的話，「轉專人審核中」和「已核准未撥款」就沒地方放，只能挑一個謊來說。所以這裡的方法名照核貸流程走。

跨供應商的共用 BNPL 介面（中租／AFTEE／oppay…）是目標，但**還沒定**：目前只有中租一家有實錄資料，只憑一家推出來的「通用介面」其實就是這一家換個通用名字。等第二家的真實流程進來再抽。

## 尚未實作

- `reserve_pos` —— 現場 POS，需要消費者 APP 出示的付款條碼。
- `recommend_member` —— 會把消費者的會員等級、年消費級距、是否用過信用卡等資料送給中租。那是行銷／個資分享而不是金流，刻意不包進來。
