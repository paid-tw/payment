# Release & npm OIDC

Mirror of the [`einvoice`](https://github.com/paid-tw/einvoice) release flow.

## Packages published

| Package                     | npm                    |
| --------------------------- | ---------------------- |
| `@paid-tw/payment`          | core                   |
| `@paid-tw/payment-ecpay`    | ECPay AIO + 站內付 2.0 |
| `@paid-tw/payment-payuni`   | PAYUNi                 |
| `@paid-tw/payment-newebpay` | NewebPay (scaffold)    |

## One-time: npm Trusted Publisher (OIDC)

For **each** package above, on [npmjs.com](https://www.npmjs.com/):

1. Package → **Settings** → **Trusted Publisher** → **GitHub Actions**
2. Set:
   - **Organization / user**: `paid-tw`
   - **Repository**: `payment`
   - **Workflow filename**: `publish.yml`
   - **Environment**: (leave empty unless you use GitHub Environments)
3. Save

No long-lived `NPM_TOKEN` is required when OIDC is configured. The workflow uses
`permissions.id-token: write` and `npm publish --provenance`.

> First-time package creation: npm may require a one-time owner login or an
> initial publish with a classic token before Trusted Publishing attaches. Prefer
> creating the empty package + Trusted Publisher on npm UI first, then tag.

## Cut a release

```bash
# 1) Document changes (skip on first 0.1.0 if versions already set)
pnpm changeset
pnpm changeset version   # bumps package.json + CHANGELOG
git add -A && git commit -m "chore: release v0.1.0"

# 2) Tag + push (triggers .github/workflows/publish.yml)
git tag v0.1.0
git push origin main --tags
```

The publish job skips any `name@version` already on the registry.

## After npm is live: point CLI at registry

In `paid-tw/cli` `package.json`, replace `file:../payment/packages/*` with semver ranges:

```json
{
  "dependencies": {
    "@paid-tw/payment": "^0.1.0",
    "@paid-tw/payment-ecpay": "^0.1.0",
    "@paid-tw/payment-newebpay": "^0.1.0",
    "@paid-tw/payment-payuni": "^0.1.0"
  }
}
```

Then `npm install` and publish a new CLI version.

## Local dry-run

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm test
cd packages/payment && pnpm pack && tar tzf *.tgz | head
```
