# MWI 使用者腳本（本地維護版）

[MilkyWayIdle](https://www.milkywayidle.com/) 的 Tampermonkey 腳本集合，基於上游版本加上本地補丁（效能優化、繁體相容、錯誤修復）。

## 腳本一覽

| 檔案 | 用途 |
|---|---|
| mwiTools.js | 綜合工具（市價、行動時間、戰鬥統計、強化模擬、淨資產） |
| profit.js | 利潤面板（收益計算、掉落追蹤、多來源市價合併） |
| maze.js | 迷宮勝率計算器 |
| mooket2.js | 市場歷史價格圖表 |
| mwiCombat.js | 角色/隊伍一鍵匯入戰鬥模擬器 |
| uiEnhace.js | UI 美化 |
| level.js | 戰鬥技能升級所需時間 |

## 安裝（本地檔案直讀）

1. Chrome `chrome://extensions` → Tampermonkey → 開啟「允許存取檔案網址」。
2. Tampermonkey 設定 → 進階模式 → Externals 更新間隔設為「總是」。
3. 產生殼腳本（會依本機路徑生成，換機器或搬資料夾後要重跑）：

   ```sh
   node GenerateStubs.js
   ```

4. 安裝 `tampermonkey-stubs/` 內的 7 個 `.stub.user.js`（名稱帶 `(local)` 後綴）。
5. 停用或刪除原本從 GreasyFork 安裝的同名腳本，避免重複執行。

之後修改本資料夾內的腳本，重新整理遊戲頁面即生效。

## 自架戰鬥模擬器

`simulator/` 是 [azhu949/MWICombatSimulator](https://github.com/azhu949/MWICombatSimulator)（MIT）的副本，
推送到 main 且 `simulator/**` 有變動時，GitHub Actions 會自動建置並部署到
<https://markliu1205.github.io/MwiExtenstion/>。mwiCombat.js 的跳轉選單已內建此自架網址（預設選項）。
本地開發：`cd simulator && npm ci && npm run dev`（跑在 localhost:5173，mwiCombat 也支援）。
上游同步方式見 `simulator/UPSTREAM.md`。

## 更新上游版本

殼腳本已移除 `@updateURL`/`@downloadURL`，不會被自動更新蓋掉本地補丁。要同步上游新版時，把新版下載進本資料夾後用 git diff 對照、重新套用本地補丁。
