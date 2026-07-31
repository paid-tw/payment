# ECPay：AIO vs 站內付 2.0 要怎麼區隔？

## 結論（採用）

| 層級                       | 做法                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------- |
| **npm 套件**               | 同一個 `@paid-tw/payment-ecpay`（同一家綠界、同一組特店金鑰）                                   |
| **Factory**                | 兩個：`createEcpayProvider`（AIO）與 `createEcpayEcpgProvider`（站內付 2.0）                    |
| **`PaymentProvider.name`** | `"ecpay"` vs `"ecpay-ecpg"`                                                                     |
| **CLI registry key**       | 可選註冊兩者；設定／env 前綴可共用 `ECPAY_*` 或分 `ECPAY_ECPG_*`                                |
| **不要**                   | 一個 instance 用 `mode: "aio"\|"ecpg"` 切換 create 語意（易誤用 redirect form 當 token）        |
| **不要**                   | 拆成 `@paid-tw/payment-ecpay-aio` + `-ecpg` 兩個 publish 單元（除非日後套件體積／權限真的需要） |

## 為什麼要區分「provider 實例」，但不必拆品牌

兩者都是**綠界**，但產品線不同：

|             | AIO `ecpay`                            | ECPG `ecpay-ecpg`                                                              |
| ----------- | -------------------------------------- | ------------------------------------------------------------------------------ |
| UX          | 導轉綠界收銀台                         | 嵌在自家頁（前端 JS SDK）                                                      |
| Host        | `payment(-stage).ecpay.com.tw`         | `ecpg(-stage).ecpay.com.tw`                                                    |
| Crypto      | CheckMacValue form                     | AES-128-CBC + JSON envelope                                                    |
| create 回傳 | `{ mode: "redirect", action, params }` | `{ mode: "token", token, merchantTradeNo }`                                    |
| 後續步驟    | 等 ReturnURL notify                    | 前端 `createPayment(Token)` → `getPayToken` → server `CreatePayment(PayToken)` |

同一 `PaymentProvider` 介面可以裝兩邊，但 **create 的契約完全不同**；用兩個 factory + 兩個 `name` 最清楚。

## 和「多家金流」的差異

- `payuni` / `newebpay` / `ecpay` = **不同廠商** → 不同 package 或至少不同 adapter
- `ecpay` / `ecpay-ecpg` = **同一廠商兩條 API** → **同 package、不同 factory**

類比 einvoice：`@paid-tw/einvoice-ecpay`（B2C 發票）與日後若有綠界另一條發票 API，也不會叫成另一個 payment brand。

## 共用什麼

- `ECPAY_SANDBOX` 特店編號／HashKey／HashIV（公開 stage 特店常可共用）
- 錯誤型別 `PaymentError`、capabilities 風格
- （可選）之後再抽的共用 AES helper 若與發票 crypto 對齊

不共用：endpoint 表、notify 驗簽格式（AIO CMV vs ECPG AES）、create 結果 shape。

## CLI 註冊示例

```ts
const factories = {
  ecpay: createEcpayProvider,
  "ecpay-ecpg": createEcpayEcpgProvider,
  payuni: createPayuniProvider,
  // ...
};
```

`ProviderName` 擴成 `"ecpay" | "ecpay-ecpg" | ...` 即可。
