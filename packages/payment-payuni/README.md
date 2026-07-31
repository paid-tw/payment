# `@paid-tw/payment-payuni`

PAYUNi 統一金流 adapter for [`@paid-tw/payment`](../payment).

Currently implements **getPayment** (trade query). create/refund declare `UNSUPPORTED`.

```ts
import { createPayuniProvider } from "@paid-tw/payment-payuni";

const payuni = createPayuniProvider({
  merchantId: process.env.PAYUNI_MERCHANT_ID!,
  hashKey: process.env.PAYUNI_HASH_KEY!,
  hashIv: process.env.PAYUNI_HASH_IV!,
  sandbox: true,
});

const data = await payuni.getPayment({ merTradeNo: "ORDER-123" });
```
