# payment-tw

[![CI](https://github.com/paid-tw/payment/actions/workflows/ci.yml/badge.svg)](https://github.com/paid-tw/payment/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@paid-tw/payment.svg?label=%40paid-tw%2Fpayment)](https://www.npmjs.com/package/@paid-tw/payment)
[![npm ecpay](https://img.shields.io/npm/v/@paid-tw/payment-ecpay.svg?label=%40paid-tw%2Fpayment-ecpay)](https://www.npmjs.com/package/@paid-tw/payment-ecpay)
[![types: TypeScript](https://img.shields.io/npm/types/@paid-tw/payment.svg)](https://www.typescriptlang.org/)
[![license: MIT](https://img.shields.io/github/license/paid-tw/payment.svg)](./LICENSE)
[![Node.js](https://img.shields.io/node/v/@paid-tw/payment.svg)](https://nodejs.org/)

統一的**台灣金流 SDK**。一套與供應商無關的 `PaymentProvider` 介面，搭配多家閘道轉接器 —— 在 PAYUNi、藍新、綠界等之間切換，不需重寫商業邏輯。

抽象是照類別切的：付款閘道共用 `PaymentProvider`，核貸型的無卡分期（BNPL）則有自己的一組介面 —— 見 [BNPL：另一種形狀](#bnpl另一種形狀)。

對齊 [`@paid-tw/einvoice`](https://github.com/paid-tw/einvoice) 的 monorepo 形狀：core + per-provider packages。

## 套件

| 套件                                                       | 角色                                                                        |
| ---------------------------------------------------------- | --------------------------------------------------------------------------- |
| [`@paid-tw/payment`](./packages/payment)                   | core：型別、`PaymentProvider`、capabilities、`PaymentError`、`MockProvider` |
| [`@paid-tw/payment-ecpay`](./packages/payment-ecpay)       | ECPay 綠界 — 四條產品線、四個 factory（見下）                               |
| [`@paid-tw/payment-payuni`](./packages/payment-payuni)     | PAYUNi 統一金流 — 目前只有 trade query；create / refund 會丟 `UNSUPPORTED`  |
| [`@paid-tw/payment-newebpay`](./packages/payment-newebpay) | NewebPay 藍新 — scaffold                                                    |
| [`@paid-tw/payment-zingala`](./packages/payment-zingala)   | 中租零卡分期 — 無卡分期（BNPL）：核貸流程，另一組介面（見下）               |

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

## 綠界：四條產品線，一個套件

綠界不是一套 API，而是四套；同一個 npm 套件、四個 factory、四個 `name`：

| Factory                       | 產品線                       | create 結果                         |
| ----------------------------- | ---------------------------- | ----------------------------------- |
| `createEcpayProvider`         | AIO 全方位金流（導轉）       | redirect form                       |
| `createEcpayEcpgProvider`     | 站內付 2.0 (ECPG)            | token                               |
| `createEcpayPayCodeProvider`  | 非信用卡幕後取號             | 虛擬帳號／繳費代碼／條碼            |
| `createEcpayBackAuthProvider` | 信用卡幕後授權 ⚠️ 收 raw PAN | `3ds` 或 `authorized`（含定期定額） |

⚠️ `createEcpayBackAuthProvider` 在 **`@paid-tw/payment-ecpay/backauth` 這個 subpath**，不在套件根目錄。它是唯一會收到完整卡號的 adapter，獨立 subpath 讓應用可以用 import graph 機械地證明自己沒有把 raw-PAN 介面打包進去。

- 覆蓋矩陣：[`docs/ecpay-api-coverage.md`](./docs/ecpay-api-coverage.md)
- 為什麼分成四個 factory：[`docs/ecpay-provider-separation.md`](./docs/ecpay-provider-separation.md)

## BNPL：另一種形狀

`@paid-tw/payment-zingala`（中租零卡分期）不實作 `PaymentProvider`，因為它的流程不一樣：刷卡是當下授權，無卡分期是**核貸**——送出申請後有審核、可能婉拒，核准後還要等撥款。`status` 只有 paid / unpaid 的話，「審核中」和「已核准未撥款」沒地方放。

所以它的方法名照核貸流程走（`applyInstallment` 開的是一份信用申請），而且多了其他 adapter 都沒有的一件事：**中租會反過來呼叫你**（通知審核結果、詢問訂單是否仍有效）。用法見 [`packages/payment-zingala/README.md`](./packages/payment-zingala/README.md)。

跨供應商的共用 BNPL 介面（中租／AFTEE／oppay）是目標但還沒定 —— 目前只有一家有實錄資料，只憑一家推出來的抽象就只是這一家換個名字。

## 開發

```bash
pnpm install
pnpm build
pnpm test          # 離線（MSW），CI 預設
pnpm typecheck     # 含測試檔
pnpm lint
pnpm format
```

### Live 測試

每個 adapter 都有一組 env-gated 的 live 測試，打真實 sandbox；平常的 `pnpm test` 不會跑到。

```bash
pnpm test:live:ecpay           # AIO
pnpm test:live:ecpay:paycode   # 幕後取號
pnpm test:live:ecpay:backauth  # 幕後授權
pnpm test:live:ecpay:credit    # 信用卡查詢
pnpm test:live:ecpay:period    # 定期定額 ⚠️ 會真的扣款，見套件 README
pnpm test:live:zingala         # 中租零卡分期 UAT
```

憑證命名見 [`.env.example`](./.env.example)。⚠️ 這個 repo 沒有 dotenv，`.env` 放了不會自動生效 —— 用 `set -a; source .env; set +a`。

綠界公布了明碼的測試特店（例如模擬 3D 的 `3002607`、3D 關閉的 `2000132`），所以 ECPay 的 fixtures 可以在 repo 裡用同一把金鑰重新簽章；中租的 UAT 金鑰是你自己的，因此 zingala 的錄音不含任何憑證，需要真金鑰才能驗證的測試都是 env-gated。

### Fixtures 的原則

adapter 的 fixtures 一律是**實際錄下來的回應**，逐欄與 sandbox 一致，不是照文件編的。這條規則抓到的東西比 review 多 —— 綠界文件沒寫的 `ExecLog` / `ExecStatus`、`ExecTimes` 最小值是 2 而非 1、中租**任何版本手冊都沒有的 `801`**，全都是這樣挖出來的。

sandbox 到不了的分支就明確標成 doc-derived，不會默默用文件填補（目前唯一一處：`payment-zingala` 的 notify，因為 UAT 觸發不了）。

## 邊界

| 放這裡                                                   | 不放這裡                                          |
| -------------------------------------------------------- | ------------------------------------------------- |
| create / get / refund、簽章、endpoint、normalized errors | 特店申請、bind merchant、mermcc、KYC（→ paid.tw） |
| adapter 專有 extension                                   | CLI flags / table 輸出（→ `@paid-tw/cli`）        |
| 核貸流程（BNPL）                                         | 行銷／個資分享 API（例如中租的電商推薦會員資料）  |

## 發版

不在本機 `npm publish`。走 git tag → [`publish.yml`](./.github/workflows/publish.yml) → npm OIDC trusted publishing。
完整步驟：[`docs/release.md`](./docs/release.md)。

## License

MIT
