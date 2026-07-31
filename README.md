# payment-tw

[![CI](https://github.com/paid-tw/payment/actions/workflows/ci.yml/badge.svg)](https://github.com/paid-tw/payment/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@paid-tw/payment.svg?label=%40paid-tw%2Fpayment)](https://www.npmjs.com/package/@paid-tw/payment)
[![npm ecpay](https://img.shields.io/npm/v/@paid-tw/payment-ecpay.svg?label=%40paid-tw%2Fpayment-ecpay)](https://www.npmjs.com/package/@paid-tw/payment-ecpay)
[![types: TypeScript](https://img.shields.io/npm/types/@paid-tw/payment.svg)](https://www.typescriptlang.org/)
[![license: MIT](https://img.shields.io/github/license/paid-tw/payment.svg)](./LICENSE)
[![Node.js](https://img.shields.io/node/v/@paid-tw/payment.svg)](https://nodejs.org/)

統一的**台灣金流 SDK**。一套與供應商無關的 `PaymentProvider` 介面，搭配多家閘道轉接器 —— 在 PAYUNi、藍新、綠界等之間切換，不需重寫商業邏輯。

對齊 [`@paid-tw/einvoice`](https://github.com/paid-tw/einvoice) 的 monorepo 形狀：core + per-provider packages。

## 套件

| 套件                                                       | 角色                                                                        |
| ---------------------------------------------------------- | --------------------------------------------------------------------------- |
| [`@paid-tw/payment`](./packages/payment)                   | core：型別、`PaymentProvider`、capabilities、`PaymentError`、`MockProvider` |
| [`@paid-tw/payment-ecpay`](./packages/payment-ecpay)       | ECPay 綠界 — AioCheckOut / QueryTradeInfo / DoAction                        |
| [`@paid-tw/payment-payuni`](./packages/payment-payuni)     | PAYUNi 統一金流 — trade query（create/refund WIP）                          |
| [`@paid-tw/payment-newebpay`](./packages/payment-newebpay) | NewebPay 藍新 — scaffold                                                    |

只需安裝你會用到的供應商。**core 永不依賴 adapters**；由 CLI / app compose。

```bash
pnpm add @paid-tw/payment @paid-tw/payment-ecpay
```

## 使用方式

```ts
import { createEcpayProvider } from "@paid-tw/payment-ecpay";

const payments = createEcpayProvider({
  merchantId: process.env.ECPAY_MERCHANT_ID!,
  hashKey: process.env.ECPAY_HASH_KEY!,
  hashIv: process.env.ECPAY_HASH_IV!,
  sandbox: true,
});

// create 回傳導轉表單（非已付款）
const form = await payments.createPayment({
  amount: 1000,
  currency: "TWD",
  method: "card",
  orderId: "ORDER123",
  notifyUrl: "https://example.com/notify",
});

const data = await payments.getPayment({ merTradeNo: "ORDER123" });
```

## 開發

```bash
pnpm install
pnpm build
pnpm test
```

### ECPay stage（公開測試特店）

綠界公布的模擬 3D 特店（明碼）：`MerchantID=3002607`，見
[`packages/payment-ecpay/README.md`](./packages/payment-ecpay/README.md)。

```bash
# 離線 MSW（CI 預設）
pnpm test

# 真實 payment-stage
pnpm test:live:ecpay
```

綠界有 **AIO 導轉** 與 **站內付 2.0 (ECPG)** 兩套 API（同一套件、兩個 factory）。  
覆蓋矩陣：[`docs/ecpay-api-coverage.md`](./docs/ecpay-api-coverage.md)。  
AIO vs ECPG 區隔：[`docs/ecpay-provider-separation.md`](./docs/ecpay-provider-separation.md)。

## 發布（gh tag + OIDC）

**本機不跑 `npm publish`。** 推送 `vX.Y.Z` tag 後由 Actions 以 OIDC 發 npm。

- Workflows：`.github/workflows/ci.yml`、`publish.yml`
- Changesets：`pnpm changeset` / `pnpm changeset version`
- 各套件 CHANGELOG：`packages/*/CHANGELOG.md`
- 完整步驟：[`docs/release.md`](./docs/release.md)

```bash
pnpm changeset version
git commit -am "chore: release"
git push origin main
git tag v0.1.1 && git push origin v0.1.1
```

## 邊界

| 放這裡                                                   | 不放這裡                                          |
| -------------------------------------------------------- | ------------------------------------------------- |
| create / get / refund、簽章、endpoint、normalized errors | 特店申請、bind merchant、mermcc、KYC（→ paid.tw） |
| adapter 專有 extension                                   | CLI flags / table 輸出（→ `@paid-tw/cli`）        |

## License

MIT
