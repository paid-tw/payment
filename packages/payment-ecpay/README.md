# `@paid-tw/payment-ecpay`

ECPay 綠界 All-in-One adapter for [`@paid-tw/payment`](../payment).

Implements `PaymentProvider` with:

- **createPayment** → AioCheckOut V5 **redirect** form (`mode: "redirect"`, not a completed charge)
- **getPayment** → QueryTradeInfo/V5
- **refundPayment** → DoAction credit-card refund (Action=R)
- **verifyPaymentNotify** → ReturnURL / OrderResultURL CheckMacValue verify

## Usage

```ts
import {
  createEcpayProvider,
  ECPAY_SANDBOX,
  ECPAY_NOTIFY_ACK,
} from "@paid-tw/payment-ecpay";

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

| 項目 | 值 |
| --- | --- |
| MerchantID | `3002607` |
| HashKey | `pwFHCqoQZGmho4w6` |
| HashIV | `EkRm7iFT261dpevs` |
| 統一編號 | `00000000` |
| 後台帳號 | `stagetest3` |
| 後台密碼 | `test1234` |
| 金流 stage | `https://payment-stage.ecpay.com.tw` |
| 特店後台 | `https://vendor-stage.ecpay.com.tw` |

SDK 常數：`ECPAY_SANDBOX`、`ECPAY_SANDBOX_PORTAL`（後台登入僅供人工 QA，API 不用）。

手動刷卡測試（stage 收銀台）：卡號 `4311-9522-2222-2222`，3D OTP `1234`。

## 測試：MSW + live

| 模式 | 指令 | 說明 |
| --- | --- | --- |
| **MSW（預設 CI）** | `pnpm test` 或 `pnpm --filter @paid-tw/payment-ecpay test:msw` | 離線；用錄製的 stage 回應 + 同一組 3002607 金鑰驗 CheckMacValue |
| **Live** | `ECPAY_LIVE=1 pnpm test:live:ecpay` | 打真實 `payment-stage`；預設即用公開特店，不必設 env |

```bash
# 離線（MSW）
pnpm --filter @paid-tw/payment-ecpay test:msw

# 真實 stage
ECPAY_LIVE=1 pnpm test:live:ecpay

# 查一筆你在 stage 完成付款的訂單 + 印 raw
ECPAY_LIVE=1 ECPAY_QUERY_ID=yourMerTradeNo PAID_DEBUG=1 pnpm test:live:ecpay
```

MSW 的 default handlers 會對已知 `MerchantTradeNo` 重放 field-exact fixtures（與 live 同一組 HashKey/HashIV），方便在無網路時重現 stage 行為。

## 兩套 API 與覆蓋面

綠界金流有兩條產品線，**不可混用同一套 wire format**：

| 系列 | 文件 | 本套件 |
| --- | --- | --- |
| **全方位金流 (AIO)** | [developers.ecpay.com.tw/?p=2509](https://developers.ecpay.com.tw/?p=2509) | ✅ 部分：AioCheckOut 導轉、QueryTradeInfo、DoAction 退款(R) |
| **站內付 2.0 (ECPG)** | [developers.ecpay.com.tw/?p=8972](https://developers.ecpay.com.tw/?p=8972) | ❌ 尚未實作（AES JSON Token / PayToken / 前端 JS） |

官方範例對照：

- AIO PHP：https://github.com/ECPay/SDK_PHP/tree/master/example/Payment/Aio  
- ECPG PHP：https://github.com/ECPay/SDK_PHP/tree/master/example/Payment/Ecpg  
- AIO Python：https://github.com/ECPay/ECPayAIO_Python  

完整缺口表與 roadmap：[`docs/ecpay-api-coverage.md`](../../docs/ecpay-api-coverage.md)。
