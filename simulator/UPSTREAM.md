# 上游來源

本資料夾內容複製自 [azhu949/MWICombatSimulator](https://github.com/azhu949/MWICombatSimulator)（其上游為 AmVoidGuy/MWICombatSimulator，MIT 授權）。

- 複製時的上游 commit：`f52670eedcc8194a67386146e7d728d38175cdae`（main，2026-07-20 取得）
- 排除項目：`.git/`、`node_modules/`、`dist/`、`.github/`（部署 workflow 改放在本 repo 根目錄）

## 同步上游新版

```sh
git clone --depth 1 https://github.com/azhu949/MWICombatSimulator.git /tmp/mwi-sim-upstream
rsync -a --delete --exclude .git --exclude node_modules --exclude dist --exclude .github \
  --exclude UPSTREAM.md /tmp/mwi-sim-upstream/ simulator/
git diff   # 檢視差異後再 commit；若本地有補丁需重新套用
```
