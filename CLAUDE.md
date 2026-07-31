# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`payment-tw` — a unified Taiwan payment SDK. One provider-agnostic `PaymentProvider` interface with per-gateway adapter packages (ECPay, PAYUNi, NewebPay). pnpm workspace monorepo mirroring the shape of `@paid-tw/einvoice`.

## Commands

```bash
pnpm install
pnpm build              # tsdown, all packages
pnpm typecheck          # tsc --noEmit per package
pnpm test               # vitest run — offline (MSW), deterministic, CI default
pnpm test:coverage      # enforces thresholds (70% stmts/lines/fns, 55% branches)
pnpm lint               # oxlint --type-aware
pnpm format             # oxfmt --write (format:check in CI)
pnpm check:exports      # publint --strict on every package
```

Run a single test file (no build needed — vitest aliases `@paid-tw/payment` to `packages/payment/src/index.ts`):

```bash
pnpm vitest run packages/payment-ecpay/src/__tests__/notify.test.ts
pnpm vitest run -t "some test name"
```

Live tests against real gateway sandboxes are env-gated with `describe.skipIf` and never run in the normal suite:

```bash
pnpm test:live:ecpay                          # ECPAY_LIVE=1, public stage merchant 3002607
PAYUNI_LIVE=1 PAYUNI_MERCHANT_ID=... pnpm vitest run packages/payment-payuni/src/__tests__/live.test.ts
```

`PAID_DEBUG=1` prints raw gateway payloads — used to re-record the field-exact fixtures that back the offline MSW tests.

## Architecture

- `packages/payment` (`@paid-tw/payment`) — core: `PaymentProvider` interface, request/response types, `Capability` set + `supports`/`assertSupports`, `PaymentError`, `MockProvider`. **Core never depends on adapters**; composition happens in the CLI/app.
- `packages/payment-ecpay`, `payment-payuni`, `payment-newebpay` — one adapter package per vendor, each exporting a factory (`createEcpayProvider(config) => PaymentProvider`).

Contract rules that shape all adapter code:

- Every adapter method rejects with a normalized `PaymentError` (stable `code` like `NOT_FOUND`, plus the gateway's `rawCode`/raw body preserved).
- Optional features are feature-detected via `provider.capabilities`, not duck-typing.
- `createPayment` may return a redirect form, URL, or token depending on the gateway — never assume "already paid".

### ECPay: two API lines, one package

ECPay ships **AIO** (redirect checkout, CheckMacValue signing, `src/provider.ts` + `notify.ts`) and **站內付 2.0 ECPG** (embedded, AES-128-CBC JSON envelope, `src/ecpg/`). Decision (see `docs/ecpay-provider-separation.md`): same npm package, **two factories** — `createEcpayProvider` (name `"ecpay"`) and `createEcpayEcpgProvider` (name `"ecpay-ecpg"`). Do NOT merge them into one instance with a mode switch, and do not split them into separate packages. They share sandbox credentials and `PaymentError`, but not endpoints, notify verification, or create-result shapes. API coverage matrix: `docs/ecpay-api-coverage.md`.

### Test pattern per adapter

Each adapter has an offline suite (MSW server + recorded fixtures in `__tests__/`) and a live counterpart (`*live*.test.ts`) hitting the real stage environment with the same keys. Keep fixtures field-exact with real gateway responses.

## Scope boundaries

In scope: create/get/refund, signing/crypto, endpoints, normalized errors, adapter-specific extensions. Out of scope: merchant onboarding/KYC (→ paid.tw), CLI flags/table output (→ `@paid-tw/cli`).

## Releasing

Never `npm publish` locally. Releases go through git tags → `.github/workflows/publish.yml` → npm OIDC trusted publishing (`changeset version`, commit, push, then `git tag vX.Y.Z && git push origin vX.Y.Z`). Already-published `name@version` pairs are skipped. Full steps: `docs/release.md`.
