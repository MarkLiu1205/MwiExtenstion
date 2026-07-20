# 上游來源

本資料夾內容複製自 [azhu949/MWICombatSimulator](https://github.com/azhu949/MWICombatSimulator)（其上游為 AmVoidGuy/MWICombatSimulator，MIT 授權）。

- 複製時的上游 commit：`f52670eedcc8194a67386146e7d728d38175cdae`（main，2026-07-20 取得）
- 排除項目：`.git/`、`node_modules/`、`dist/`、`.github/`（部署 workflow 改放在本 repo 根目錄）

## 本地補丁清單（同步上游後需重新套用）

1. **繁體中文化**：`scripts/convert-zh-traditional.mjs`（本地新增）＋ `package.json` 的
   `convert-zh-traditional` script 與 `opencc-js` devDependency。`locales/zh/*` 的值已轉為繁體，
   manifest 內的 zh 雜湊由轉換腳本自動更新。
2. **預設語言**：`src/ui/i18n/i18n.js` 未儲存語言偏好時預設 `zh`。
3. **測試字面值**：`src/ui/__tests__/i18nResources.test.js`、
   `src/ui/i18n/__tests__/officialI18nIntegration.test.js`、
   `src/ui/i18n/__tests__/localTranslationData.test.js` 內的簡體斷言值已同步轉為繁體。

## 同步上游新版

```sh
git clone --depth 1 https://github.com/azhu949/MWICombatSimulator.git /tmp/mwi-sim-upstream
rsync -a --delete --exclude .git --exclude node_modules --exclude dist --exclude .github \
  --exclude UPSTREAM.md /tmp/mwi-sim-upstream/ simulator/
git diff              # 用 git diff 找回並重新套用上面的本地補丁
npm ci && npm run convert-zh-traditional && npm test
```
