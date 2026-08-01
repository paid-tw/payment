---
"@paid-tw/payment-ecpay": minor
---

Add ECPay 信用卡幕後授權 (BackAuth): `createEcpayBackAuthProvider`
(`name: "ecpay-backauth"`) authorizes a card server-side with no ECPay page in the
flow — `createPayment` returns `{ mode: "3ds" }` or `{ mode: "authorized" }`, plus
`getPayment`, `creditDoAction` and `verifyPaymentNotify`.

⚠️ **This adapter accepts a raw card number and therefore puts the calling process
in PCI-DSS SAQ D scope**, where the other three ECPay adapters keep you at SAQ A
because card data never reaches you.

It is published on its own subpath rather than the package root:

```ts
import { createEcpayBackAuthProvider } from "@paid-tw/payment-ecpay/backauth";
```

Scope follows from _handling_ card data, so not calling it keeps you at SAQ A either
way — the separate entry point is what lets a build prove by import graph that it
excludes the card-accepting surface, which is a mechanically checkable answer during
an audit rather than a statement of intent. The package root exports only the three
adapters that never see card data.

ECPay also requires OTP off and 3D verification enabled on the merchant before
BackAuth works.

Two behaviours worth knowing before you integrate, both verified against stage:

- The 3D response carries **no `RtnCode`** — check `result.mode` before anything
  else, or a valid 3DS hand-off looks like a failure.
- `Credit/DoAction` (請退款) is **production only**; ECPay does not expose it on
  stage, so a sandbox-configured provider throws `UNSUPPORTED`.
