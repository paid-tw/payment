# `@paid-tw/payment`

Provider-agnostic **core** for Taiwan payment gateways.

Install only this package if you implement your own adapter or use `MockProvider`.
For real gateways, also install an adapter:

```bash
pnpm add @paid-tw/payment @paid-tw/payment-ecpay
```

## Usage

```ts
import { Capability, supports, type PaymentProvider } from "@paid-tw/payment";
import { createEcpayProvider } from "@paid-tw/payment-ecpay";

const payments: PaymentProvider = createEcpayProvider({
  merchantId: process.env.ECPAY_MERCHANT_ID!,
  hashKey: process.env.ECPAY_HASH_KEY!,
  hashIv: process.env.ECPAY_HASH_IV!,
  sandbox: true,
});

if (supports(payments, Capability.GET_PAYMENT)) {
  const data = await payments.getPayment({ merTradeNo: "ORDER123" });
  console.log(data.status, data.amount);
}
```

## Packages

| Package | Role |
| --- | --- |
| `@paid-tw/payment` | Core types, `PaymentProvider`, capabilities, `PaymentError`, `MockProvider` |
| `@paid-tw/payment-ecpay` | ECPay 綠界 |
| `@paid-tw/payment-payuni` | PAYUNi 統一金流 |
| `@paid-tw/payment-newebpay` | NewebPay 藍新（scaffold） |

Core **never** depends on adapters. Consumers compose which adapters they import.
