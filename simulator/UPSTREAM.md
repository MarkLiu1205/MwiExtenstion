# 上游來源

本資料夾內容複製自 [azhu949/MWICombatSimulator](https://github.com/azhu949/MWICombatSimulator)（其上游為 AmVoidGuy/MWICombatSimulator，MIT 授權）。

- 複製時的上游 commit：`12f1c72251e67a03e39d7fd5a201c7acc1700d64`（main，v3.2.2 之後，2026-11-20 取得）
- 前一次同步：`f52670eedcc8194a67386146e7d728d38175cdae`（v1.0.28，2026-07-20）
- 排除項目：`.git/`、`node_modules/`、`dist/`、`.github/`（部署 workflow 改放在本 repo 根目錄）
- 上游 `.gitignore` 會忽略 `.prettierrc`，但上游 repo 有強制提交；同步後要 `git add -f simulator/.prettierrc`

## 本地補丁清單（同步上游後需重新套用）

1. **繁體中文化**：`scripts/convert-zh-traditional.mjs`（本地新增）＋ `package.json` 的
   `convert-zh-traditional` script 與 `opencc-js` devDependency。轉換 `locales/zh/*` 與 `patchNote.json`
   的中文欄位，並自動更新 manifest 內的 zh 雜湊。
2. **鎖定中文**：`src/ui/i18n/i18n.js` 的 `resolveInitialLanguage` 不讀 localStorage 語言偏好；
   `src/ui/App.vue` 拿掉語言切換按鈕；`src/stores/simulatorStore.js` 的 `ui.language` 固定 `'zh'`；
   `index.html` 的 `lang="zh-Hant"`。
3. **本 repo 的網址與入口**：`src/ui/components/AppSidebar.vue` 的 GitHub 連結改指本 repo、拿掉原作者反饋按鈕；
   `src/ui/config/externalLinks.js` 與 `src/ui/components/home/HomeImportExportModal.vue` 不提供
   GreasyFork 腳本管道（那是上游原版，沒有本站 @match）。
4. **主站匯入腳本**：`scripts/mwi-main-site-import.user.js` 加上本站 `@match`、
   `SIMULATOR_SELF_HOSTED_URL`（預設開啟）、來源白名單與鏡像選單的「自架」選項；中文介面字典與完成訊息轉繁體
   （比對遊戲畫面的選擇器不要轉）。改完後複製一份到 repo 根目錄的 `mwiCombat.js`。
5. **部署後舊分頁自動重新整理**：`src/ui/main.js` 的 `vite:preloadError` / `router.onError` 處理。
6. **刷圖推薦**：
   - `src/services/advisorDomain.js`：`selectedDifficultyTiers`／`selectedZoneHrids` 篩選（預設全選，全取消＝無目標）
   - `src/services/advisorRunExecution.js`、`src/ui/advisorRuntimePresentation.js`：進度顯示目標數與「輪」單位
   - `src/ui/pages/AdvisorPage.vue`：難度逐級勾選、區域過濾面板（改了立即提交 store 並存檔）、配裝切換
     （`HomeLoadoutSelect`）
   - `locales/*/common.json` 的 `advisor.tierFilterLabel`、`phaseQuickDetail`、`phaseRefineDetail`、`roundsUnit`、
     `zoneFilter*`
7. **測試**：配合上述補丁調整的斷言（App 側欄、i18n 繁體字面值等）與刷圖推薦篩選的新增測試。

## 同步上游新版

```sh
git clone --depth 1 https://github.com/azhu949/MWICombatSimulator.git /tmp/mwi-sim-upstream
# 用上游覆蓋 simulator/（保留本檔），再依上面清單重新套用本地補丁
npm ci && npm run convert-zh-traditional
# Node 測試會從 engine/pkg 載入 WASM 引擎（git 忽略、需 wasm-pack 編譯）；
# 沒有 Rust 工具鏈時，可先複製部署用的預編譯版：cp public/engine/pkg/* engine/pkg/
npm test && npm run build && npm run verify-pages-build
```
