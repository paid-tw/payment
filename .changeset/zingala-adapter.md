---
"@paid-tw/payment-zingala": minor
---

feat: add `@paid-tw/payment-zingala` — 中租零卡分期 (Zingala) BNPL

First BNPL adapter, and deliberately **not** a `PaymentProvider`: 零卡分期 is an
underwriting flow, so `applyInstallment` opens a credit application, the outcome arrives
asynchronously after 專人審核, and the terminal success is 撥款 (005) days later rather
than "paid". Method names follow that flow so nothing implies money moved.

A shared `BnplProvider` contract across 中租 / AFTEE / oppay is the goal but is not
defined yet — with one recorded provider it would just be this one wearing generic names.
The entry point records which shapes look Zingala-specific (`comfirm_url`, `fee_type`,
the 期數利率 table) so the eventual contract can exclude them.

Covers `reserve_ec`, `inquiry`, `capture`, `refund`, `check_is_member`, `get_fee`,
`get_bank_branch`, `download_aprvnotice_pdf`, plus the two **inbound** calls 中租 makes
to you: the 審核結果通知 and `comfirm_url`. Not implemented: `reserve_pos` (needs the
consumer app) and `recommend_member` (ships consumer profiling data, so out of scope).

Verified against UAT rather than read off the manual, which turned out to matter:

- **`Digest` is HMAC-SHA256 over the raw response body keyed with the AES key.** The
  manual never says which key signs it, and the one public implementation never verifies
  the header at all. Verification is on by default here — for BNPL the notify is what says
  "approved, ship the goods".
- **`801 此案件消費者尚未確認交易` appears in no manual version through 1.1.14**, whose
  table has no 8xx range. It is what `capture` returns on an unconfirmed order.
- **A missing order is `result: "000"` with `info: []`** — success. `getOrder` turns that
  into `NOT_FOUND`.
- **`reserve_ec` does not check the credit limit**, so a successful reservation says
  nothing about affordability.
- **Re-sending an `order_id` silently overwrites the order** rather than failing.
- **An invalid enum answers `900 系統發生錯誤`**, so 900 must not be retried.
- **The instalment formula truncates** despite the manual labelling it 四捨五入 — its own
  worked example only reproduces with truncation.

`notify.ts` is the one module without recorded payloads behind it: UAT cannot trigger a
notify without the test consumer app and a human reviewer, so its fixtures follow the
manual and should be replaced by a recording when one exists. The README states exactly
which states UAT can and cannot reach.
