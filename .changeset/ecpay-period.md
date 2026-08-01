---
"@paid-tw/payment-ecpay": minor
---

feat(ecpay): 定期定額 (recurring credit) on the 幕後授權 provider

`@paid-tw/payment-ecpay/backauth` can now run the full recurring-credit lifecycle:

- `createPayment({ period })` starts a schedule (`D`/`M`/`Y`, with the ranges validated
  before the request goes out)
- `queryPeriodOrder()` reads its progress, including the per-cycle history
- `creditCardPeriodAction()` does `ReAuth` / `Cancel`

There is no dedicated create endpoint at ECPay — a schedule is an ordinary `BackAuth`
call carrying four extra `CardInfo` fields — so this adds no new provider and no new
config.

Two fields ECPay returns but does not document are surfaced, both verified against
stage:

- `executions` (`ExecLog`) — the only per-cycle history. Counters report _how many_
  cycles succeeded; this reports which, when, for how much, and under which `TradeNo`
  (each cycle gets its own), which is what reconciliation needs.
- `isActive` / `execStatus` (`ExecStatus`) — whether the schedule is still running.
  `status`/`TradeStatus` cannot answer this: it stays `"paid"` on a cancelled schedule
  because the first cycle really was charged.

Also fixes `EcpayBackAuthAuthorizedResult.period`, which was declared but never
populated, so the schedule ECPay echoes on the create response was always dropped.

Note for anyone testing this: **the first cycle is charged at create time**, so
`execTimes: 2` means "now plus one more", not "two future charges".
