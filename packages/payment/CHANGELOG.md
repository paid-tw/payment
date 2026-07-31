# @paid-tw/payment

## 0.1.0

### Minor Changes

- 初版：provider-agnostic 核心
  - `PaymentProvider`、`CreatePaymentRequest` / `GetPaymentRequest` / `RefundPaymentRequest`
  - `Capability` + `supports` / `assertSupports`
  - `PaymentError` / `isPaymentError`（跨模組 brand）
  - `MockProvider`（測試用）
