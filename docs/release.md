# Release（gh tag + npm OIDC）

正式發布路徑：**本機不跑 `npm publish`**，改為推送 git tag，由 GitHub Actions 用 OIDC 發 npm。

與 [`einvoice`](https://github.com/paid-tw/einvoice) / [`cli`](https://github.com/paid-tw/cli) 相同。

## 會發布的套件

| Package | 角色 |
| --- | --- |
| `@paid-tw/payment` | core |
| `@paid-tw/payment-ecpay` | ECPay AIO + 站內付 2.0 |
| `@paid-tw/payment-payuni` | PAYUNi |
| `@paid-tw/payment-newebpay` | NewebPay scaffold |

各套件變更紀錄：`packages/*/CHANGELOG.md`。

## 一次性設定：npm Trusted Publisher

對**每一個**上表 package，在 npmjs.com → **Settings** → **Trusted Publisher** → **GitHub Actions**：

| 欄位 | 值 |
| --- | --- |
| Organization | `paid-tw` |
| Repository | `payment` |
| Workflow filename | `publish.yml` |
| Environment | （空白） |

不需要長期 `NPM_TOKEN`。Workflow：`permissions.id-token: write` + `pnpm pack` + `npm publish --provenance`。

> 若 package 尚不存在於 npm，可先在 npm UI 建立空 package 並綁 Trusted Publisher，再推 tag；或僅在首次用本機 OTP 建檔（例外），之後一律走 OIDC。

## 發版步驟

```bash
# 1) 變更紀錄 + 版本（changesets 或手改）
pnpm changeset                 # 記錄變更
pnpm changeset version         #  bump package.json + CHANGELOG
# 或手改 packages/*/package.json version 與 CHANGELOG.md

git add -A
git commit -m "chore: release v0.1.1"

# 2) 推 main
git push origin main

# 3) tag 觸發 .github/workflows/publish.yml
#    monorepo：一個 tag 會嘗試發布所有尚未上架的 name@version
git tag v0.1.1
git push origin v0.1.1
```

已存在於 registry 的 `name@version` 會被 workflow **skip**，不會覆寫。

## 驗證

```bash
gh run list --workflow=publish.yml --limit 3

npm view @paid-tw/payment version
npm view @paid-tw/payment-ecpay version
```

## Local dry-run（不發佈）

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm test
cd packages/payment && pnpm pack && tar tzf *.tgz | head
```

## CLI

`@paid-tw/cli` 已依賴 registry 上的 `@paid-tw/payment*`（`^0.1.0`）。  
CLI 本身同樣用 **tag + OIDC** 發布：https://github.com/paid-tw/cli/blob/main/docs/release.md
