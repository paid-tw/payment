# @paid-tw/payment-newebpay

## 0.2.0

### Minor Changes

- f590095: Implement the NewebPay 藍新金流 adapter — from scaffold to two working factories.

  - `createNewebpayProvider` (`newebpay`, MPG NDNF-1.2.3): signed MPG checkout
    form (browser-post only), QueryTradeInfo with CheckValue signing + strict
    response-CheckCode verification, credit-card capture/refund/cancel via the
    encrypted CreditCard Close/Cancel envelope (TRA20001 surfaced as a queued
    cancel), and TradeSha-first notify verification for both the paid notify and
    the CustomerURL get-code notify (JSON + String RespondTypes).
  - `createNewebpayPeriodProvider` (`newebpay-period`, 定期定額 NDNP-1.0.7):
    mandate creation form, AlterStatus (suspend/terminate/restart), AlterAmt,
    and verifiers for the create-result and each-period [NPA-N050] notifies.
  - Crypto core (AES-256-CBC pad-16 with tolerant 1..32 unpad, TradeSha,
    CheckValue, CheckCode) pinned to golden vectors from both official manuals
    and OSS test suites; complete NDNF/NDNP error tables mapped onto stable
    `PaymentError` codes.
  - Verified end-to-end against the ccore sandbox (query, cancel-auth, and
    periodic AlterStatus envelopes all round-trip to coded gateway answers).

  Deliberately deferred (documented in `docs/newebpay-api-coverage.md`):
  EWallet/BNPL refund envelope, `EncryptType=1` (AES-GCM), CAU notifies.

## 0.1.1

### Patch Changes

- Updated dependencies [cdc2654]
  - @paid-tw/payment@0.2.0

## 0.1.0

### Minor Changes

- Scaffold：`createNewebpayProvider`，capabilities 皆空，操作回 `UNSUPPORTED`。  
  供 CLI registry 與後續 API 實作預留。
