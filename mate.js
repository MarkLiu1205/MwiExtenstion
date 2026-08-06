// ==UserScript==
// @name         MWI 市場伴侶 - 備份
// @name:en      MWI Market Mate - Backup
// @name:zh-CN   MWI 市場伴侶 - 備份
// @namespace    https://milkywayidle.com/
// @version      2.3.7
// @description  製作頁/房屋材料自動計算、缺料顯示、購物清單、市場高亮。WS精確庫存+獨立資料層。雙語支援(EN/ZH)。
// @description:en  Crafting/housing material auto-calc, shortage display, shopping list, market highlight. WS inventory + data layer. Bilingual (EN/ZH).
// @description:zh-CN  製作頁/房屋材料自動計算、缺料顯示、購物清單、市場高亮。WS精確庫存+獨立資料層。雙語支援(EN/ZH)。
// @author       ColaCola Stella
// @license      MIT
// @match        https://www.milkywayidle.com/*
// @match        https://milkywayidle.com/*
// @match        https://www.milkywayidlecn.com/*
// @match        https://milkywayidlecn.com/*
// @icon         https://www.milkywayidle.com/favicon.svg
// @grant        none
// @sandbox      raw
// @run-at       document-start
// ==/UserScript==
 
/* ============================================================================
 * MWI 市場伴侶 · 製作缺料計算 / 購物清單 / 市場高亮與預填 / 採購導航
 * ----------------------------------------------------------------------------
 * 分割槽目錄(編輯器內搜尋 "§NN" 跳轉):
 *   §00 腳本配置與選擇器        §01 國際化 i18n           §02 全域狀態 STATE
 *   §02A Store 訂閱中心          §02B 設定 Schema          §03 公共 API MWIMM
 *   §04 資料採集(WS/遊戲資料)   §05 領域邏輯(Z-score/價格/計劃/任務/資料層/配方鏈)
 *   §06 工具區(解析鏈/防注入)   §07(+07A) 業務流程/Actions §08 面板檢測與需求提取
 *   §09 嵌入式渲染(徽章/鏈樹/摘要)                        §10A 雙形態殼 UI(Shadow DOM)
 *   §11 重新整理與守護(看門狗)      §12 周邊(快捷鍵/預填/採購導航)
 *   §13 樣式注入                §14 啟動
 * ----------------------------------------------------------------------------
 * 設計要點(語義不變數,改動前必讀):
 *   · 資料優先順序:WS 截獲 > localStorage 快取(自帶 LZ 解壓優先,頁面全域僅兜底)
 *     > window.mwi;資料層未就緒時落 DOM 解析回退,並帶懶重試自愈。
 *   · 防注入:DOM 解析只信帶遊戲 CSS-Modules 類名的節點,數值越界一律按解析失敗,
 *     斜槓右側數字恆為總需求量(絕不再乘次數)。
 *   · 徽章:data-mm-badge 屬性 + ::after 渲染;重繪由資料簽名快取把守,跳繪前
 *     做逐行完整性核對(部分被第三方抹除也會觸發補繪),看門狗每秒兜底。
 *   · 快捷鍵:購齊事件裝填、fire-once;觸發監聽器冪等重掛 ×4 時機 + window/document
 *     雙層冗餘 + 事件打戳去重(免疫啟動期文件重寫清空監聽器)。
 *   · 診斷:控制台 MWIMM.__selftest() / __probe() / __key() / __log()(log 匯出),判定不說謊、檢出即自愈。
 * ----------------------------------------------------------------------------
 * 公共 API: window.MWIMM   
 * ----------------------------------------------------------------------------
 * Other userscripts / plugins can interact with Market Mate via window.MWIMM.
 * 其他使用者腳本/外掛可通過 window.MWIMM 與本外掛互動。
 *
 * ── 檢測就緒 / Detecting readiness ──────────────────────────────────────────
 *   if (window.MWIMM && window.MWIMM.ready) { ... }
 *   // or wait via event:
 *   const onReady = () => { ... };
 *   if (window.MWIMM?.ready) onReady();
 *   else window.MWIMM?.on('ready', onReady);
 *
 * ── 欄位 / Fields ───────────────────────────────────────────────────────────
 *   version       string   plugin version, e.g. "1.7.0"
 *   apiVersion    number   public API version (bumped on breaking changes)
 *   ready         boolean  init() finished
 *
 * ── 購物車讀取 (read-only) ──────────────────────────────────────────────────
 *   getCartItems()                → CartItem[]    (deep clone, safe to mutate)
 *   getCartItem(itemId)           → CartItem | null
 *   hasCartItem(itemId)           → boolean
 *   getCartCount()                → number
 *
 *   CartItem = {
 *     itemId:    string   // bare id, e.g. "oak_log"
 *     name:      string   // localized display name
 *     quantity:  number   // remaining quantity to purchase
 *     starred:   boolean
 *     threshold: number | null    // reserve threshold, null if unset
 *     source:    string | null    // origin tag ("manual" / "material" / "api" ...)
 *     updatedAt: string | null    // ISO timestamp
 *   }
 *
 * ── 購物車寫入 / Cart mutations ─────────────────────────────────────────────
 *   addToCart(item | item[])      → { ok, added, skipped }
 *      Accumulating add (existing items get their quantity increased).
 *      item = { itemId, quantity, name?, iconRef?, source? }
 *      itemId accepts "oak_log" / "/items/oak_log" / "#oak_log".
 *      quantity must be > 0 (otherwise the entry is skipped).
 *
 *   setCartItemQuantity(itemId, quantity) → { ok }
 *      Overwrites the quantity (in contrast to addToCart's accumulation).
 *      quantity = 0 removes the item (starred items are kept at 0).
 *
 *   removeFromCart(itemId)        → { ok }
 *   clearCart({ includeStarred = false } = {}) → { ok }
 *
 * ── 物品/市場 / Item & marketplace helpers ──────────────────────────────────
 *   resolveItemName(itemId)       → string    // localized display name
 *   openMarketplace(itemId)       → boolean   // open the in-game market panel
 *   normalizeItemId(itemId)       → string    // strip "/items/" or "#" prefix
 *
 * ── 事件 / Events ───────────────────────────────────────────────────────────
 *   on(event, handler) / off(event, handler)
 *      'ready'        handler({ version, apiVersion })
 *      'cart:change'  handler({ items })       fires after the cart is persisted
 *
 * ── 示例 / Example ──────────────────────────────────────────────────────────
 *   // Add 100 sugar and 50 egg to the shopping list:
 *   MWIMM.addToCart([
 *     { itemId: 'sugar',  quantity: 100 },
 *     { itemId: 'egg', quantity: 50  }
 *   ]);
 *
 *   // React to changes:
 *   MWIMM.on('cart:change', ({ items }) => {
 *     console.log('cart now has', items.length, 'items');
 *   });
 *
 *   // Jump to the marketplace for a specific item:
 *   MWIMM.openMarketplace('sugar');
 * ============================================================================
 */
 
(function () {
    "use strict";
 
    // 顯式執行在頁面主環境，不使用跨沙箱 unsafeWindow 函式橋。
    const PAGE_WINDOW = window;
 
    /** 腳本元資訊及 localStorage 鍵名 */
 
    // ════════════════════════════════════════════════════════════════════════
    // §00 腳本配置與選擇器
    //     SCRIPT 常量(localStorage 鍵名,不得改動) / SEL / MARKET_SEL
    // ════════════════════════════════════════════════════════════════════════
 
    const SCRIPT = {
        id: "mwi-missing-cart-cn",
        version: "2.3.7",
        cartKey: "mwi_missing_cart_v1",         // 購物車持久化
        plansKey: "mwi_crafting_plans_v1",      // 製作計劃持久化
        togglesKey: "mwi_missing_cart_toggles_v1"    // 開關狀態
    };
 
    // ── 診斷 log —— 環形緩衝(零打擾觀測,非防禦層)──────────────
    //    目的:出問題時使用者只需在控制台執行 MWIMM.__log() 並把輸出全文貼給作者,
    //    即可離線定位根因。設計約束:不向控制台增噪(靜默入緩衝)、重複事件摺疊
    //    為 ×N、容量封頂 400 條、記錄儀自身任何異常都被吞掉(絕不反傷宿主)。
    //    [mwi-mm] 字首的既有 console 輸出經鉤子自動入流水,其他腳本的日誌不收。
    const _log = {
        _buf: [], _cap: 400, _t0: Date.now(), _lastKey: "",
        _fmtArg(a) {
            try {
                if (typeof a === "string") return a;
                if (a instanceof Error) return a.message + " | " + String(a.stack || "").split("\n")[1];
                return JSON.stringify(a).slice(0, 160);
            } catch (e) { return String(a); }
        },
        note(tag, msg) {
            try {
                msg = String(msg).slice(0, 240);
                const key = tag + "|" + msg;
                const last = this._buf[this._buf.length - 1];
                if (key === this._lastKey && last) { last.n++; last.t2 = Date.now(); return; }
                this._buf.push({ t: Date.now(), t2: 0, tag, msg, n: 1 });
                if (this._buf.length > this._cap) this._buf.splice(0, this._buf.length - this._cap);
                this._lastKey = key;
            } catch (e) { /* 記錄儀永不拋錯 */ }
        },
        hookErrors() {
            try {
                window.addEventListener("error", (ev) => {
                    const f = String(ev.filename || "");
                    this.note("uncaught", (ev.message || "?") + " @" + f.slice(-48) + ":" + (ev.lineno || 0));
                });
                window.addEventListener("unhandledrejection", (ev) => {
                    this.note("unhandled", this._fmtArg(ev.reason));
                });
            } catch (e) { /* ignore */ }
        },
        dump() {
            const rel = (t) => "+" + ((t - this._t0) / 1000).toFixed(1) + "s";
            return this._buf.map(e =>
                rel(e.t) + " [" + e.tag + "] " + e.msg + (e.n > 1 ? " ×" + e.n + "(至" + rel(e.t2) + ")" : "")
            ).join("\n");
        }
    };
    _log.hookErrors();   // 不再猴補丁全域 console(避免同頁其他腳本的日誌來源被改寫為本檔案)
 
    /** 遊戲 DOM 選擇器（技能製作面板 & 房屋建造面板） */
    const SEL = {
        detailRoot: '[class*="SkillActionDetail_skillActionDetail"]',       // 技能詳情根節點
        regularComponent: '[class*="SkillActionDetail_regularComponent"]', // 常規材料區域
        requirements: '[class*="SkillActionDetail_itemRequirements"]',     // 材料需求容器
        requirementItems: '[class*="Item_itemContainer"]',                 // 單個材料項
        requirementInventory: '[class*="SkillActionDetail_inventoryCount"]', // 庫存數量
        requirementInput: '[class*="SkillActionDetail_inputCount"]',       // 所需數量
        upgradeContainer: '[class*="SkillActionDetail_upgradeItemSelectorInput"]', // 升級物品選擇器
        actionCountInput: '[class*="SkillActionDetail_maxActionCountInput"] input[class*="Input_input"]', // 行動次數輸入
        actionContainer: '[class*="SkillActionDetail_actionContainer"]',   // 行動容器
        itemCore: '[class*="Item_item__"]',         // 物品核心元素
        itemCount: '[class*="Item_count"]',          // 物品數量標籤
        houseRoot: '[class*="HousePanel_modalContent"]',        // 房屋面板根
        houseRequirements: '[class*="HousePanel_itemRequirements"]', // 房屋材料需求
        houseInventory: '[class*="HousePanel_inventoryCount"]',     // 房屋庫存顯示
        houseInput: '[class*="HousePanel_inputCount"]',             // 房屋所需數量
        houseCosts: '[class*="HousePanel_costs"]',                  // 房屋費用
        houseUpgradeBtn: '[class*="HousePanel_upgradeButton"]'      // 房屋升級按鈕
    };
 
    // ── 市場彈窗選擇器 ────────────────────────────────
    const MARKET_SEL = {
        modalContainer: '[class*="Modal_modalContainer"]',
        modalContent: '[class*="MarketplacePanel_modalContent"]',
        header: '[class*="MarketplacePanel_header"]',
        itemIcon: '[class*="MarketplacePanel_itemContainer"] svg use',
        priceInput: '[class*="MarketplacePanel_priceInput"]',
        quantityContainer: '[class*="MarketplacePanel_quantityInputs"]',
        quantityInput: '[class*="MarketplacePanel_quantityInputs"] input[class*="Input_input"]',
        submitButton: 'button[class*="Button_success"]',
        labelElement: '[class*="MarketplacePanel_label"]',
        marketPanel: '[class*="MarketplacePanel_marketplacePanel"]',
    };
 
 
    // ════════════════════════════════════════════════════════════════════════
    // §01 國際化 i18n
    //     _I18N 詞典(228 鍵) / _loadLangPref / t() —— 跟隨遊戲 i18nextLng
    // ════════════════════════════════════════════════════════════════════════
 
    // ── 國際化 (i18n) 雙語支援 ─────────────────────────────
    //   ★ 始終自動跟隨遊戲 i18nextLng 語言設定，不再手動切換。
 
    let _currentLang = "zh"; // 預設中文
 
    /** 從遊戲 i18nextLng 自動檢測語言 */
    function _loadLangPref() {
        try {
            const gameLang = localStorage.getItem("i18nextLng") || "";
            _currentLang = gameLang.startsWith("zh") ? "zh" : "en";
        } catch { /* ignore */ }
    }
 
    /** 獲取當前 locale（用於 localeCompare 排序） */
    function _getLocale() {
        return _currentLang === "zh" ? "zh-Hans-CN" : "en";
    }
 
    // 啟動時立即讀取偏好
    _loadLangPref();
 
    /** 翻譯對映表 */
    const _I18N = {
        // ── 通用 ──
        "unknown_item": { zh: "未知物品", en: "Unknown Item" },
        "upgrade_item": { zh: "升級物品", en: "Upgrade Item" },
        "item": { zh: "物品", en: "Item" },
 
 
 
        // ── 購物車內容 ──
        "shortage_n": { zh: "缺{0}", en: "Need {0}" },
 
 
 
        // ── 摘要面板 ──
        "summary_missing": { zh: "缺 {0} 種 / {1} 件", en: "{0} types / {1} pcs short" },
        "summary_sufficient": { zh: "材料充足", en: "Materials sufficient" },
        "add_to_cart": { zh: "加入購物清單", en: "Add to Shopping List" },
        "plan_count_label": { zh: "計劃次數", en: "Planned actions" },
        "data_layer_tag": { zh: "⚡資料層", en: "⚡DataLayer" },
        "artisan_tag": { zh: "工匠-{0}%", en: "Artisan-{0}%" },
        "has_plan_tag": { zh: "已有計劃", en: "Has Plan" },
        "create_plan_chk": { zh: "建計劃", en: "Create plan" },
        "toast_plan_completed": { zh: "✅ 計劃完成：{0}", en: "✅ Plan completed: {0}" },
        // ── 計劃庫存鎖定提示 ──
        "locked_badge": { zh: "🔒{0}", en: "🔒{0}" },
        "locked_hover_title": { zh: "已被其他計劃鎖定：", en: "Locked by other plans:" },
        "locked_hover_line": { zh: "  {0} · {1}", en: "  {0} · {1}" },
        "summary_locked_tag": { zh: "🔒鎖 {0} 種", en: "🔒 {0} types locked" },
        "summary_locked_hover_item": { zh: "{0} · 共鎖 {1}", en: "{0} · total {1} locked" },
        "summary_locked_hover_sub": { zh: "    · {0} · {1}", en: "    · {0} · {1}" },
 
 
        // ── 採購導航 ──
        "nav_short": { zh: "缺 {0}", en: "Need {0}" },
        "nav_done_chip": { zh: "✓ 已購齊", en: "✓ Done" },
        "nav_progress": { zh: "待購 {0} / {1}", en: "{0} / {1} left" },
        "nav_item_done": { zh: "✅ {0} 已購齊", en: "✅ {0} fulfilled" },
        "nav_next_label": { zh: "下一項：{0} ×{1}", en: "Next: {0} ×{1}" },
        "nav_next_btn": { zh: "採購下一個 ▶", en: "Next item ▶" },
        "nav_all_done": { zh: "🎉 購物清單全部購齊！", en: "🎉 All items purchased!" },
        "prefill_tag": { zh: "已預填", en: "Pre-filled" },
 
        // ── Toast 訊息 ──
        "toast_plan_done": { zh: "✅ 製作計劃完成：{0}", en: "✅ Crafting plan done: {0}" },
        "toast_auto_removed": { zh: "已自動移除 {0} 種已補齊的物品", en: "Auto-removed {0} fulfilled item(s)" },
        "toast_refill_one": { zh: "「{0}」庫存不足，已自動回填缺料", en: '"{0}" stock low, auto-refilled shortage' },
        "toast_refill_multi": { zh: "「{0}」等 {1} 種物品庫存不足，已自動回填", en: '"{0}" and {1} other item(s) low, auto-refilled' },
        "toast_all_fulfilled": { zh: "購物清單已全部補齊，自動收起", en: "All items fulfilled, auto-collapsed" },
        "toast_no_missing": { zh: "當前沒有需要補充的材料", en: "No materials needed" },
        "toast_no_id": { zh: "缺料已識別，但未拿到可加入清單的物品ID", en: "Shortage found but no valid item IDs" },
        "toast_added_skipped": { zh: "已加入 {0} 種，跳過 {1} 種無ID物品", en: "Added {0}, skipped {1} (no ID)" },
        "toast_added": { zh: "已加入購物清單：{0} 種，數量 {1}", en: "Added to list: {0} types, qty {1}" },
 
        // ── 狀態/日誌 ──
        "action_added_to_cart": { zh: "已將缺料加入購物清單", en: "Added shortage to shopping list" },
        "action_calculated": { zh: "已計算缺料：{0} 種，{1}", en: "Calculated: {0} types, {1} short" },
        "action_sufficient": { zh: "已計算缺料：材料充足", en: "Calculated: materials sufficient" },
        "action_startup": { zh: "v{0} 已啟動（{1}，{2}，{3}，資料來源:{4}），等待開啟製作/房屋/市場彈窗", en: "v{0} started ({1}, {2}, {3}, src:{4}), waiting for panel" },
        "ws_exact": { zh: "WS精確", en: "WS" },
        "ws_waiting": { zh: "等待WS", en: "WS pending" },
        "dl_ok": { zh: "資料層✓", en: "DataLayer✓" },
        "dl_fallback": { zh: "DOM回退", en: "DOM fallback" },
        "plans_n": { zh: "{0}計劃", en: "{0} plans" },
        "no_plans": { zh: "無計劃", en: "No plans" },
        "cache": { zh: "快取", en: "cache" },
 
 
 
        // ── Z-score 安全邊際 ──
        "zscore_tag": { zh: "備料 {0}", en: "Buffer {0}" },
        "zscore_hover": { zh: "期望 {0} + 餘量 {1} = {2}", en: "Expected {0} + margin {1} = {2}" },
 
        // ── 餘量標記 ──
        "surplus_n": { zh: "餘{0}", en: "+{0}" },
 
        // ── 配方鏈遞迴解算 ──
        "add_chain": { zh: "加入全鏈材料", en: "Add Full Chain" },
        "chain_title": { zh: "升級鏈 ({0}步)", en: "Upgrade Chain ({0} steps)" },
        "chain_current": { zh: "當前", en: "Current" },
        "chain_step_from": { zh: "升級自", en: "From" },
        "chain_tail": { zh: "鏈尾", en: "Base" },
        "toast_chain_added": { zh: "已加入完整配方鏈：{0} 種原始材料，數量 {1}", en: "Added full chain: {0} leaf materials, qty {1}" },
 
 
 
 
        // ── Next item 快捷鍵 ──
        "shortcut_hint_set_title": { zh: "當前快捷鍵，點選修改", en: "Current shortcut, click to edit" },
        "shortcut_hint_unset": { zh: "未設定快捷鍵", en: "No shortcut" },
        "shortcut_hint_unset_title": { zh: "點選進入設定面板", en: "Click to open settings" },
        "toast_shortcut_set": { zh: "快捷鍵已設定：{0}", en: "Shortcut set: {0}" },
    };
 
    /**
     * 翻譯函式：根據當前語言獲取翻譯文本，支援 {0}, {1}... 佔位符
     * @param {string} key - 翻譯鍵
     * @param {...any} args - 佔位符參數
     * @returns {string}
     */
    function t(key, ...args) {
        const entry = _I18N[key];
        if (!entry) return key;
        let text = entry[_currentLang] || entry["zh"] || key;
        for (let i = 0; i < args.length; i++) {
            text = text.replace(`{${i}}`, String(args[i] ?? ""));
        }
        return text;
    }
 
 
    /**
     * §02 全域執行時狀態(上帝物件,拆解進行中)
     * 僅按三組重排欄位書寫順序並標註歸屬,欄位名與初值不變。
     *   [D] 領域資料  → 後續遷入 Store
     *   [S] 設定開關  → 後續遷入 Settings schema(經 saveToggles/loadToggles 持久化)
     *   [R] 執行時/UI → 後續留在 UI / Guard 區區域性變數
     */
    const STATE = {
        // ── [D] 領域資料 ─────────────────────────────────────────────
        cart: new Map(),              // 購物車內容（itemId → CartRow）
        craftingPlans: new Map(),     // 製作計劃（actionHrid → Plan）
        // ── [S] 設定開關(持久化於 SCRIPT.togglesKey) ────────────────
        craftingPlansEnabled: true,   // 製作計劃功能開關
        locateEnabled: true,          // 市場定位開關
        includeUpgrade: true,         // 是否包含升級物品缺料
        inventorySyncEnabled: true,   // 庫存同步開關
        autoCollapseEnabled: true,    // 自動收起開關
        autoPrefillEnabled: true,     // 市場彈窗自動預填數量
        purchaseNavEnabled: true,     // 採購導航條
        zScoreIndex: 0,               // 備料餘量檔位（Z_OPTIONS 索引）
        zScoreThreshold: 10,          // 備料餘量起算次數：行動次數 > 此值才補料；以內按實際向上取整
        guzzlingPouchLevel: -1,       // -1 = 自動檢測；0-20 = 手動指定
        priceEnabled: true,           // 價格顯示開關
        cartTotalEnabled: true,       // 購物車總價顯示開關
        questPanelEnabled: true,      // 任務追蹤功能開關
        nextItemShortcut: null,       // {code, display, ctrl, shift, alt, meta} | null
        edgeZoneWidth: 10,            // -右緣熱區寬度 px;0=停用熱區(只留小手柄)
        // ── [R] 執行時 / UI 狀態(不持久化) ──────────────────────────
        currentModal: null,           // 當前檢測到的彈窗 DOM
        currentData: null,            // 當前提取的缺料資料
        lastDataSignature: "",        // 上次資料簽名（用於跳過相同資料的重繪）
        refreshTimer: null,           // 重新整理定時器 ID
        lastAction: "",               // 狀態列文字
        suppressObserverDepth: 0,     // Observer 抑制深度計數
        enhCooldownUntil: 0,          // 強化面板重建冷卻期截止時間戳
        lastNonEmptyModal: null,      // 上一個有有效資料的 modal DOM 引用
        observer: null,               // 全域 MutationObserver
        gameRootObserved: null,       // 主 observer 當前所掛的節點(現固定為 document.body)
        marketTargetItemId: "",       // 當前市場定位目標物品 ID
        marketMatchCount: 0,          // 市場定位匹配數
        marketPanelVisible: false,    // 市場面板是否可見
        manualActionCount: 1,         // 手動行動次數
        chainTreeOpen: false,         // 升級鏈樹是否展開
        chainStepUnchecked: new Set() // 鏈樹中被使用者取消勾選的步驟 stepHrid(會話級;重繪時據此還原勾選態)
    };
 
    let _fiberHostCache = null;         // React Fiber 宿主快取（用於呼叫 goToMarketplace）
    let _fiberHostCachedAt = 0;         // 快取時間戳
    const FIBER_CACHE_TTL = 15000;      // Fiber 快取過期時間（ms）
    const FIBER_MAX_DEPTH = 300;        // Fiber 樹遍歷最大深度
 
 
    // ════════════════════════════════════════════════════════════════════════
    // §02A Store —— 領域資料訂閱中心
    //     目標:業務函式改完資料後只調 Store.notify(主題),UI 自行訂閱重繪,
    //           實現核心與介面解耦(完成接線)。
    //     設計約束:
    //       · 資料本體暫仍存於 STATE / _wsInventory / _marketDataCache;
    //         Store 先只提供"通知通道 + 統一隻讀入口",零引用改動 = 零破壞風險
    //       · 不引入任何外部庫;監聽器逐個 try/catch,單個出錯不波及其餘
    // ════════════════════════════════════════════════════════════════════════
    const Store = (() => {
        /** topic → Set<fn> */
        const _listeners = new Map();
        /** 合法主題(寫錯主題名 console.warn 提示,便於排查) */
        const TOPICS = ["cart", "plans", "quests", "inventory", "prices", "settings", "ui", "theme"];
 
        function _assertTopic(topic) {
            if (!TOPICS.includes(topic)) console.warn("[mwi-mm][Store] 未知主題:", topic);
        }
 
        /** 訂閱;返回退訂函式 */
        function subscribe(topic, fn) {
            _assertTopic(topic);
            if (!_listeners.has(topic)) _listeners.set(topic, new Set());
            _listeners.get(topic).add(fn);
            return () => { _listeners.get(topic)?.delete(fn); };
        }
 
        /** 通知該主題的全部監聽器 */
        function notify(topic, payload) {
            _assertTopic(topic);
            const set = _listeners.get(topic);
            if (!set || set.size === 0) return;
            for (const fn of set) {
                try { fn(payload); } catch (err) {
                    console.warn("[mwi-mm][Store] 監聽器異常:", topic, err);
                }
            }
        }
 
        return {
            TOPICS, subscribe, notify,
            // ── 統一隻讀入口(當前委託既有資料來源;後續資料遷移時呼叫方無感) ──
            get cart() { return STATE.cart; },
            get plans() { return STATE.craftingPlans; },
            /** 除錯:各主題當前監聽器數量 */
            _debug() {
                const out = {};
                for (const [k, v] of _listeners) out[k] = v.size;
                return out;
            }
        };
    })();
    console.info("[mwi-mm] §02A Store 已接線(主題 cart/ui/plans/quests)");
 
    // ════════════════════════════════════════════════════════════════════════
    // §02B 設定 Schema
    //     宣告式設定表:§07 的 saveToggles / loadToggles 據此通用讀寫。
    //     持久化鍵、JSON 欄位名與順序、各欄位校驗語義與舊版 完全一致。
    //     UI 標籤/描述暫仍在 §10 舊 UI 與 i18n;新 UI 落地時再併入本表。
    //     validate 僅在 loadToggles 執行時呼叫,可安全引用其後定義的常量(如 Z_OPTIONS)。
    // ════════════════════════════════════════════════════════════════════════
    const SETTINGS_SCHEMA = [
        { key: "locateEnabled",        type: "bool" },                                                  // 市場定位
        { key: "includeUpgrade",       type: "bool" },                                                  // 含升級物品
        { key: "inventorySyncEnabled", type: "bool" },                                                  // 庫存同步
        { key: "autoCollapseEnabled",  type: "bool" },                                                  // 自動收起
        { key: "autoPrefillEnabled",   type: "bool" },                                                  // 市場預填
        { key: "purchaseNavEnabled",   type: "bool" },                                                  // 採購導航
        { key: "craftingPlansEnabled", type: "bool" },                                                  // 製作計劃
        { key: "questPanelEnabled",    type: "bool" },                                                  // 任務追蹤
        { key: "zScoreIndex",          type: "num", validate: v => v >= 0 && v < Z_OPTIONS.length },    // 備料餘量檔位
        { key: "zScoreThreshold",      type: "num", validate: v => v >= 1 && v <= 1000000 },            // 備料餘量起算次數
        { key: "guzzlingPouchLevel",   type: "num", validate: v => v >= -1 && v <= 20 },                // 暴飲袋等級
        { key: "priceEnabled",         type: "bool" },                                                  // 價格顯示
        { key: "cartTotalEnabled",     type: "bool" },                                                  // 總價顯示
        { key: "nextItemShortcut",     type: "shortcut" },                                              // 下一項快捷鍵
        { key: "edgeZoneWidth",        type: "num", validate: v => v >= 0 && v <= 24 }                  // 熱區寬度
    ];
 
 
    // ════════════════════════════════════════════════════════════════════════
    // §03 公共 API window.MWIMM
    //     apiVersion 相容承諾:對外欄位與方法簽名不得改變
    // ════════════════════════════════════════════════════════════════════════
 
    // ── 公共 API（window.MWIMM）────────────────────────────
    //   暴露給其他 userscript / 外掛使用。詳見腳本頂部的註釋文件。
    //   所有方法都做了 try/catch 防禦，絕不拋異常打斷呼叫方。
    //   寫操作複用內部的 _addToCartCore / saveCart / Store.notify 路徑，
    //   保證 UI、持久化、庫存同步與人工操作完全一致。
    const _apiInternal = {
        handlers: { "ready": [], "cart:change": [] },
        fireDepth: 0,
 
        fire(event, dataOrFn) {
            const list = this.handlers[event];
            if (!list || !list.length) return;
            // 簡單的重入保護，避免監聽器內同步觸發再觸發導致棧溢位
            if (this.fireDepth > 4) {
                console.warn("[mwi-mm] API event re-entry depth exceeded, dropping:", event);
                return;
            }
            const data = (typeof dataOrFn === "function") ? (() => { try { return dataOrFn(); } catch (e) { return null; } })() : dataOrFn;
            this.fireDepth++;
            try {
                // 複製一份再迭代，防止監聽器在回撥中調 off() 改動陣列
                const snapshot = list.slice();
                for (const fn of snapshot) {
                    try { fn(data); } catch (e) { console.error("[mwi-mm] API handler error (" + event + "):", e); }
                }
            } finally {
                this.fireDepth--;
            }
        },
 
        markReady() {
            if (_publicAPI.ready) return;
            _publicAPI.ready = true;
            this.fire("ready", { version: SCRIPT.version, apiVersion: 1 });
        }
    };
 
    function _apiSnapshotRow(row) {
        if (!row) return null;
        return {
            itemId: row.itemId,
            name: resolveCartDisplayName(row),
            quantity: Number(row.quantity || 0),
            starred: !!row.starred,
            threshold: (typeof row.threshold === "number" && row.threshold > 0) ? row.threshold : null,
            source: row.source || null,
            updatedAt: row.updatedAt || null
        };
    }
 
    const _publicAPI = {
        version: SCRIPT.version,
        apiVersion: 1,
        ready: false,
 
        // ── 購物車讀取 ──
        getCartItems() {
            try {
                const out = [];
                for (const row of STATE.cart.values()) {
                    const snap = _apiSnapshotRow(row);
                    if (snap) out.push(snap);
                }
                return out;
            } catch (e) { console.error("[mwi-mm] API getCartItems error:", e); return []; }
        },
 
        getCartItem(itemId) {
            try {
                const id = normalizeCartItemId(itemId);
                if (!id) return null;
                return _apiSnapshotRow(STATE.cart.get(id));
            } catch (e) { console.error("[mwi-mm] API getCartItem error:", e); return null; }
        },
 
        hasCartItem(itemId) {
            try {
                const id = normalizeCartItemId(itemId);
                return id ? STATE.cart.has(id) : false;
            } catch (e) { return false; }
        },
 
        getCartCount() {
            try { return STATE.cart.size; } catch (e) { return 0; }
        },
 
        // ── 購物車寫入 ──
        addToCart(itemOrArray) {
            try {
                const items = Array.isArray(itemOrArray) ? itemOrArray : [itemOrArray];
                let added = 0, skipped = 0;
                for (const item of items) {
                    if (!item || typeof item !== "object") { skipped++; continue; }
                    if (_addToCartCore({
                        itemId: item.itemId,
                        name: item.name,
                        iconRef: item.iconRef,
                        quantity: item.quantity,
                        source: item.source || "api"
                    })) added++;
                    else skipped++;
                }
                if (added > 0) { saveCart(); Store.notify("cart"); }
                return { ok: true, added, skipped };
            } catch (e) {
                console.error("[mwi-mm] API addToCart error:", e);
                return { ok: false, error: String(e), added: 0, skipped: 0 };
            }
        },
 
        setCartItemQuantity(itemId, qty) {
            try {
                const id = normalizeCartItemId(itemId);
                if (!id) return { ok: false, reason: "invalid_itemId" };
                const n = Number(qty);
                if (!Number.isFinite(n) || n < 0) return { ok: false, reason: "invalid_quantity" };
                const row = STATE.cart.get(id);
                if (n <= 0) {
                    if (!row) return { ok: true };
                    if (row.starred) row.quantity = 0;
                    else STATE.cart.delete(id);
                } else if (row) {
                    row.quantity = n;
                    row.baselineStock = getInventoryCount(id);
                    row.updatedAt = nowIso();
                    row._manualOverrideUntil = Date.now() + 5 * 60 * 1000;
                } else {
                    // 新增：直接借用 _addToCartCore（不存在時會以 quantity = n 插入）
                    _addToCartCore({ itemId: id, quantity: n, source: "api" });
                }
                saveCart(); Store.notify("cart");
                return { ok: true };
            } catch (e) {
                console.error("[mwi-mm] API setCartItemQuantity error:", e);
                return { ok: false, error: String(e) };
            }
        },
 
        removeFromCart(itemId) {
            try {
                const id = normalizeCartItemId(itemId);
                if (!id) return { ok: false, reason: "invalid_itemId" };
                if (!STATE.cart.has(id)) return { ok: false, reason: "item_not_found" };
                STATE.cart.delete(id);
                saveCart(); Store.notify("cart");
                return { ok: true };
            } catch (e) {
                console.error("[mwi-mm] API removeFromCart error:", e);
                return { ok: false, error: String(e) };
            }
        },
 
        clearCart(opts) {
            try {
                const includeStarred = !!(opts && opts.includeStarred);
                if (includeStarred) {
                    STATE.cart.clear();
                } else {
                    for (const [id, row] of STATE.cart) {
                        if (!row.starred) STATE.cart.delete(id);
                    }
                }
                saveCart(); Store.notify("cart");
                return { ok: true };
            } catch (e) {
                console.error("[mwi-mm] API clearCart error:", e);
                return { ok: false, error: String(e) };
            }
        },
 
        // ── 物品/市場輔助 ──
        resolveItemName(itemId) {
            try {
                const id = normalizeCartItemId(itemId);
                if (!id) return "";
                if (_dataLayer && _dataLayer.ready) {
                    const name = _dataLayer.hridToName("/items/" + id);
                    if (name) return name;
                }
                const row = STATE.cart.get(id);
                return row ? (row.name || id) : id;
            } catch (e) { return ""; }
        },
 
        openMarketplace(itemId) {
            try {
                const id = normalizeCartItemId(itemId);
                if (!id) return false;
                return openMarketplaceByCore(id) === true;
            } catch (e) { console.error("[mwi-mm] API openMarketplace error:", e); return false; }
        },
 
        normalizeItemId(itemId) {
            try { return normalizeCartItemId(itemId); } catch (e) { return ""; }
        },
 
        // ── 事件 ──
        on(event, handler) {
            try {
                if (!_apiInternal.handlers[event] || typeof handler !== "function") return false;
                _apiInternal.handlers[event].push(handler);
                // 已經 ready 時為 'ready' 監聽器立即派發一次（晚到的監聽器也能收到）
                if (event === "ready" && _publicAPI.ready) {
                    try { handler({ version: SCRIPT.version, apiVersion: 1 }); }
                    catch (e) { console.error("[mwi-mm] API late ready handler error:", e); }
                }
                return true;
            } catch (e) { return false; }
        },
 
        off(event, handler) {
            try {
                const list = _apiInternal.handlers[event];
                if (!list) return false;
                const idx = list.indexOf(handler);
                if (idx === -1) return false;
                list.splice(idx, 1);
                return true;
            } catch (e) { return false; }
        }
    };
 
    // ── 內建自檢(除錯用;雙下劃線字首 = 不屬於穩定 API 面)──
    //    全部檢查只讀無副作用:不寫 localStorage、不動購物車、不觸發渲染主題。
    //    用法:F12 控制台執行 MWIMM.__selftest()
    _publicAPI.__selftest = function () {
        const results = [];
        const check = (name, fn) => {
            try {
                const v = fn();
                results.push({ 專案: name, 結果: v === true ? "✓" : "✗", 備註: v === true ? "" : String(v) });
            } catch (err) { results.push({ 專案: name, 結果: "✗", 備註: String(err) }); }
        };
        check("Store 訂閱/通知/退訂", () => {
            let hits = 0;
            const un = Store.subscribe("settings", () => { hits++; });
            Store.notify("settings"); un(); Store.notify("settings");
            return hits === 1 || ("命中 " + hits + " 次(期望 1)");
        });
        check("parseCompactNumber", () =>
            (parseCompactNumber("1.2k") === 1200 && parseCompactNumber("3,500") === 3500
             && parseCompactNumber("∞") === Infinity) || "解析結果異常");
        check("normalizeCartItemId", () =>
            (normalizeCartItemId("/items/cheese") === "cheese" && normalizeCartItemId("#milk") === "milk")
            || "歸一化異常");
        check("金幣識別使用精確 ID", () =>
            (isCoinItem("coin") === true && isCoinItem("/items/coin") === true
             && isCoinItem("catalyst_of_coinification") === false && isCoinItem("gold_guild_credit") === false)
            || "含 coin/gold 的普通物品被誤判為金幣");
        check("formatQty", () => (formatQty(1234) === "1234" && formatQty(1.5) === "1.5") || "格式化異常");
        check("設定 Schema 序列化往返", () => {
            const out = {};
            for (const def of SETTINGS_SCHEMA) out[def.key] = STATE[def.key];
            const back = JSON.parse(JSON.stringify(out));
            for (const def of SETTINGS_SCHEMA) {
                if (JSON.stringify(back[def.key]) !== JSON.stringify(STATE[def.key])) return def.key + " 不一致";
            }
            return true;
        });
        check("Actions 完整性", () =>
            Object.values(Actions).every(f => typeof f === "function") || "存在非函式項");
        check("防注入·textWithoutInjected", () => {
            // 離體 DOM,只讀自檢:模擬第三方外掛往遊戲數量元素裡注入金額文本
            const host = document.createElement("div");
            host.className = "SkillActionDetail_inputCount__26AOJ";
            host.appendChild(document.createTextNode("0 / 4 "));
            const evil = document.createElement("span");
            evil.className = "thirdparty-price";
            evil.textContent = "57,419,680,725";
            host.appendChild(evil);
            const txt = textWithoutInjected(host);
            if (/57/.test(txt)) return "注入金額未被剔除: " + txt;
            if (!/4/.test(txt)) return "遊戲自有文本被誤刪: " + txt;
            return true;
        });
        check("防注入·readActionCount 鉗制", () => {
            const modal = document.createElement("div");
            const box = document.createElement("div");
            box.className = "SkillActionDetail_maxActionCountInput__3pKt0";
            const evil = document.createElement("span");
            evil.className = "profit-injected";
            evil.textContent = "143,459,201,800";
            box.appendChild(evil);
            modal.appendChild(box);
            const r = readActionCount(modal);
            return (r.value === 1 && !r.infinite) || ("期望回退為 1,實得 " + r.value);
        });
        check("防注入·行級鉗制 rowLooksSane", () =>
            (rowLooksSane(100, 4) === true && rowLooksSane(57419680725 * 10000, 4) === false
             && rowLooksSane(100, 57419680725) === false && rowLooksSane(-5, 4) === false)
            || "鉗制判定異常");
        check("防注入·斜槓右側=總量+有損吸附(MWI_Toolkit)", () => {
            // Toolkit 把 inputCount 改寫成 "␣/ 302K␣"(截斷、庫存抹掉);
            // 右側按總量處理(防平方爆炸);K 截斷經整數吸附重建精確總量。
            const r = resolveNeed("\u00A0/ 302K\u00A0", 151096);   // 截圖實測場景
            if (r.totalNeeded !== 302192) return "totalNeeded=" + r.totalNeeded + "(期望吸附重建為 302192)";
            if (r.needPerAction !== 2) return "needPerAction=" + r.needPerAction + "(期望 2)";
            const native = resolveNeed("1,434 / 4", 1);
            if (!(native.totalNeeded === 4 && native.stockOverride === 1434)) return "原生格式迴歸失敗";
            const exact = resolveNeed("\u00A0/ 302,192\u00A0", 151096);
            return exact.totalNeeded === 302192 || "無後綴精確值被誤吸附";
        });
        results.push({ 專案: "主題令牌", 結果: "ℹ", 備註: "內建暗色(固定)" });
        results.push({ 專案: "狀態報告", 結果: "ℹ", 備註:
            "dataLayer:" + (_dataLayer.ready ? "✓" : "…") + " ws:" + (_wsInventory.ready ? "✓" : "…")
            + " cart:" + STATE.cart.size + " plans:" + STATE.craftingPlans.size
            + " ver:" + SCRIPT.version });
        try { console.table(results); } catch (err) { console.log(results); }
        const fails = results.filter(r => r.結果 === "✗").length;
        console.info("[mwi-mm] __selftest 完成:" + (fails === 0 ? "全部通過" : fails + " 項失敗"));
        return results;
    };
 
    // ── log 匯出(除錯用;只讀)── F12 執行 MWIMM.__log(),全選複製輸出貼給作者
    _publicAPI.__log = function () {
        const lines = [];
        try {
            lines.push("══════ MWI 市場伴侶 log ══════");
            lines.push("版本 " + SCRIPT.version + " | 匯出於 " + new Date().toISOString() + " | 啟動後 " + ((Date.now() - _log._t0) / 1000).toFixed(0) + "s");
            lines.push("UA " + String(navigator.userAgent).slice(0, 120));
            try {
                const st = {};
                for (const f of SETTINGS_SCHEMA) st[f.key] = STATE[f.key];
                lines.push("設定 " + JSON.stringify(st));
            } catch (e) { lines.push("設定 <讀取失敗:" + e.message + ">"); }
            try {
                lines.push("資料層 ready=" + _dataLayer.ready + " | 快取診斷=" + JSON.stringify(_dataLayer._cacheReadDiag || null));
            } catch (e) { lines.push("資料層 <讀取失敗>"); }
            try {
                lines.push("看門狗 ticks=" + _wdTicks + " | 快捷鍵最近收鍵 " + (_shortcutManager._lastKeySeenAt ? ((Date.now() - _shortcutManager._lastKeySeenAt) / 1000).toFixed(0) + "s 前" : "(無)") + " | window.mwi=" + (typeof PAGE_WINDOW.mwi !== "undefined"));
            } catch (e) { /* ignore */ }
            lines.push("—— 事件流水(重複摺疊為 ×N)——");
            lines.push(_log.dump() || "(空)");
            lines.push("══════ 記錄結束 ══════");
        } catch (e) { lines.push("<匯出異常:" + (e && e.message) + ">"); }
        const out = lines.join("\n");
        console.log(out);
        return out;
    };
 
    // ── 提取路徑體檢(除錯用;只讀)── F12 執行 MWIMM.__probe()
    //    回答「當前面板的徽章數字走的哪條路徑,資料層為什麼沒接住」。
    //    資料層路徑用遊戲內部精確值(免疫第三方 DOM 改寫);DOM 回退路徑解析屏上文本,
    //    遇 MWI_Toolkit 截斷格式(302,192→"302K")會有 <1K 的尾數偏差(吸附已大幅緩解)。
    _publicAPI.__probe = function () {
        try {
            const modal = findActiveModal();
            if (!modal) { console.info("[mwi-mm] __probe: 當前無可見技能詳情面板(製作/鍊金/強化)"); return null; }
            const ctx = resolveActionContext(modal);
            const report = {
                標題: _extractPanelTitle(modal),
                行動識別: ctx ? { actionHrid: ctx.actionHrid, function: ctx.fn, 來源: "React Fiber" } : { 來源: "Fiber 失敗,回退 DOM 類名: " + (_inferFunctionFromDom(modal) || "未知") },
                資料層就緒: _dataLayer.ready, WS庫存就緒: _wsInventory.ready,
                次數讀取: readActionCount(modal),
            };
            const data = extractRequirements(modal);
            report.實際路徑 = data._dataLayerUsed ? "資料層(精確)" : "DOM(解析屏上文本)";
            report.行數 = (data.requirements || []).length;
            report.缺料 = (data.missingList || []).map(r => (r.name || r.itemId) + ":" + formatQty(r.missingRounded));
            if (!data._dataLayerUsed && _dataLayer.ready && (!ctx || ctx.fn === "/action_functions/production")) {
                const trace = [];
                try { _buildRequirementsFromData(modal, trace, ctx); } catch (err) { trace.push("拋異常: " + err); }
                report.資料層放棄原因 = trace.length ? trace : ["(未觸發任何放棄點,請截圖回報)"];
            } else if (!_dataLayer.ready) {
                // 現場重試一次快取讀取,帶回逐級解碼診斷
                const cached = _readClientDataFromCache();
                if (cached && !_capturedClientData) _capturedClientData = cached;
                report.快取診斷 = _cacheReadDiag || "(未執行)";
                report.資料來源 = {
                    WS截獲: Boolean(_capturedClientData?.actionDetailMap),
                    全域LZString: typeof LZString !== "undefined",
                    "window.mwi": Boolean(PAGE_WINDOW.mwi?.initClientData?.actionDetailMap)
                };
                if (cached || _capturedClientData?.actionDetailMap) {
                    report.資料層放棄原因 = ["快取現已可讀,嘗試就地初始化: " + (_dataLayer.ensureReady() ? "✓ 成功(重新打開面板生效)" : "init 失敗,見上方診斷")];
                } else {
                    report.資料層放棄原因 = ["三個資料來源均不可用,逐級診斷見「快取診斷」"];
                }
            }
            console.info("[mwi-mm] __probe:", report);
            return report;
        } catch (err) { console.warn("[mwi-mm] __probe:", err); }
    };
 
    // ── 快捷鍵體檢(除錯用;只讀不搶鍵)── F12 執行 MWIMM.__key()
    //    20 秒內每次按鍵列印完整決策鏈,定位「為什麼沒觸發」:
    //    錄製中? / 快捷鍵已設? / 已裝填(購齊橫幅)? / 焦點元素? / code+修飾鍵匹配?
    _publicAPI.__key = function (seconds = 20) {
        try {
            const until = Date.now() + seconds * 1000;
            // 到點必拆:舊版只在「超時後又按一次鍵」時才移除,呼叫後不再按鍵就永久殘留,重複呼叫逐次疊加
            const expireTimer = setTimeout(() => {
                window.removeEventListener("keydown", probe, true);
                console.info("[mwi-mm] __key 體檢結束");
            }, seconds * 1000 + 100);
            const probe = (e) => {
                if (Date.now() > until) { clearTimeout(expireTimer); window.removeEventListener("keydown", probe, true); console.info("[mwi-mm] __key 體檢結束"); return; }
                const s = STATE.nextItemShortcut;
                const ae = document.activeElement;
                const aeTag = ae ? (ae.tagName + (ae.isContentEditable ? "(可編輯)" : "")) : "無";
                const inputFocused = Boolean(ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT" || ae.isContentEditable));
                const armedId = _shortcutManager._armedNextItemId;
                const cartRow = armedId ? STATE.cart.get(armedId) : null;
                const verdict = _shortcutManager._captureMode ? "✗ 錄製中(抑制觸發)"
                    : !s ? "✗ 未設定快捷鍵"
                    : !armedId ? "✗ 未裝填 —— 需要先出現「已購齊→下一個」橫幅(購齊事件)"
                    : inputFocused ? "✗ 焦點在輸入框/編輯器,設計放行不搶鍵"
                    : !_shortcutManager._matches(e, s) ? ("✗ 按鍵不匹配(按下 " + e.code + ",已設 " + s.code + ")")
                    : (!cartRow || cartRow.quantity <= 0) ? ("△ 五門已過但裝填目標已過期(清單無 " + armedId + " 或數量為0)—— 會自愈改跳,留意上一行日誌")
                    : "✓ 應當觸發(若仍未跳轉,看「管理器收鍵」與控制台是否有跳轉失敗告警)";
                // defaultPrevented = 觸發監聽器已搶鍵的鐵證;心跳戳證明監聽器線上
                // 檢出視窗層失聯即就地重掛(自愈),並播報重掛計數
                const handled = e.defaultPrevented;
                const seen = _shortcutManager._lastKeySeenAt && (Date.now() - _shortcutManager._lastKeySeenAt < 500);
                if (!seen) {
                    try { _shortcutManager._ensureListener(); } catch (err) { /* ignore */ }
                    console.warn("[mwi-mm] __key: 檢出監聽器失聯,已就地重掛(累計第 " + _shortcutManager._repinCount + " 次),請再按一次驗證");
                }
                console.info("[mwi-mm] __key:", { 按下: e.code, 修飾: { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey }, 已設: s ? s.code : null, 已裝填: armedId || null, 裝填目標在清單: Boolean(cartRow && cartRow.quantity > 0), 焦點: aeTag, 管理器收鍵: seen ? "✓" : "✗(已自動重掛)", 已搶鍵preventDefault: handled, 重掛計數: _shortcutManager._repinCount, 判定: verdict });
            };
            window.addEventListener("keydown", probe, true);
            console.info("[mwi-mm] __key 體檢開始:" + seconds + " 秒內按任意鍵檢視決策鏈(建議在購齊橫幅出現後按你設的快捷鍵)");
            return { 已設: STATE.nextItemShortcut, 已裝填: _shortcutManager._armedNextItemId || null };
        } catch (err) { console.warn("[mwi-mm] __key:", err); }
    };
 
    // ── 新殼開關(除錯用;不屬於穩定 API 面)──
    //    MWIMM.__shell(false) 關閉並解除安裝新桌面殼;__shell(true) 開啟並掛載;__shell() 檢視狀態
    _publicAPI.__shell = function (enable) {
        try {
            if (enable === true || enable === false) {
                // 僅會話級掛卸(除錯用,不再持久化;介面常駐)
                if (enable) _newShell.init(); else _newShell.destroy();
            }
            return { mounted: Boolean(_newShell.host),
                     form: _newShell._form, detent: _newShell._detent,
                     edgeZoneWidth: STATE.edgeZoneWidth, ui: { ..._newShell._ui } };
        } catch (err) { console.warn("[mwi-mm] __shell:", err); }
    };
 
 
 
 
    // 立即掛到 window，讓隨後載入的其他腳本可檢測到
    try {
        PAGE_WINDOW.MWIMM = _publicAPI;
    } catch (e) {
        console.error("[mwi-mm] failed to expose window.MWIMM:", e);
    }
 
 
    // ════════════════════════════════════════════════════════════════════════
    // §04 資料採集 Adapters
    //     _wsInventory / WS 截獲遊戲資料(LZ) / _marketDataCache / _wsDrinkSlots
    //     唯一允許接觸遊戲內部協議的區域;本區任何對外介面不得改變
    // ════════════════════════════════════════════════════════════════════════
 
    // ── WebSocket 精確庫存追蹤 ──────────────────────
    //   通過攔截 WebSocket 訊息獲取精確的物品庫存，比 DOM 掃描更準確。
    //   改用 hash 主鍵儲存 + 僅聚合 inventory 位置，
    //   修復強化場景中同 (itemHrid, enhLevel) 多條目互相覆蓋導致庫存歸零的問題。
    // 市場成交回執跟蹤：infoNotification.buyOrderCompleted 明確給出真實成交數量。
    // 先按該回執扣清單，再遮蔽緊隨其後的同筆正向庫存 delta，避免重複扣減。
    const _marketPurchaseTracker = {
        TTL: 30000,
        _suppressNextPositive: new Map(),
 
        captureConfirmation(obj) {
            try {
                if (obj?.type !== "info" || obj.message !== "infoNotification.buyOrderCompleted") return;
                const vars = new Map((Array.isArray(obj.variables) ? obj.variables : [])
                    .filter(v => v && v.name)
                    .map(v => [v.name, v.data]));
                const itemId = normalizeCartItemId(vars.get("itemHrid"));
                const quantity = Math.max(0, Math.floor(Number(vars.get("count")) || 0));
                if (!itemId || quantity <= 0) return;
                if (applyConfirmedMarketPurchaseToCart(itemId, quantity)) {
                    this._suppressNextPositive.set(itemId, { expiresAt: Date.now() + this.TTL });
                    _log.note("market-buy", `server confirmed ${itemId} x${quantity}`);
                }
            } catch (e) { _log.note("market-buy", "成交回執處理失敗(清單可能未扣減): " + (e?.message || e)); }
        },
 
        consumeSuppression(itemId, delta) {
            if (!(delta > 0)) return false;
            const pending = this._suppressNextPositive.get(itemId);
            if (!pending) return false;
            this._suppressNextPositive.delete(itemId);
            if (Date.now() > pending.expiresAt) return false;
            _log.note("market-buy", `suppressed duplicate inventory delta ${itemId} +${delta}`);
            return true;
        }
    };
 
    const _wsInventory = {
        _hashMap: new Map(),    // hash → { itemHrid, itemLocationHrid, enhancementLevel, count }
        _detailMap: new Map(),  // hrid → Map<enhancementLevel, count>（僅 inventory 的聚合檢視）
        ready: false,           // 是否已收到初始資料
        _callbacks: [],         // onChange 回撥列表
 
        /** 初始化：清空並載入角色物品列表（init_character_data 時呼叫） */
        init(characterItems) {
            this._hashMap.clear();
            this._detailMap.clear();
            if (!Array.isArray(characterItems)) return;
            for (const item of characterItems) {
                if (!item || !item.itemHrid) continue;
                const key = item.hash || `${item.itemLocationHrid || ""}::${item.itemHrid}::${item.enhancementLevel || 0}`;
                this._hashMap.set(key, {
                    itemHrid: item.itemHrid,
                    itemLocationHrid: item.itemLocationHrid || "",
                    enhancementLevel: item.enhancementLevel || 0,
                    count: item.count || 0,
                });
            }
            this._rebuildDetailMap();
        },
 
        /** 增量更新：合併 endCharacterItems delta 到庫存對映 */
        _patch(items) {
            if (!Array.isArray(items)) return;
            // 先保留訊息前快照，讓購物清單按「單條 WS 訊息」計算入庫量。
            // 這樣購買前的消耗與隨後的購買不會被合併成庫存淨變化。
            const beforeSnapshot = this.getSnapshot();
            for (const item of items) {
                if (!item || !item.itemHrid) continue;
                const key = item.hash || `${item.itemLocationHrid || ""}::${item.itemHrid}::${item.enhancementLevel || 0}`;
                this._hashMap.set(key, {
                    itemHrid: item.itemHrid,
                    itemLocationHrid: item.itemLocationHrid || "",
                    enhancementLevel: item.enhancementLevel || 0,
                    count: item.count || 0,
                });
            }
            this._rebuildDetailMap(beforeSnapshot);
        },
 
        /**
         * 從 hashMap 重建 detailMap（僅統計 inventory 位置的物品）
         * ★ 關鍵修復:
         *   1. 只統計背包中的物品，忽略裝備欄/其他位置 → 防止裝備覆蓋背包庫存
         *   2. 同 (hrid, level) 的多個 hash 條目累加 → 防止強化重置時新舊棧互相覆蓋
         */
        _rebuildDetailMap(beforeSnapshot = null) {
            this._detailMap.clear();
            for (const item of this._hashMap.values()) {
                if (item.itemLocationHrid && item.itemLocationHrid !== "/item_locations/inventory") continue;
                if (!this._detailMap.has(item.itemHrid)) {
                    this._detailMap.set(item.itemHrid, new Map());
                }
                const levels = this._detailMap.get(item.itemHrid);
                const level = item.enhancementLevel || 0;
                levels.set(level, (levels.get(level) || 0) + (item.count || 0));
            }
            this.ready = true;
            let change = { source: "init", deltas: null };
            if (beforeSnapshot instanceof Map) {
                const afterSnapshot = this.getSnapshot();
                const ids = new Set([...beforeSnapshot.keys(), ...afterSnapshot.keys()]);
                const deltas = new Map();
                for (const id of ids) {
                    const delta = (afterSnapshot.get(id) || 0) - (beforeSnapshot.get(id) || 0);
                    if (delta !== 0) deltas.set(id, delta);
                }
                change = { source: "patch", deltas };
            }
            this._fireCallbacks(change);
        },
 
        /** 獲取指定物品的基礎等級（enhancementLevel=0）庫存數 */
        getCount(rawItemId) {
            const bare = String(rawItemId || "").replace(/^\/items\//, "");
            const hrid = `/items/${bare}`;
            const levels = this._detailMap.get(hrid);
            if (!levels) return 0;
            return levels.get(0) || 0;
        },
 
        /**
         * 獲取指定物品在所有位置中裝備的最高強化等級
         * 用於查詢非 inventory 的裝備（如 guzzling_pouch 在 /item_locations/pouch）
         * 返回 -1 表示未找到
         */
        getEquippedLevel(itemHrid) {
            const hrid = itemHrid.startsWith("/items/") ? itemHrid : `/items/${itemHrid}`;
            let maxLevel = -1;
            for (const item of this._hashMap.values()) {
                if (item.itemHrid !== hrid) continue;
                if (item.count > 0 && item.enhancementLevel > maxLevel) {
                    maxLevel = item.enhancementLevel;
                }
            }
            return maxLevel;
        },
 
        /** 匯出庫存快照（bareId → count），用於與 DOM 掃描方式統一介面 */
        getSnapshot() {
            const result = new Map();
            for (const [hrid, levels] of this._detailMap) {
                const bareId = hrid.replace(/^\/items\//, "");
                const count = levels.get(0) || 0;
                if (count > 0) result.set(bareId, count);
            }
            return result;
        },
 
        /** 註冊庫存變更回撥 */
        onChange(cb) {
            if (typeof cb === "function") this._callbacks.push(cb);
        },
 
        /** 觸發所有註冊的回撥 */
        _fireCallbacks(change) {
            for (const cb of this._callbacks) {
                try { cb(change); } catch (e) { _log.note("inv-cb", "庫存變更回撥拋錯: " + (e?.message || e)); }
            }
        }
    };

    // ── WS 截獲的遊戲資料（解除 Mooket 依賴）───────────
    let _capturedClientData = null;
 
    /** 最小化 LZString.decompressFromUTF16（MIT License, Copyright (c) pieroxy） */
    function _lzDecompressUTF16(input) {
        if (input == null || input === "") return "";
        const f = function (index) { return input.charCodeAt(index) - 32; };
        const length = input.length;
        const resetValue = 16384;
        let dictionary = [], enlargeIn = 4, dictSize = 4, numBits = 3, entry = "", result = [], w, c, bits, resb, maxpower, power;
        let data = { val: f(0), position: resetValue, index: 1 };
        for (let i = 0; i < 3; i++) dictionary[i] = i;
        bits = 0; maxpower = Math.pow(2, 2); power = 1;
        while (power !== maxpower) {
            resb = data.val & data.position;
            data.position >>= 1;
            if (data.position === 0) { data.position = resetValue; data.val = f(data.index++); }
            bits |= (resb > 0 ? 1 : 0) * power;
            power <<= 1;
        }
        switch (bits) {
            case 0: bits = 0; maxpower = Math.pow(2, 8); power = 1;
                while (power !== maxpower) { resb = data.val & data.position; data.position >>= 1; if (data.position === 0) { data.position = resetValue; data.val = f(data.index++); } bits |= (resb > 0 ? 1 : 0) * power; power <<= 1; }
                c = String.fromCharCode(bits); break;
            case 1: bits = 0; maxpower = Math.pow(2, 16); power = 1;
                while (power !== maxpower) { resb = data.val & data.position; data.position >>= 1; if (data.position === 0) { data.position = resetValue; data.val = f(data.index++); } bits |= (resb > 0 ? 1 : 0) * power; power <<= 1; }
                c = String.fromCharCode(bits); break;
            case 2: return "";
        }
        dictionary[3] = c; w = c; result.push(c);
        while (true) {
            if (data.index > length) return "";
            bits = 0; maxpower = Math.pow(2, numBits); power = 1;
            while (power !== maxpower) { resb = data.val & data.position; data.position >>= 1; if (data.position === 0) { data.position = resetValue; data.val = f(data.index++); } bits |= (resb > 0 ? 1 : 0) * power; power <<= 1; }
            switch (c = bits) {
                case 0: bits = 0; maxpower = Math.pow(2, 8); power = 1;
                    while (power !== maxpower) { resb = data.val & data.position; data.position >>= 1; if (data.position === 0) { data.position = resetValue; data.val = f(data.index++); } bits |= (resb > 0 ? 1 : 0) * power; power <<= 1; }
                    dictionary[dictSize++] = String.fromCharCode(bits); c = dictSize - 1; enlargeIn--; break;
                case 1: bits = 0; maxpower = Math.pow(2, 16); power = 1;
                    while (power !== maxpower) { resb = data.val & data.position; data.position >>= 1; if (data.position === 0) { data.position = resetValue; data.val = f(data.index++); } bits |= (resb > 0 ? 1 : 0) * power; power <<= 1; }
                    dictionary[dictSize++] = String.fromCharCode(bits); c = dictSize - 1; enlargeIn--; break;
                case 2: return result.join("");
            }
            if (enlargeIn === 0) { enlargeIn = Math.pow(2, numBits); numBits++; }
            if (dictionary[c]) entry = dictionary[c];
            else if (c === dictSize) entry = w + w.charAt(0);
            else return null;
            result.push(entry);
            dictionary[dictSize++] = w + entry.charAt(0);
            enlargeIn--;
            if (enlargeIn === 0) { enlargeIn = Math.pow(2, numBits); numBits++; }
            w = entry;
        }
    }
 
    /** 從 localStorage 讀取 LZ 壓縮的遊戲初始化資料（initClientData）
     *  重寫:舊實現是「全域 LZString 存在就只用它」——若頁面全域是別的腳本留下的
     *  壞/不相容實現,解出 null 後不會落到自帶解壓器,資料層整鏈失敗(實測 __probe:
     *  資料層就緒=false,而 MWI_Toolkit 在自己沙箱用真庫解同一份資料成功,證明資料無恙;
     *  自帶解壓器經 1.19MB 中文 JSON 映象迴歸與真 lz-string 逐位元組一致)。
     *  現改為逐級落穿:全域 LZString → 自帶實現 → 明文 JSON,每級獨立 try,
     *  並把每級結果記入 _cacheReadDiag 供 __probe 展示。 */
    let _cacheReadDiag = null;
    function _readClientDataFromCache() {
        const diag = { raw: null, steps: [] };
        _cacheReadDiag = diag;
        try {
            const raw = localStorage.getItem("initClientData");
            if (!raw) { diag.raw = "無(localStorage 鍵不存在)"; return null; }
            diag.raw = "存在,長度 " + raw.length;
            const tryParse = (json, tag) => {
                if (!json || typeof json !== "string") { diag.steps.push(tag + ": 解壓結果為空"); return null; }
                if (json.charCodeAt(0) !== 123) { diag.steps.push(tag + ": 解壓結果非 JSON(首字元 " + json.charCodeAt(0) + ")"); return null; }
                try {
                    const parsed = JSON.parse(json);
                    if (parsed && parsed.actionDetailMap) { diag.steps.push(tag + ": ✓ 成功"); parsed._src = "localStorage(" + tag + ")"; return parsed; }
                    diag.steps.push(tag + ": JSON 可解析但無 actionDetailMap");
                    return null;
                } catch (e) { diag.steps.push(tag + ": JSON.parse 失敗 " + e); return null; }
            };
            // 1) 自帶解壓實現優先(確定性高於來歷不明的頁面全域)
            try {
                const hit = tryParse(_lzDecompressUTF16(raw), "自帶解壓");
                if (hit) return hit;
            } catch (e) { diag.steps.push("自帶解壓: 拋異常 " + e); }
            // 2) 頁面全域 LZString 降級為兜底(自帶實現萬一失手時的第二意見)
            if (typeof LZString !== "undefined" && LZString.decompressFromUTF16) {
                try {
                    const hit = tryParse(LZString.decompressFromUTF16(raw), "全域LZString");
                    if (hit) return hit;
                } catch (e) { diag.steps.push("全域LZString: 拋異常 " + e); }
            } else { diag.steps.push("全域LZString: 不存在"); }
            // 3) 明文兜底(遊戲將來若不壓縮)
            try {
                const hit = tryParse(raw, "明文JSON");
                if (hit) return hit;
            } catch (e) { diag.steps.push("明文JSON: 拋異常 " + e); }
            return null;
        } catch (e) {
            diag.steps.push("外層異常: " + e);
            console.warn("[mwi-mm] localStorage initClientData 讀取失敗:", e);
            return null;
        }
    }
 
    // ── WS 市場資料快取 ────────────────────────────────
    /** 市場訂單簿快取（WS 推送更新） */
    const _marketDataCache = {
        _cache: new Map(),   // itemHrid → { asks, bids, updatedAt }
        _callbacks: [],      // onChange 回撥列表
 
        /** 更新指定物品的市場訂單簿資料 */
        update(data) {
            if (!data?.marketItemOrderBooks) return;
            const { itemHrid, orderBooks } = data.marketItemOrderBooks;
            if (!itemHrid || !orderBooks?.[0]) return;
            const book = orderBooks[0];
            this._cache.set(itemHrid, {
                asks: Array.isArray(book.asks) ? book.asks : [],
                bids: Array.isArray(book.bids) ? book.bids : [],
                updatedAt: Date.now()
            });
            this._fireCallbacks(itemHrid);
        },
 
        /** 按 hrid 獲取快取的訂單簿 */
        get(itemHrid) { return this._cache.get(itemHrid) || null; },
        /** 按 bareId（不帶 /items/ 字首）獲取 */
        getByBareId(bareId) { return this.get(`/items/${bareId}`); },
 
        /** 獲取最低賣價掛單 */
        getBestAsk(itemHrid) {
            const data = this.get(itemHrid);
            if (!data?.asks?.length) return null;
            return data.asks.reduce((best, a) => (!best || a.price < best.price) ? a : best, null);
        },
 
        /** 獲取最高買價掛單 */
        getBestBid(itemHrid) {
            const data = this.get(itemHrid);
            if (!data?.bids?.length) return null;
            return data.bids.reduce((best, b) => (!best || b.price > best.price) ? b : best, null);
        },
 
        /** 註冊訂單簿變更回撥 */
        onChange(cb) { if (typeof cb === "function") this._callbacks.push(cb); },
 
        _fireCallbacks(itemHrid) {
            for (const cb of this._callbacks) {
                try { cb(itemHrid); } catch (e) { _log.note("book-cb", "訂單簿回撥拋錯: " + (e?.message || e)); }
            }
        }
    };
 
    // ── WS 飲品插槽快取（解除 React Fiber 依賴）─────────
    //   通過 WS 截獲 actionTypeDrinkSlotsMap，替代脆弱的 React Fiber 訪問。
    //   用於精確檢測工匠茶（artisan_tea）是否在製作類技能的飲品欄中。
    const _wsDrinkSlots = {
        _map: {},  // actionType → ConsumableSlot[]（如 {"/action_types/crafting": [{itemHrid: "/items/artisan_tea", ...}]}）
 
        /** 從 init_character_data 初始化 */
        init(drinkSlotsMap) {
            if (drinkSlotsMap && typeof drinkSlotsMap === "object") {
                this._map = drinkSlotsMap;
            }
        },
 
        /** 從 action_type_consumable_slots_updated 更新 */
        update(drinkSlotsMap) {
            if (drinkSlotsMap && typeof drinkSlotsMap === "object") {
                this._map = drinkSlotsMap;
            }
        },
 
        /** 檢查指定 actionType 是否裝備了某種飲品 */
        hasDrink(actionType, itemHrid) {
            const slots = this._map[actionType];
            if (!Array.isArray(slots)) return false;
            return slots.some(s => s && s.itemHrid === itemHrid);
        },
 
        /** 獲取指定 actionType 的飲品列表 */
        getSlots(actionType) {
            return this._map[actionType] || [];
        }
    };
 
 
 
    // ════════════════════════════════════════════════════════════════════════
    // §04B 主題令牌
    //     執行時取色已整體移除:遊戲按鈕/彈窗取樣在實戰中不夠穩定
    //     (accent 漂移等),正式版收斂為與遊戲同系的內建暗色板。
    //     金色調為 #e8c87f(較 v1 的 #e9bf41 降飽和提亮度,可讀性優先)。
    //     結構保留 ORDER / STATIC / tokens / init 供 §10A 消費,介面不變。
    // ════════════════════════════════════════════════════════════════════════
    const _themeProbe = {
        ORDER: ["pageBg", "panelBg", "cardBg", "line", "text", "textMut", "accent", "gold", "radius"],
        STATIC: {
            pageBg: "#1b1f30", panelBg: "#252a40", cardBg: "#333a57",
            line: "rgba(160,170,220,0.14)", text: "#eef0fa", textMut: "#a7aecf",
            accent: "#5667d6", gold: "#e8c87f", radius: "8px"
        },
        tokens: null, sources: null,
        init() {
            this.tokens = { ...this.STATIC };
            this.sources = {};
            for (const key of this.ORDER) this.sources[key] = "builtin";
        }
    };
 
    // ════════════════════════════════════════════════════════════════════════
    // §05 領域邏輯 Domain
    //     Z-score / _marketPrice / _craftingPlanTracker / _questTracker / _dataLayer / _recipeChain
    //     純計算,不碰 DOM;後續可針對本區做 fixture 回放自檢
    // ════════════════════════════════════════════════════════════════════════
 
    // ── Z-score 安全邊際常量與計算模組 ──────────────────
    const Z_OPTIONS = [
        { z: 1.645, zh: "標準", en: "Standard", pct: "95%" },
        { z: 2.326, zh: "充足", en: "Ample",    pct: "99%" },
        { z: 3.090, zh: "十足", en: "Full",     pct: "99.9%" },
        { z: 0,     zh: "關閉", en: "Off",       pct: null }
    ];
 
    const ENHANCEMENT_BONUSES = [
        0.00, 0.02, 0.042, 0.066, 0.092, 0.12, 0.15, 0.182,
        0.216, 0.255, 0.29, 0.33, 0.372, 0.416, 0.462, 0.51,
        0.56, 0.612, 0.666, 0.722, 0.78
    ];
 
    const _zScoreCalc = {
        /**
         * 按工匠茶真實機制計算材料需求量（依據官方 Wiki：減料後每次需求 r=base×(1−p)，
         * 整數部分必耗，小數部分 f 是「多耗 1 個」的機率 → 每次消耗 ~ floor(r)+Bernoulli(f)）。
         * @param {number} base - 每次製作的單項基礎材料消耗
         * @param {number} n    - 製作次數
         * @param {number} p    - 工匠茶節省比例
         * @param {number} z    - 餘量 z 值（0 = 不補料，按期望向上取整）
         * @returns {{ expected: number, margin: number, total: number }}
         */
        calcMaterials(base, n, p, z) {
            if (n <= 0) return { expected: 0, margin: 0, total: 0 };
            if (p >= 1) return { expected: 0, margin: 0, total: 0 };
            const r = base * (1 - p);                 // 減料後每次需求（可能含小數）
            const expectedRaw = r * n;                // 期望總消耗
            const f = r - Math.floor(r);              // 小數部分 = Wiki「該項被消耗的機率」
            // 整數情形（f≈0，零波動）/ 無工匠 / z=0（次數未超閾值或關閉）→ 不補料，精確向上取整
            if (z <= 0 || p <= 0 || f < 1e-9) {
                const val = Math.ceil(expectedRaw - 1e-9);
                return { expected: val, margin: 0, total: val };
            }
            // 每次消耗為 floor(r)+Bernoulli(f)，N 次總方差 = n·f(1−f)
            const stddev = Math.sqrt(n * f * (1 - f));
            const margin = z * stddev;
            const cap = n * Math.ceil(r);             // 絕對上界：每次都頂格消耗 ceil(r)
            const total = Math.min(cap, Math.ceil(expectedRaw + margin));
            return { expected: Math.ceil(expectedRaw - 1e-9), margin: Math.ceil(margin), total };
        },
 
        /** 生成 hover 提示文字：「期望 472 + 餘量 15 = 487」 */
        formatBreakdown(base, n, p, z) {
            const { expected, margin, total } = this.calcMaterials(base, n, p, z);
            return t("zscore_hover", expected, margin, total);
        },
 
        /** 獲取當前啟用的 Z 值 */
        getActiveZ() {
            return Z_OPTIONS[STATE.zScoreIndex]?.z || 0;
        },
 
        /** 次數門控：行動次數 ≤ 起算次數則不補料（返回 0），否則返回當前檔位 z */
        _effectiveZ(n) {
            const thr = Number(STATE.zScoreThreshold) || 0;
            return (Number(n) > thr) ? this.getActiveZ() : 0;
        },
 
        /** 當前檔位的本地化標籤，如「標準(95%)」 */
        activeLabel() {
            const o = Z_OPTIONS[STATE.zScoreIndex];
            if (!o) return "";
            return (_currentLang === "zh" ? o.zh : o.en) + (o.pct ? "(" + o.pct + ")" : "");
        }
    };
 
    // ── 市場價格資料模組 ──────────────────────────────────
    const _marketPrice = {
        _cache: null,           // Map<bareId, { ask, bid, avg, vol }>
        _lastFetch: 0,
        _loading: false,
        _inFlight: null,
        _error: false,
        _nextRetryAt: 0,
        REFRESH_INTERVAL: 3600_000, // 1 小時
        RETRY_INTERVAL: 60_000,     // 失敗後 1 分鐘重試，避免短時故障導致本會話永久失效
        FETCH_TIMEOUT: 15_000,      // ★ 網路超時（15秒）
        STORAGE_KEY: "mwi_mm_market_price_cache_v1", // ★ 持久化快取鍵
 
        /** ★ 從 localStorage 恢復上次拉取的價格（頁面重新整理時免重新拉取） */
        _loadFromStorage() {
            try {
                const raw = localStorage.getItem(this.STORAGE_KEY);
                if (!raw) return false;
                const parsed = JSON.parse(raw);
                if (!parsed || typeof parsed !== "object") return false;
                const ts = Number(parsed.timestamp);
                if (!Number.isFinite(ts) || Date.now() - ts >= this.REFRESH_INTERVAL) return false;
                if (!Array.isArray(parsed.entries)) return false;
                this._cache = new Map(parsed.entries);
                this._lastFetch = ts;
                console.log("[mwi-mm] Market prices loaded from localStorage:", this._cache.size, "items");
                return true;
            } catch (e) {
                console.warn("[mwi-mm] Market price cache restore failed:", e);
                return false;
            }
        },
 
        /** ★ 寫入 localStorage（忽略配額錯誤） */
        _saveToStorage() {
            if (!this._cache || !this._lastFetch) return;
            try {
                const payload = JSON.stringify({
                    timestamp: this._lastFetch,
                    entries: [...this._cache.entries()]
                });
                localStorage.setItem(this.STORAGE_KEY, payload);
            } catch (e) {
                // 超配額 / 隱私模式等場景安靜失敗，記憶體快取仍有效
            }
        },
 
        /** 確保資料已載入（懶載入 + 記憶體快取 1 小時 + localStorage 跨會話快取） */
        async ensureData() {
            if (this._cache && Date.now() - this._lastFetch < this.REFRESH_INTERVAL) return true;
 
            // ★ 先嘗試 localStorage（同步）— 命中即返回，不發網路請求
            if (!this._cache && this._loadFromStorage()) return true;
            if (Date.now() < this._nextRetryAt) return false;
            // 併發呼叫共享同一次請求，不能在載入中立即返回舊快取狀態。
            if (this._inFlight) return this._inFlight;
 
            this._inFlight = (async () => {
                this._loading = true;
                this._error = false;
 
                // ★ AbortController 超時保護，避免網路慢時無限等待
                const ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
                const timeoutId = ctrl ? setTimeout(() => ctrl.abort(), this.FETCH_TIMEOUT) : null;
 
                try {
                    const base = location.hostname.includes("milkywayidlecn")
                        ? "https://www.milkywayidlecn.com" : "https://www.milkywayidle.com";
                    const url = base + "/game_data/marketplace.json";
                    console.log("[mwi-mm] Fetching market prices:", url);
                    const fetchOpts = ctrl ? { signal: ctrl.signal } : {};
                    const resp = await fetch(url, fetchOpts);
                    if (!resp.ok) {
                        console.error("[mwi-mm] Market price fetch failed, status:", resp.status);
                        this._error = true;
                        this._nextRetryAt = Date.now() + this.RETRY_INTERVAL;
                        return false;
                    }
                    const raw = await resp.json();
                    // API 返回 { timestamp, marketData: { "/items/xxx": { "0": {...}, ... }, ... } }
                    const data = raw && raw.marketData ? raw.marketData : raw;
                    if (!data || typeof data !== "object") {
                        console.error("[mwi-mm] Market price data is invalid:", typeof data);
                        this._error = true;
                        this._nextRetryAt = Date.now() + this.RETRY_INTERVAL;
                        return false;
                    }
                    const nextCache = new Map();
                    let count = 0;
                    for (const [hrid, levels] of Object.entries(data)) {
                        if (!hrid.startsWith("/items/")) continue;
                        const info = levels["0"] || levels[0];
                        if (!info) continue;
                        const bareId = hrid.replace(/^\/items\//, "");
                        nextCache.set(bareId, {
                            ask: info.a ?? -1,
                            bid: info.b ?? -1,
                            avg: info.p ?? -1,
                            vol: info.v ?? 0
                        });
                        count++;
                    }
                    this._cache = nextCache;
                    this._lastFetch = Date.now();
                    this._nextRetryAt = 0;
                    this._saveToStorage(); // ★ 持久化到 localStorage
                    console.log("[mwi-mm] Market prices loaded:", count, "items");
                    return true;
                } catch (err) {
                    if (err && err.name === "AbortError") {
                        console.error("[mwi-mm] Market price fetch timeout (", this.FETCH_TIMEOUT, "ms)");
                    } else {
                        console.error("[mwi-mm] Market price fetch error:", err);
                    }
                    this._error = true;
                    this._nextRetryAt = Date.now() + this.RETRY_INTERVAL;
                    return false;
                } finally {
                    if (timeoutId) clearTimeout(timeoutId);
                    this._loading = false;
                }
            })();
 
            try {
                return await this._inFlight;
            } finally {
                this._inFlight = null;
            }
        },
 
        /** 獲取物品的採購價格（同步，從記憶體讀取）
         *  優先順序: ask > bid > avg > -1 */
        getPrice(bareId) {
            if (!this._cache) return -1;
            const info = this._cache.get(bareId);
            if (!info) return -1;
            if (info.ask > 0) return info.ask;
            if (info.bid > 0) return info.bid;
            if (info.avg > 0) return info.avg;
            return -1;
        },
 
        /** 資料是否就緒 */
        get ready() { return Boolean(this._cache); },
        /** 快取是否仍在 1 小時有效期內 */
        get fresh() { return Boolean(this._cache) && Date.now() - this._lastFetch < this.REFRESH_INTERVAL; },
        /** 距離快取過期的毫秒數 */
        get refreshDueIn() { return Math.max(0, this.REFRESH_INTERVAL - (Date.now() - this._lastFetch)); },
        /** 距離允許失敗重試的毫秒數 */
        get retryDueIn() { return Math.max(0, this._nextRetryAt - Date.now()); },
        /** 是否正在載入 */
        get loading() { return this._loading; }
    };
 
    /** 格式化金幣數量（簡短形式） */
    function formatGold(n) {
        if (!Number.isFinite(n) || n < 0) return "--";
        if (n < 1000) return String(Math.round(n));
        if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
        if (n < 1000000) return Math.round(n / 1000) + "K";
        if (n < 10000000) return (n / 1000000).toFixed(2).replace(/0$/, "").replace(/\.$/, "") + "M";
        if (n < 1000000000) return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
        return (n / 1000000000).toFixed(2).replace(/0$/, "").replace(/\.$/, "") + "B";
    }
 
    // ── 製作計劃追蹤器 ──────────────────────────────────
    const _craftingPlanTracker = {
        // 單調混合進度：線上時由 action_completed 累計已完成製作次數並持久化；
        //   getPlanProgress 再用「當前產出物庫存 − 快照基線」補償離線期間的進度。
        //   兩者始終取較大值，因此產物被出售、消耗、強化或移動後進度不會倒退。
        //   計劃仍只允許使用者手動「完成 / 刪除 / 清空」，不會自動移除。
        /** WS 推送 action_completed → 累計一次製作並重新整理計劃頁 */
        onActionCompleted(endCharacterAction) {
            if (!endCharacterAction || !endCharacterAction.actionHrid) return;
            const plan = STATE.craftingPlans.get(endCharacterAction.actionHrid);
            if (!plan) return;
            const targetActions = Math.max(1, Math.round(Number(plan.craftCount) || 1));
            const previous = Math.max(0, Math.round(Number(plan.craftedCount) || 0));
            const next = Math.min(targetActions, previous + 1);
            if (next !== previous) {
                plan.craftedCount = next;
                plan.updatedAt = nowIso();
                savePlans();
            }
            Store.notify("plans");
        },
 
        /** actions_updated isDone 訊號 → 重新整理計劃頁進度條 */
        onActionDone(actionHrid) {
            if (!actionHrid || !STATE.craftingPlans.has(actionHrid)) return;
            Store.notify("plans");
        }
    };
 
    // ── 任務追蹤模組 ─────────────────────────────────────
    const PRODUCTION_SKILL_TYPES = new Set(["cheesesmithing", "crafting", "tailoring", "brewing", "cooking"]);
 
    const _questTracker = {
        _quests: [],   // 原始任務列表
        _ready: false,
 
        /** 從 init_character_data 初始化 */
        init(characterQuests) {
            if (!Array.isArray(characterQuests)) return;
            this._quests = characterQuests;
            this._ready = true;
            Store.notify("quests");
        },
 
        /** WS 推送更新（增量合併：只更新推送中出現的任務） */
        update(questPatches) {
            if (!Array.isArray(questPatches)) return;
            for (const patch of questPatches) {
                const idx = this._quests.findIndex(q => q.hrid === patch.hrid);
                if (idx >= 0) this._quests[idx] = patch;
                else this._quests.push(patch);
            }
            Store.notify("quests");
        },
 
        /** 獲取生產類任務 */
        getProductionTasks() {
            if (!this._ready || !_dataLayer.ready) return [];
            return this._quests.filter(q => {
                if (!q || !q.actionHrid) return false;
                if (q.status && q.status !== "/quest_status/in_progress") return false;
                if ((q.currentCount || 0) >= (q.goalCount || 0)) return false;
                const action = _dataLayer._actionMap?.[q.actionHrid];
                if (!action || action.function !== "/action_functions/production") return false;
                const bareType = (action.type || "").replace(/^\/action_types\//, "");
                return PRODUCTION_SKILL_TYPES.has(bareType);
            }).map(q => {
                const action = _dataLayer._actionMap[q.actionHrid];
                const outputItem = action.outputItems?.[0];
                const itemHrid = outputItem?.itemHrid || "";
                const itemName = _dataLayer.hridToName(itemHrid) || itemHrid.replace(/^\/items\//, "");
                const remaining = Math.max(0, (q.goalCount || 0) - (q.currentCount || 0));
                return {
                    questHrid: q.hrid || "",
                    actionHrid: q.actionHrid,
                    actionName: _dataLayer.hridToName(q.actionHrid) || q.actionHrid,
                    itemHrid,
                    itemName,
                    done: q.currentCount || 0,
                    total: q.goalCount || 0,
                    remaining,
                    skillType: (action.type || "").replace(/^\/action_types\//, ""),
                    _action: action
                };
            });
        },
 
    };
 
    // ── 資料層 — actionDetailMap / itemNameToHridDict ─────
    const _dataLayer = {
        ready: false,
        _clientData: null,
        _nameToHrid: null,
        _hridToName: null,
        _outputToAction: null,
        _actionMap: null,
        _houseRoomMap: null,
        _actionNameIndex: null,
        _lastRetryAt: 0,
        _retryCount: 0,

        /** 懶重試自愈 — 就緒後只剩一次布林判斷;未就緒時最多每 10s 重試一次 init。
         *  覆蓋「啟動 8s 視窗內三個資料來源都沒到位,之後快取才可讀」的場景(舊版永不重試)。
         *  重試有上限:每次都要同步 LZ 解壓 >1MB,失敗 30 次(約 5 分鐘)後停手,不再週期性卡主執行緒。 */
        ensureReady() {
            if (this.ready) return true;
            const now = Date.now();
            if (this._retryCount >= 30) return false;
            if (now - this._lastRetryAt < 10000) return false;
            this._lastRetryAt = now;
            this._retryCount++;
            try {
                if (!_capturedClientData?.actionDetailMap) {
                    const cached = _readClientDataFromCache();
                    if (cached) _capturedClientData = cached;
                }
                if (this.init()) console.log("[mwi-mm] 資料層延遲自愈成功(ensureReady)");
            } catch (err) { _log.note("data-layer", "ensureReady 自愈失敗: " + (err?.message || err)); }
            return this.ready;
        },
 
        /** 獲取遊戲客戶端資料（優先 WS → localStorage → window.mwi） */
        _getClientData() {
            if (_capturedClientData?.actionDetailMap) return _capturedClientData;
            const cached = _readClientDataFromCache();
            if (cached) { _capturedClientData = cached; return cached; }
            if (PAGE_WINDOW.mwi?.initClientData?.actionDetailMap) return PAGE_WINDOW.mwi.initClientData;
            return null;
        },
 
        /** 獲取國際化物品名稱對映（displayName → hrid），支援中英文 */
        _getI18nItemNames() {
            try {
                if (PAGE_WINDOW.mwi?.itemNameToHridDict && typeof PAGE_WINDOW.mwi.itemNameToHridDict === "object" && Object.keys(PAGE_WINDOW.mwi.itemNameToHridDict).length > 100) {
                    return PAGE_WINDOW.mwi.itemNameToHridDict;
                }
                const gameObj = this._getGameObject();
                const resources = gameObj?.props?.i18n?.options?.resources;
                if (!resources) return null;
                const result = {};
                for (const langKey of ["en", "zh"]) {
                    const names = resources[langKey]?.translation?.itemNames;
                    if (names && typeof names === "object") {
                        for (const [hrid, displayName] of Object.entries(names)) {
                            result[displayName] = hrid;
                        }
                    }
                }
                return Object.keys(result).length > 0 ? result : null;
            } catch { return null; }
        },
 
        /** 獲取雙語 hrid→name 對映（從遊戲 i18n 資源中提取） */
        _getI18nBilingual() {
            const result = { en: new Map(), zh: new Map() };
            try {
                const gameObj = this._getGameObject();
                const resources = gameObj?.props?.i18n?.options?.resources;
                if (!resources) return result;
                for (const langKey of ["en", "zh"]) {
                    const names = resources[langKey]?.translation?.itemNames;
                    if (names && typeof names === "object") {
                        for (const [hrid, displayName] of Object.entries(names)) {
                            const fullHrid = hrid.startsWith("/items/") ? hrid : `/items/${hrid}`;
                            result[langKey].set(fullHrid, displayName);
                        }
                    }
                }
            } catch { /* ignore */ }
            return result;
        },
 
        init() {
            const cd = this._getClientData();
            if (!cd || typeof cd !== "object") return false;
            this._clientData = cd;
 
            try {
                this._nameToHrid = new Map();
                this._hridToName = new Map();
                // 雙語名稱對映
                this._hridToNameEn = new Map();
                this._hridToNameZh = new Map();
 
                const i18nNames = this._getI18nItemNames();
                if (i18nNames) {
                    for (const [name, hrid] of Object.entries(i18nNames)) {
                        this._nameToHrid.set(name, hrid);
                        this._nameToHrid.set(name.toLowerCase(), hrid);
                        this._hridToName.set(hrid, name);
                    }
                }
 
                // 構建雙語名稱索引
                const bilingual = this._getI18nBilingual();
                if (bilingual.en.size) this._hridToNameEn = bilingual.en;
                if (bilingual.zh.size) this._hridToNameZh = bilingual.zh;
 
                if (cd.itemDetailMap) {
                    for (const [hrid, detail] of Object.entries(cd.itemDetailMap)) {
                        if (detail && detail.name) {
                            if (!this._hridToName.has(hrid)) {
                                this._hridToName.set(hrid, detail.name);
                            }
                            if (!this._nameToHrid.has(detail.name)) {
                                this._nameToHrid.set(detail.name, hrid);
                                this._nameToHrid.set(detail.name.toLowerCase(), hrid);
                            }
                            // 如果雙語對映中缺少該物品，用 itemDetailMap 補全
                            // itemDetailMap 中的 name 取決於當前遊戲語言
                            if (!this._hridToNameEn.has(hrid) && !this._hridToNameZh.has(hrid)) {
                                this._hridToName.set(hrid, detail.name);
                            }
                        }
                    }
                }
 
                this._actionNameIndex = new Map();
                if (cd.actionDetailMap) {
                    this._actionMap = cd.actionDetailMap;
                    this._outputToAction = new Map();
                    for (const action of Object.values(cd.actionDetailMap)) {
                        if (action.outputItems && Array.isArray(action.outputItems)) {
                            for (const output of action.outputItems) {
                                if (output.itemHrid && !this._outputToAction.has(output.itemHrid)) {
                                    this._outputToAction.set(output.itemHrid, action);
                                }
                            }
                        }
                        if (action.name) {
                            this._actionNameIndex.set(action.name, action);
                            this._actionNameIndex.set(action.name.toLowerCase(), action);
                        }
                    }
                }
 
                if (cd.houseRoomDetailMap) {
                    this._houseRoomMap = cd.houseRoomDetailMap;
                }
 
                // 構建升級鏈對映 outputHrid → upgradeHrid（前代物品）
                this._upgradeChainMap = new Map();
                if (cd.actionDetailMap) {
                    for (const action of Object.values(cd.actionDetailMap)) {
                        if (!action.upgradeItemHrid || action.function !== "/action_functions/production") continue;
                        const outputs = action.outputItems || [];
                        if (!outputs.length) continue;
                        const outputHrid = outputs[0].itemHrid;
                        if (outputHrid) {
                            this._upgradeChainMap.set(outputHrid, action.upgradeItemHrid);
                        }
                    }
                }
 
                this.ready = true;
                const nameCount = this._hridToName?.size || 0;
                const recipeCount = this._outputToAction?.size || 0;
                const chainCount = this._upgradeChainMap?.size || 0;
                console.log(`[mwi-mm] v${SCRIPT.version} DataLayer initialized: ${nameCount} names, ${recipeCount} recipes, ${chainCount} upgrade chains`);
                return true;
            } catch (e) {
                console.warn("[mwi-mm] 資料層初始化失敗:", e);
                this.ready = false;
                return false;
            }
        },
 
        /** 將 hrid 轉換為顯示名稱（根據當前語言選擇） */
        hridToName(hrid) {
            // 優先使用當前語言的雙語對映
            if (_currentLang === "en" && this._hridToNameEn?.size) {
                const en = this._hridToNameEn.get(hrid);
                if (en) return en;
            }
            if (_currentLang === "zh" && this._hridToNameZh?.size) {
                const zh = this._hridToNameZh.get(hrid);
                if (zh) return zh;
            }
            // 回退到通用對映
            return this._hridToName?.get(hrid) || null;
        },
 
        /** 通過 React Fiber 獲取遊戲元件例項（用於讀取內部狀態） */
        _getGameObject() {
            try {
                const el = document.querySelector('[class^="GamePage"]');
                if (!el) return null;
                const key = Reflect.ownKeys(el).find(k => typeof k === 'string' && k.startsWith('__reactFiber$'));
                if (!key) return null;
                return el[key]?.return?.stateNode || null;
            } catch { return null; }
        },
 
        /**
         * 計算飲品濃縮倍率（基於 guzzling_pouch 強化等級）
         * ★ 改用 getEquippedLevel 從 hashMap 查詢裝備的暴飲袋，
         *   修復 _detailMap 僅含 inventory 物品後找不到裝備欄暴飲袋的問題。
         */
        _getDrinkConcentration() {
            // ★ 手動指定暴飲袋等級時，直接用 ENHANCEMENT_BONUSES 計算
            if (STATE.guzzlingPouchLevel >= 0) {
                const bonus = ENHANCEMENT_BONUSES[STATE.guzzlingPouchLevel] ?? 0;
                return 1 + 0.1 * (1 + bonus);
            }
            const cd = this._clientData || this._getClientData();
            if (!cd) return 1;
            const pouchHrid = "/items/guzzling_pouch";
            // ★ 從 hashMap 查詢所有位置的暴飲袋（含 /item_locations/pouch）
            const maxLevel = _wsInventory.getEquippedLevel(pouchHrid);
            if (maxLevel < 0) return 1;
            const pouchDetail = cd.itemDetailMap?.[pouchHrid];
            if (!pouchDetail?.equipmentDetail) return 1;
            const baseConc = pouchDetail.equipmentDetail.noncombatStats?.drinkConcentration || 0;
            const enhBonus = pouchDetail.equipmentDetail.noncombatEnhancementBonuses?.drinkConcentration || 0;
            const multiplier = cd.enhancementLevelTotalBonusMultiplierTable?.[maxLevel] || 0;
            return 1 + baseConc + enhBonus * multiplier;
        },
 
        /**
         * 計算工匠茶（artisan_tea）帶來的材料減少加成比例
         * ★ 優先使用 WS 截獲的飲品插槽資料，React Fiber 作為回退，
         *   解決 React Fiber 路徑脆弱 / 屬性名不匹配導致工匠加成丟失的問題。
         */
        _getArtisanBuff(actionType) {
            if (!actionType) return 0;
            const bareType = actionType.replace(/^\/action_types\//, "");
            // ★ 複用 PRODUCTION_SKILL_TYPES（第 954 行定義），消除重複硬編碼
            if (!PRODUCTION_SKILL_TYPES.has(bareType)) return 0;
 
            // 策略1: WS 截獲的飲品插槽（最可靠）
            if (_wsDrinkSlots.hasDrink(actionType, "/items/artisan_tea")) {
                return 0.1 * this._getDrinkConcentration();
            }
 
            // 策略2: React Fiber 回退（相容多種屬性命名）
            try {
                const gameObj = this._getGameObject();
                if (gameObj?.state) {
                    const drinkMap = gameObj.state.actionTypeDrinkSlotsDict
                        || gameObj.state.actionTypeDrinkSlotsMap
                        || gameObj.state.actionTypeDrinkSlots;
                    if (drinkMap) {
                        const drinkSlots = drinkMap[actionType];
                        if (Array.isArray(drinkSlots)) {
                            const hasArtisan = drinkSlots.some(d => d?.itemHrid === "/items/artisan_tea");
                            if (hasArtisan) return 0.1 * this._getDrinkConcentration();
                        }
                    }
                }
            } catch { /* ignore */ }
 
            return 0;
        },
 
        /** 根據物品名/配方名查詢對應的 action 配方資料 */
        resolveActionByTitle(title) {
            if (!this.ready) return null;
            const trimmed = (title || "").trim();
            if (!trimmed) return null;
 
            // 先按物品名 → outputToAction 索引查詢
            const itemHrid = this._nameToHrid.get(trimmed) || this._nameToHrid.get(trimmed.toLowerCase());
            if (itemHrid && itemHrid.startsWith("/items/") && this._outputToAction) {
                const action = this._outputToAction.get(itemHrid);
                if (action && action.inputItems) return action;
            }
 
            // 再按 action 名稱索引查詢
            const byName = this._actionNameIndex?.get(trimmed) || this._actionNameIndex?.get(trimmed.toLowerCase());
            if (byName && byName.inputItems) return byName;
 
            return null;
        },
 
        /** 按確定的 actionHrid 直接查表(由 React Fiber 讀到的 actionDetail.hrid 驅動)。
         *  比標題文字 / SVG 反查更可靠:語言無關、零歧義、不受第三方 DOM 改寫影響。 */
        resolveActionByHrid(hrid) {
            if (!this.ready || !hrid || !this._actionMap) return null;
            const a = this._actionMap[hrid];
            return (a && a.inputItems && a.inputItems.length) ? a : null;
        }
    };
 
    // ── 配方鏈遞迴解算模組 ──────────────────────────────
    const _recipeChain = {
        /** 檢查物品是否可製作（在 _outputToAction 中存在生產配方） */
        isCraftable(itemHrid) {
            if (!_dataLayer.ready || !_dataLayer._outputToAction) return false;
            const action = _dataLayer._outputToAction.get(itemHrid);
            return !!(action && action.function === "/action_functions/production" && action.inputItems?.length);
        },
 
        /** 檢查物品是否屬於升級鏈（有前代物品） */
        isUpgradeChain(itemHrid) {
            return !!(_dataLayer._upgradeChainMap?.has(itemHrid));
        },
 
        /**
         * 獲取完整升級鏈步驟（迭代遍歷，非遞迴分解）
         * 沿 upgradeChainMap 向下走，每步收集非升級材料（套 artisan+z），升級前代 1:1 不套 artisan
         * @returns {Array<{stepHrid, craftRuns, upgradeFromHrid, materials: [{hrid, qty, name}]}>}
         */
        getChainSteps(targetHrid, qty) {
            if (!_dataLayer.ready) return [];
            const steps = [];
            let currentHrid = targetHrid;
            let neededQty = qty;
            const visited = new Set();
 
            while (neededQty > 0 && steps.length < 25) {
                if (visited.has(currentHrid)) break; // 防迴圈
                visited.add(currentHrid);
 
                const action = _dataLayer._outputToAction?.get(currentHrid);
                if (!action || action.function !== "/action_functions/production" || !action.inputItems?.length) break;
 
                const outputCount = action.outputItems?.[0]?.count || 1;
                const craftRuns = Math.ceil(neededQty / outputCount);
                const artisanBuff = _dataLayer._getArtisanBuff(action.type);
                const zVal = _zScoreCalc._effectiveZ(craftRuns);
                const upgradeHrid = _dataLayer._upgradeChainMap?.get(currentHrid) || null;
 
                // 收集非升級材料（套 artisan + z-score；金幣跳過偏移）
                const materials = [];
                for (const inp of action.inputItems || []) {
                    const isUpgrade = upgradeHrid && inp.itemHrid === upgradeHrid && (inp.count || 1) === 1;
                    if (isUpgrade) continue; // 1:1 升級前代，不購買，沿鏈繼續
                    const inpBareId = inp.itemHrid.replace(/^\/items\//, "");
                    const needed = isCoinItem(inpBareId)
                        ? Math.ceil((inp.count || 1) * craftRuns - 1e-9)
                        : _zScoreCalc.calcMaterials(inp.count || 1, craftRuns, artisanBuff, zVal).total;
                    materials.push({
                        hrid: inp.itemHrid,
                        qty: needed,
                        name: _dataLayer.hridToName(inp.itemHrid) || inpBareId
                    });
                }
 
                steps.push({
                    stepHrid: currentHrid,
                    stepName: _dataLayer.hridToName(currentHrid) || currentHrid.replace(/^\/items\//, ""),
                    craftRuns,
                    upgradeFromHrid: upgradeHrid,
                    materials
                });
 
                if (!upgradeHrid) break; // 鏈尾，無前代
                currentHrid = upgradeHrid;
                neededQty = craftRuns; // 1:1 升級，無 artisan
            }
            return steps;
        },
 
        /**
         * 彙總全鏈葉子材料（所有步驟的非升級材料合併）
         * @returns {Map<hrid, number>} hrid → 總需求量
         */
        getLeafMaterials(targetHrid, qty) {
            const steps = this.getChainSteps(targetHrid, qty);
            const merged = new Map();
            for (const step of steps) {
                for (const mat of step.materials) {
                    merged.set(mat.hrid, (merged.get(mat.hrid) || 0) + mat.qty);
                }
            }
            return merged;
        },
 
        /**
         * 構建子樹結構（用於 UI 展開顯示升級鏈步驟）
         * @returns {Array<{itemHrid, name, qty, depth, isCraftable, isUpgrade, isStep, materials}>}
         */
        buildSubTree(targetHrid, qty) {
            const steps = this.getChainSteps(targetHrid, qty);
            const rows = [];
            for (let i = 0; i < steps.length; i++) {
                const step = steps[i];
                // 每步的非升級材料
                for (const mat of step.materials) {
                    rows.push({
                        itemHrid: mat.hrid, name: mat.name, qty: mat.qty,
                        depth: i + 1, isCraftable: false, isUpgrade: false
                    });
                }
                // 如果有升級前代，顯示為步驟行
                if (step.upgradeFromHrid && i < steps.length - 1) {
                    const nextStep = steps[i + 1];
                    rows.push({
                        itemHrid: step.upgradeFromHrid,
                        name: nextStep.stepName,
                        qty: step.craftRuns,
                        depth: i + 1, isCraftable: true, isUpgrade: true, isStep: true
                    });
                }
            }
            return rows;
        },
 
        /** 葉子材料轉購物車條目（扣除庫存 + 購物車已有量）
         *  ★ 參數 excludeRecipes 接受 string 或 Set<string>，會原樣透傳給
         *    getEffectiveInventory —— 其內部已支援兩種型別，這裡不需要額外適配。
         */
        toCartItems(leafMap, excludeRecipes) {
            const items = [];
            for (const [hrid, qty] of leafMap) {
                const bareId = hrid.replace(/^\/items\//, "");
                if (isCoinItem(bareId)) continue;
                const name = _dataLayer.hridToName(hrid) || bareId;
                const stock = getEffectiveInventory(bareId, excludeRecipes);
                const missing = Math.max(0, qty - stock);
                // ★ 扣除購物車中已有的數量（已規劃購買量），只新增淨增量
                const cartRow = STATE.cart.get(bareId);
                const alreadyInCart = cartRow ? Math.max(0, cartRow.quantity) : 0;
                const netMissing = Math.max(0, missing - alreadyInCart);
                if (netMissing > 0) {
                    items.push({ itemId: bareId, name, iconRef: hrid, missing: netMissing, totalNeeded: qty });
                }
            }
            return items;
        }
    };
 
    /** 等待遊戲客戶端資料就緒（輪詢，最多等 maxWait ms） */
 
    // ════════════════════════════════════════════════════════════════════════
    // §04-續 資料採集(物理越區,就地標註)
    //     waitForClientData / setupWSInterceptor —— 邏輯歸屬 §04;
    //     WS 攔截器須在遊戲建連前生效,為避免搬運風險保持原位
    // ════════════════════════════════════════════════════════════════════════
 
    function waitForClientData(maxWait = 8000) {
        return new Promise(resolve => {
            if (_capturedClientData?.actionDetailMap) { resolve(true); return; }
            const cached = _readClientDataFromCache();
            if (cached) { _capturedClientData = cached; resolve(true); return; }
            if (PAGE_WINDOW.mwi?.initClientData?.actionDetailMap) { resolve(true); return; }
            const start = Date.now();
            let tick = 0;
            const timer = setInterval(() => {
                tick++;
                // 每 5 跳(≈1s)補查一次 localStorage —— 舊輪詢只看 WS 與 window.mwi,
                //       遊戲啟動期間晚寫入的快取會被永久錯過且無任何重試。
                if (tick % 5 === 0 && !_capturedClientData) {
                    const late = _readClientDataFromCache();
                    if (late) _capturedClientData = late;
                }
                if (_capturedClientData?.actionDetailMap || PAGE_WINDOW.mwi?.initClientData?.actionDetailMap) {
                    clearInterval(timer);
                    resolve(true);
                } else if (Date.now() - start > maxWait) {
                    clearInterval(timer);
                    resolve(false);
                }
            }, 200);
        });
    }
 
    /** 將一條遊戲 WS 訊息分發到當前腳本例項的資料層。 */
    let _wsDispatchWarnedAt = 0;
    function handleGameWSMessage(message) {
        // 只處理 JSON 物件文字幀:二進位幀/非 JSON 字串直接跳過,不進 try 白耗解析
        if (typeof message !== "string" || message.charCodeAt(0) !== 123) return;
        let obj;
        try { obj = JSON.parse(message); } catch (e) { return; }   // 非 JSON,忽略
        if (!obj || typeof obj !== "object") return;
        // 派發錯誤與解析錯誤分開:遊戲 schema 變動導致的 TypeError 不再被無聲吞掉
        try {
            _marketPurchaseTracker.captureConfirmation(obj);
            // action_completed 必須先累計計劃進度，再應用同一訊息裡的庫存增量。
            if (obj.type === "action_completed" && obj.endCharacterAction) {
                _craftingPlanTracker.onActionCompleted(obj.endCharacterAction);
            }
            if (obj.type === "init_character_data" && Array.isArray(obj.characterItems)) {
                _wsInventory.init(obj.characterItems);
                if (obj.actionTypeDrinkSlotsMap) _wsDrinkSlots.init(obj.actionTypeDrinkSlotsMap);
                if (Array.isArray(obj.characterQuests)) _questTracker.init(obj.characterQuests);
                // 斷線重連/重登會讓 React 重掛 GamePage，延遲重掛監聽器並強制重繪。
                setTimeout(() => { ensureMainObserverAttached(); scheduleRefresh(120); }, 300);
                setTimeout(_healObserversAfterRemount, 1200);
            } else if (Array.isArray(obj.endCharacterItems)) {
                _wsInventory._patch(obj.endCharacterItems);
            }
            if (obj.type === "action_type_consumable_slots_updated" && obj.actionTypeDrinkSlotsMap) {
                _wsDrinkSlots.update(obj.actionTypeDrinkSlotsMap);
            }
            if (obj.type === "init_client_data") {
                obj._src = "WS";
                _capturedClientData = obj;
                console.log("[mwi-mm] 已截獲 init_client_data（WS）");
                if (!_dataLayer.ready) _dataLayer.init();
            }
            if (obj.type === "market_item_order_books_updated") _marketDataCache.update(obj);
            if (obj.type === "actions_updated" && Array.isArray(obj.endCharacterActions)) {
                for (const ca of obj.endCharacterActions) {
                    if (ca.isDone && ca.actionHrid) _craftingPlanTracker.onActionDone(ca.actionHrid, ca.currentCount);
                }
            }
            if (Array.isArray(obj.endCharacterQuests)) _questTracker.update(obj.endCharacterQuests);
        } catch (e) {
            _log.note("ws-dispatch", "WS 訊息派發失敗(" + (obj.type || "?") + "): " + (e?.message || e));
            if (Date.now() - _wsDispatchWarnedAt > 30000) {   // 告警節流:每 30 秒最多一次
                _wsDispatchWarnedAt = Date.now();
                console.warn("[mwi-mm] WS 訊息派發失敗(庫存/計劃追蹤可能停更),詳見 MWIMM.__log():", e);
            }
        }
    }
 
    /**
     * 安卓相容 WS 監聽：在 WebSocket 建立時附加一個獨立 message 監聽器。
     * 不再改寫 MessageEvent.data getter，因此無論採集邏輯如何失敗，
     * 都不會阻斷遊戲自己的訊息監聽器。
     */
    function setupWSInterceptor() {
        const existingHub = PAGE_WINDOW.__mwiMM_wsInterceptorHub;
        if (existingHub && existingHub.revision >= 2 && existingHub.mode === "socket-listener") {
            existingHub.handler = handleGameWSMessage;
            PAGE_WINDOW.__mwiMM_wsInterceptorInstalled = true;
            console.log("[mwi-mm] v" + SCRIPT.version + " 安全 WS 監聽已切換到當前例項");
            return;
        }
 
        const pageMessageEvent = PAGE_WINDOW.MessageEvent;
        const nativeWebSocket = PAGE_WINDOW.WebSocket;
        const dataDescriptor = pageMessageEvent
            ? Object.getOwnPropertyDescriptor(pageMessageEvent.prototype, "data")
            : null;
        const originalGetter = typeof existingHub?.originalGetter === "function"
            ? existingHub.originalGetter
            : typeof PAGE_WINDOW.__mwiMM_origDataGetter === "function"
            ? PAGE_WINDOW.__mwiMM_origDataGetter
            : dataDescriptor?.get;
 
        // 不再把 MessageEvent.prototype.data 還原成原生 getter:
        // mwiTools / profit / mooket2 都以「鏈式包裝當前 getter」的方式掛鉤,
        // 若正式版舊 getter 之後還有它們的鏈,這一還原會把整條鏈一併抹掉,
        // 其他腳本的 WS 採集就此無聲失效。本版走 socket-listener 模式,
        // 完全不依賴 prototype getter,殘留的舊 getter 只是無害的透傳。
 
        if (typeof nativeWebSocket !== "function") {
            console.warn("[mwi-mm] 無法獲取 WebSocket 建構子，WS 庫存追蹤不可用");
            return;
        }
 
        const hub = {
            revision: 2,
            mode: "socket-listener",
            originalGetter,
            nativeWebSocket,
            handler: handleGameWSMessage,
            constructor: null
        };
 
        const isGameSocketUrl = (rawUrl) => {
            const url = String(rawUrl || "");
            return url.indexOf("api.milkywayidle.com/ws") !== -1
                || url.indexOf("api-test.milkywayidle.com/ws") !== -1
                || url.indexOf("api.milkywayidlecn.com/ws") !== -1
                || url.indexOf("api-test.milkywayidlecn.com/ws") !== -1;
        };
 
        class MarketMateWebSocket extends nativeWebSocket {
            constructor(url, protocols) {
                if (arguments.length >= 2) super(url, protocols);
                else super(url);
                try {
                    if (!isGameSocketUrl(this.url || url)) return;
                    nativeWebSocket.prototype.addEventListener.call(this, "message", (event) => {
                        try {
                            const message = event.data;
                            if (typeof hub.handler === "function") hub.handler(message);
                        } catch (e) { /* 獨立監聽器的任何錯誤都不會傳給遊戲 */ }
                    });
                } catch (e) {
                    // socket 已由原生建構子成功建立；採集失敗時僅降級外掛功能。
                }
            }
        }
 
        try {
            hub.constructor = MarketMateWebSocket;
            PAGE_WINDOW.__mwiMM_origDataGetter = originalGetter;
            PAGE_WINDOW.__mwiMM_wsInterceptorHub = hub;
            PAGE_WINDOW.WebSocket = MarketMateWebSocket;
            PAGE_WINDOW.__mwiMM_wsInterceptorInstalled = true;
            console.log("[mwi-mm] v" + SCRIPT.version + " 安全 WebSocket listener registered (lang=" + _currentLang + ")");
        } catch (e) {
            console.warn("[mwi-mm] 安全 WS 監聽安裝失敗，已降級為 DOM 庫存跟蹤");
        }
    }
 
    // 儘早包裝建構子，以便在遊戲建立 socket 時附加獨立監聽器。
    setupWSInterceptor();
 
 
    // ════════════════════════════════════════════════════════════════════════
    // §06 工具區 Util
    //     文本/數字解析 / sprite 探測 / React Fiber 橋 / 市場定位高亮 / 庫存 DOM 掃描
    //     已知職責混居(≥6 種),拆分推遲到核心接線驗證後
    // ════════════════════════════════════════════════════════════════════════
 
    // ── 工具函式 ──────────────────────────────────────────────────
 
    /** 返回當前時間的 ISO 格式字串 */
    function nowIso() { return new Date().toISOString(); }
 
    /** 安全提取文字並截斷（去多餘空白，限制最大長度） */
    function safeText(value, maxLen = 160) {
        const text = String(value ?? "").replace(/\s+/g, " ").trim();
        if (text.length <= maxLen) return text;
        return text.slice(0, maxLen) + "...";
    }
 
    /** 獲取元素 className 的小寫形式（相容 SVGAnimatedString） */
    function classNameLower(el) {
        const raw = el && typeof el.className === "string"
            ? el.className
            : (el && el.className && typeof el.className.baseVal === "string" ? el.className.baseVal : "");
        return String(raw || "").toLowerCase();
    }
 
    /** 判斷元素是否可見（display/visibility/opacity + 尺寸） */
    function isVisible(el) {
        if (!el || !(el instanceof Element)) return false;
        if (!el.isConnected) return false;                     // 免費短路:脫離文件的節點不必強制樣式/佈局計算
        if (typeof el.checkVisibility === "function") {
            // 原生快速路徑(Chrome 105+/FF 106+):涵蓋 display/visibility/opacity 且不強制佈局
            if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
        } else {
            const style = window.getComputedStyle(el);
            if (!style || style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }
 
    /** 更新狀態列文字並觸發重繪 */
    function setAction(text) {
        if (text === STATE.lastAction) return;
        STATE.lastAction = text;
        Store.notify("ui");
    }
 
    /** 臨時抑制 MutationObserver（避免自身 DOM 操作觸發迴圈重新整理） */
    function suppressObserver() { STATE.suppressObserverDepth++; }
    /** 恢復 Observer（通過微任務延遲，確保當前 DOM 操作完成） */
    function resumeObserver() {
        queueMicrotask(() => { if (STATE.suppressObserverDepth > 0) STATE.suppressObserverDepth--; });
    }
    /** Observer 是否被抑制 */
    function isObserverSuppressed() { return STATE.suppressObserverDepth > 0; }
    /** 在抑制 Observer 期間執行函式 */
    function withObserverSuppressed(fn) {
        suppressObserver();
        try { return fn(); } finally { resumeObserver(); }
    }
 
    // ── 防注入硬防禦 ──────────────────────────────
    //   第三方腳本可能往需求行附近注入數字文本,被 DOM 解析讀成庫存/需求/次數。
    //   L1 節點級:textWithoutInjected 剔除「非遊戲 CSS-Modules 類名且含數字」的子元素;
    //   L2 數值級:解析結果超出合理上限 → 按解析失敗處理,不出徽章也不出錯數。
    //   遊戲自有節點類名形如 `Comp_name__hash`(CSS-Modules),以此為白名單特徵。
    const GAME_CLASS_RE = /(?:^|\s)[A-Za-z][\w-]*_[\w-]+__[\w-]{3,}(?:\s|$)/; // CSS-Modules: Comp_name__hash
    const MAX_SANE_ACTION_COUNT = 1e7;   // 製作次數上限(遊戲排隊遠低於此;超出 = 讀到了注入金額)
    const MAX_SANE_NEED = 1e6;           // 單次所需材料上限
    const MAX_SANE_STOCK = 1e13;         // 庫存上限(金幣富豪也到不了十萬億)
    const _suspectWarned = new Set();
    /** 同類可疑解析每會話只告警一次,避免刷屏 */
    function warnSuspectOnce(tag, detail) {
        if (_suspectWarned.has(tag)) return;
        _suspectWarned.add(tag);
        try { console.warn("[mwi-mm] 檢測到可疑數值(疑似第三方外掛注入),已忽略:", tag, detail); } catch (err) { /* ignore */ }
    }
    /** 元素自身是否帶遊戲 CSS-Modules 風格類名 */
    function hasGameClass(el) {
        if (!el || !el.className) return false;
        const cls = typeof el.className === "string" ? el.className : (el.className.baseVal || "");
        return GAME_CLASS_RE.test(cls);
    }
    /** L2: 行級數值合理性 — 任一越界即判定該行解析被汙染(呼叫方應作解析失敗處理) */
    function rowLooksSane(currentStock, needPerAction) {
        return Number.isFinite(currentStock) && currentStock >= 0 && currentStock <= MAX_SANE_STOCK
            && Number.isFinite(needPerAction) && needPerAction >= 0 && needPerAction <= MAX_SANE_NEED;
    }
 
    /** 提取元素文字，排除本外掛注入的 DOM（徽章、摘要面板等）
     *  同時剔除第三方外掛注入的數字節點(無遊戲類名 + 含數字 = 外來數值) */
    const INJECTED_NODE_SELECTOR = ".mwi-mm-upgrade-badge, .mwi-mm-upgrade-inline, .mwi-mm-summary-panel";
    function textWithoutInjected(el) {
        if (!el || !(el instanceof Element)) return "";
        // 舊實現每次呼叫都 cloneNode(true) + 全子樹 querySelectorAll 再就地刪節點,
        // 高頻解析路徑上代價極高。現改為同語義的唯讀遍歷:
        //   · 本外掛注入節點 → 整棵跳過
        //   · 無遊戲類名且(剔除注入後)含數字的節點 → 整棵跳過(第三方注入數值)
        //   · 其餘節點遞迴收集文字
        const textSkippingInjected = (node) => {
            let out = "";
            for (const child of node.childNodes) {
                if (child.nodeType === 3) out += child.nodeValue;
                else if (child instanceof Element && !child.matches(INJECTED_NODE_SELECTOR)) out += textSkippingInjected(child);
            }
            return out;
        };
        const collect = (node) => {
            let out = "";
            for (const child of node.childNodes) {
                if (child.nodeType === 3) { out += child.nodeValue; continue; }
                if (!(child instanceof Element)) continue;
                if (child.matches(INJECTED_NODE_SELECTOR)) continue;
                if (!hasGameClass(child) && /\d/.test(textSkippingInjected(child))) continue;
                out += collect(child);
            }
            return out;
        };
        return safeText(collect(el), 180);
    }
 
    /** 解析緊湊數字格式（支援 k/m/b 字尾、逗號分隔、∞） */
    function parseCompactNumber(token) {
        if (token == null) return null;
        const raw = String(token).trim().toLowerCase();
        if (!raw) return null;
        if (raw.includes("∞") || raw.includes("infinity")) return Infinity;
        const match = raw.match(/-?\d+(?:[.,]\d+)?(?:[kmb])?/i);
        if (!match) return null;
        let normalized = match[0].replace(/,/g, "");
        let unit = 1;
        if (normalized.endsWith("k")) { unit = 1e3; normalized = normalized.slice(0, -1); }
        else if (normalized.endsWith("m")) { unit = 1e6; normalized = normalized.slice(0, -1); }
        else if (normalized.endsWith("b")) { unit = 1e9; normalized = normalized.slice(0, -1); }
        const num = Number.parseFloat(normalized);
        if (!Number.isFinite(num)) return null;
        return num * unit;
    }
 
    /** 從文本中提取所有數字（返回陣列） */
    function parseNumbers(text) {
        const raw = String(text ?? "").replace(/,/g, "");
        const parts = raw.match(/-?\d+(?:\.\d+)?(?:[kmb])?|∞/gi) || [];
        const nums = [];
        for (const p of parts) {
            const n = parseCompactNumber(p);
            if (n != null) nums.push(n);
        }
        return nums;
    }
 
    /** 解析庫存顯示文本中的數值（取第一個有限數） */
    function parseInventoryValue(text) {
        const nums = parseNumbers(text);
        for (const n of nums) { if (Number.isFinite(n)) return n; }
        return 0;
    }
 
    /** 解析「每次所需」數量（取末尾有限數） */
    function parseRequiredPerAction(text) {
        const nums = parseNumbers(text);
        if (!nums.length) return 0;
        for (let i = nums.length - 1; i >= 0; i -= 1) {
            if (Number.isFinite(nums[i])) return nums[i];
        }
        return 0;
    }
 
    /** 解析行動次數輸入值（返回 { value, raw, infinite }） */
    function parseActionCountValue(text) {
        const raw = String(text ?? "").trim();
        if (!raw) return { value: 1, raw: "", infinite: false };
        const num = parseCompactNumber(raw);
        if (num === Infinity) return { value: 1, raw, infinite: true };
        if (!Number.isFinite(num) || num <= 0) return { value: 1, raw, infinite: false };
        return { value: num, raw, infinite: false };
    }
 
    function _readActionCountInScope(scope) {
        if (!scope || !(scope instanceof Element || scope instanceof Document)) return null;
        const containers = [...scope.querySelectorAll('[class*="SkillActionDetail_maxActionCountInput"]')].filter((el) => isVisible(el));
        for (const container of containers) {
            const input = container.querySelector('input[class*="Input_input"]');
            if (input && isVisible(input)) {
                const parsed = parseActionCountValue(input.value || input.textContent || "");
                if (parsed.infinite || (parsed.value >= 1 && parsed.value <= MAX_SANE_ACTION_COUNT)) return parsed;
                if (parsed.value > MAX_SANE_ACTION_COUNT) warnSuspectOnce("actionCount-input", parsed.raw);
            }
            const fallback = parseNumbers(textWithoutInjected(container)).filter((n) => Number.isFinite(n) && n > 0 && n <= MAX_SANE_ACTION_COUNT);
            if (fallback.length) return { value: Math.max(...fallback), raw: String(Math.max(...fallback)), infinite: false };
            const last = parseActionCountValue(input?.value || input?.textContent || "");
            if (last.raw && (last.infinite || last.value <= MAX_SANE_ACTION_COUNT)) return last;
            if (!last.infinite && last.value > MAX_SANE_ACTION_COUNT) warnSuspectOnce("actionCount-last", last.raw);
        }
        return null;
    }
 
    function _getActionCountScopes(modal) {
        const scopes = [];
        const push = (node) => {
            if (!node || scopes.includes(node)) return;
            scopes.push(node);
        };
        push(modal);
        push(modal?.closest?.('[class*="Modal_modalContainer"]'));
        push(modal?.closest?.('[class*="MainPanel_subPanelContainer"]'));
        push(modal?.parentElement);
        push(modal?.parentElement?.parentElement);
        return scopes;
    }
 
    /** 從當前面板讀取行動次數 */
    function readActionCount(modal) {
        for (const scope of _getActionCountScopes(modal)) {
            const parsed = _readActionCountInScope(scope);
            if (parsed) return parsed;
        }
        return parseActionCountValue("1");
    }
 
    /** 格式化數量顯示（整數不帶小數，小數保留 2 位去尾零） */
    function formatQty(num) {
        const n = Number(num || 0);
        if (!Number.isFinite(n)) return "0";
        if (Math.abs(n - Math.round(n)) < 1e-8) return String(Math.round(n));
        return n.toFixed(2).replace(/\.00$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
    }
 
    /** 從元素中提取 svg use href 屬性 */
    function extractUseHref(root) {
        if (!root || !(root instanceof Element)) return "";
        const use = root.querySelector("svg use");
        if (!use) return "";
        return use.getAttribute("href") || use.getAttribute("xlink:href") || "";
    }
 
    /** 從元素中提取圖示引用（多策略降級：use href → image href → data 屬性） */
    function extractIconRef(root) {
        if (!root || !(root instanceof Element)) return "";
        const nodes = [
            root.querySelector("svg use"), root.querySelector("use"),
            root.querySelector("image[href], image[xlink\\:href]"),
            root.querySelector("[href*=\"#\"], [xlink\\:href*=\"#\"]")
        ];
        for (const node of nodes) {
            if (!node) continue;
            const href = node.getAttribute("href") || node.getAttribute("xlink:href") || "";
            if (href) return href;
        }
        const attrNode = root.matches?.('[data-item-id], [data-item-hrid], [data-hrid]')
            ? root : root.querySelector('[data-item-id], [data-item-hrid], [data-hrid]');
        if (attrNode) {
            return attrNode.getAttribute("data-item-id") || attrNode.getAttribute("data-item-hrid") || attrNode.getAttribute("data-hrid") || "";
        }
        return "";
    }
 
    /** 在多個升級物品容器中找到最佳候選（評分系統：圖示、計數、非空狀態） */
    function findBestUpgradeContainer(modal) {
        const candidates = [...modal.querySelectorAll(SEL.upgradeContainer)].filter((el) => isVisible(el));
        if (!candidates.length) return null;
        let best = candidates[0], bestScore = -Infinity;
        for (const el of candidates) {
            let score = 0;
            const txt = textWithoutInjected(el);
            const itemCore = el.querySelector(SEL.itemCore);
            const cls = classNameLower(itemCore || el);
            const iconRef = extractIconRef(itemCore || el);
            if (itemCore) score += 2;
            if (iconRef) score += 2;
            if (cls.includes("item_empty")) score -= 6;
            if (/没有选择升级物品|未选择升级物品|沒有選擇升級物品|未選擇升級物品|choose/i.test(txt)) score -= 5;
            if (el.querySelector('[class*="Item_count"], [class*="inventoryCount"]')) score += 1;
            if (score > bestScore) { bestScore = score; best = el; }
        }
        return best;
    }
 
    /** 在容器內找到最佳的數量顯示元素（Item_count 優先） */
    function pickBestCountElement(container) {
        if (!container || !(container instanceof Element)) return null;
        const nodes = [...container.querySelectorAll('[class*="Item_count"], [class*="inventoryCount"], [class*="inputCount"]')].filter((el) => isVisible(el));
        if (!nodes.length) return null;
        let best = nodes[0], bestScore = -Infinity;
        for (const el of nodes) {
            let score = 0;
            const cls = classNameLower(el);
            const txt = textWithoutInjected(el);
            const nums = parseNumbers(txt).filter((n) => Number.isFinite(n));
            if (cls.includes("item_count")) score += 3;
            if (cls.includes("inventorycount")) score += 2;
            if (cls.includes("inputcount")) score -= 1;
            if (nums.length) score += 1;
            if (txt.length > 0 && txt.length < 26) score += 1;
            if (score > bestScore) { bestScore = score; best = el; }
        }
        return best;
    }
 
    /** 讀取升級物品的「每次所需」數量 */
    function readUpgradeNeedPerAction(upgradeEl) {
        if (!upgradeEl || !(upgradeEl instanceof Element)) return 1;
        const candidates = [...upgradeEl.querySelectorAll('[class*="inputCount"], [class*="requiredCount"]')].filter((el) => isVisible(el));
        for (const el of candidates) {
            const n = parseRequiredPerAction(textWithoutInjected(el));
            if (Number.isFinite(n) && n > 0) return n;
        }
        return 1;
    }
 
    /**
     * 解析「庫存/所需」格式的文本（如 "10/50"）
     * 相容半形和全形斜槓（/、／）和等號（=、＝）
     * ★ 移除 toolkitActive 參數。當左側無數值時（如 "/ 16"），
     *   不再將右側視為總需求量，而是讓呼叫者按單次消耗處理。
     *   修復強化面板輸入格式被誤解析為總量導致缺料永遠為 0 的問題。
     */
    function parseStockNeedPair(text) {
        const raw = String(text ?? "");
        const slashIdx = raw.search(/[\/／]/);
        if (slashIdx < 0) return null;
        const beforeSlash = raw.slice(0, slashIdx);
        if (/[=＝]/.test(beforeSlash)) return null;
        const leftNums = parseNumbers(beforeSlash);
        const rightNums = parseNumbers(raw.slice(slashIdx + 1));
        if (!rightNums.length) return null;
        const right = rightNums[0];
        if (!Number.isFinite(right)) return null;
        if (leftNums.length) {
            const left = leftNums[leftNums.length - 1];
            if (!Number.isFinite(left)) return null;
            if (left < 0) return null;
            return { stock: left, total: right };
        }
        return null;
    }
 
    /** 有損總量的整數吸附重建:顯示層可能把總量截斷為 K/M/B(302,192 → "302K")。
     *  利用「每次需求必為整數」+「次數來自精確 input.value」反推:
     *  有損總量/N ≈ 整數 r → 吸附到 r,總量重建為 r×N。
     *  僅當右側帶 k/m/b 字尾且偏差 ≤2% 時吸附,否則保持原值。 */
    function _snapLossyNeed(needPerAction, actionCountValue, rightRaw) {
        if (!(actionCountValue > 0) || !Number.isFinite(needPerAction)) return null;
        if (!/\d\s*[kmb]/i.test(String(rightRaw || ""))) return null;   // 僅有損格式才重建
        const r = Math.round(needPerAction);
        if (r < 1) return null;
        if (Math.abs(needPerAction - r) > r * 0.02) return null;
        return r;
    }
 
    /** 綜合解析所需量（優先嘗試 stock/need 格式，回退到普通解析）
     *  關鍵修復:斜槓右側的數字一律是「總需求量」,絕不能再乘 actionCount。
     *  MWI_Toolkit 會把遊戲的 inputCount 文本 "1,434 / 4" 直接改寫成 "␣/ 239K␣"
     *  (左側庫存被抹掉),舊邏輯落入 parseRequiredPerAction×actionCount 分支,
     *  把總量又乘了一次次數 → 平方爆炸(截圖 5.7e10 = 239K×239,432)。
     *  右側總量為有損格式時做整數吸附重建(見 _snapLossyNeed)。 */
    function resolveNeed(inputText, actionCountValue) {
        const raw = String(inputText ?? "");
        const slashIdx = raw.search(/[\/／]/);
        const rightRaw = slashIdx >= 0 ? raw.slice(slashIdx + 1) : "";
        const pair = parseStockNeedPair(inputText);
        if (pair) {
            let totalNeeded = pair.total;
            let needPerAction = actionCountValue > 0 ? totalNeeded / actionCountValue : totalNeeded;
            const snapped = _snapLossyNeed(needPerAction, actionCountValue, rightRaw);
            if (snapped != null) { needPerAction = snapped; totalNeeded = snapped * actionCountValue; }
            return { needPerAction, totalNeeded, stockOverride: pair.stock, inferred: true };
        }
        if (slashIdx >= 0 && !/[=＝]/.test(raw.slice(0, slashIdx))) {
            let fallbackStock = null;
            const leftNums = parseNumbers(raw.slice(0, slashIdx));
            if (leftNums.length) {
                const candidate = leftNums[leftNums.length - 1];
                if (Number.isFinite(candidate) && candidate >= 0) fallbackStock = candidate;
            }
            const rightNums = parseNumbers(rightRaw);
            if (rightNums.length && Number.isFinite(rightNums[0]) && rightNums[0] >= 0) {
                let totalNeeded = rightNums[0];
                let needPerAction = actionCountValue > 0 ? totalNeeded / actionCountValue : totalNeeded;
                const snapped = _snapLossyNeed(needPerAction, actionCountValue, rightRaw);
                if (snapped != null) { needPerAction = snapped; totalNeeded = snapped * actionCountValue; }
                return { needPerAction, totalNeeded, stockOverride: fallbackStock, inferred: true };
            }
            const needPerAction = parseRequiredPerAction(raw);
            return { needPerAction, totalNeeded: needPerAction * actionCountValue, stockOverride: fallbackStock, inferred: false };
        }
        let fallbackStock = null;
        if (slashIdx >= 0) {
            const leftNums = parseNumbers(String(inputText).slice(0, slashIdx));
            if (leftNums.length) {
                const candidate = leftNums[leftNums.length - 1];
                if (Number.isFinite(candidate) && candidate >= 0) fallbackStock = candidate;
            }
        }
        const needPerAction = parseRequiredPerAction(inputText);
        const totalNeeded = needPerAction * actionCountValue;
        return { needPerAction, totalNeeded, stockOverride: fallbackStock, inferred: false };
    }
 
    /** 從技能面板中提取升級物品的缺料資訊（多候選評分選擇） */
    function extractUpgradeFromModal(modal, actionCount) {
        const allContainers = [...modal.querySelectorAll(SEL.upgradeContainer)];
        const visible = allContainers.filter((el) => isVisible(el));
        const containers = (visible.length ? visible : allContainers).slice(0, 12);
        const upgradeMeta = { containerFound: containers.length > 0, hasSelected: false, href: "", countText: "", parseSource: "", candidateCount: containers.length };
        if (!containers.length) return { upgrade: null, upgradeMeta };
 
        let best = null;
        for (const el of containers) {
            const itemWrap = el.querySelector('[class*="Item_itemContainer"]');
            const itemCore = itemWrap?.querySelector(SEL.itemCore) || el.querySelector(SEL.itemCore) || itemWrap || el;
            const href = extractIconRef(itemCore) || extractUseHref(itemCore);
            const itemId = isLikelyItemRef(href) ? normalizeItemId(href) : "";
            const name = getItemName(itemCore, itemId || t("upgrade_item"));
            const countEl = pickBestCountElement(el);
            const countText = textWithoutInjected(countEl) || "";
            const containerText = textWithoutInjected(el);
            const currentStockRaw = parseInventoryValue(countText || containerText || "0");
            let needPerAction = readUpgradeNeedPerAction(el);
            let totalNeeded = needPerAction * actionCount.value;
            let currentStock = currentStockRaw;
            const upgResolve = resolveNeed(countText || containerText || "0", actionCount.value);
            if (upgResolve.inferred) {
                needPerAction = upgResolve.needPerAction;
                totalNeeded = upgResolve.totalNeeded;
                if (upgResolve.stockOverride != null) currentStock = upgResolve.stockOverride;
            } else if (upgResolve.stockOverride != null) {
                currentStock = upgResolve.stockOverride;
            }
            const totalNeededCeil = Math.ceil(totalNeeded - 1e-9);
            let missing = Math.max(0, totalNeededCeil - currentStock);
            // L2: 越界 = 解析被第三方注入汙染 → 該候選按解析失敗處理
            if (!rowLooksSane(currentStock, needPerAction)) {
                warnSuspectOnce("upgrade-row", { name, countText });
                needPerAction = 0; totalNeeded = 0; missing = 0;
                currentStock = Math.min(Math.max(Number(currentStock) || 0, 0), MAX_SANE_STOCK);
            }
            const coreCls = classNameLower(itemCore);
            const hasWarning = /没有选择升级物品|未选择升级物品|沒有選擇升級物品|未選擇升級物品|choose/i.test(containerText);
            const hrefLower = String(href || "").toLowerCase();
            let score = 0;
            if (itemId) score += 10;
            if (isLikelyItemRef(href)) score += 2;
            if (countEl) score += 2;
            if (currentStock > 0) score += 1;
            if (coreCls.includes("item_empty")) score -= 8;
            if (hasWarning) score -= 4;
            if (hrefLower.includes("skills_sprite")) score -= 6;
            if (!itemId && !countEl) score -= 2;
            const candidate = { score, itemId, name, href, countText, parseSource: countEl ? classNameLower(countEl) : "", currentStock, needPerAction, totalNeeded, missing, missingRounded: missing, container: el, countEl, hasWarning };
            if (!best || candidate.score > best.score) best = candidate;
        }
        if (!best) return { upgrade: null, upgradeMeta };
        upgradeMeta.href = best.href || "";
        upgradeMeta.countText = best.countText || "";
        upgradeMeta.parseSource = best.parseSource || "";
        upgradeMeta.hasSelected = Boolean(best.itemId);
        if (!best.itemId) return { upgrade: null, upgradeMeta };
 
        const upgrade = {
            type: "upgrade", itemId: best.itemId, name: best.name, iconRef: best.href || "",
            currentStock: best.currentStock, needPerAction: best.needPerAction, totalNeeded: best.totalNeeded,
            missing: best.missing, missingRounded: best.missingRounded,
            canAddToCart: true, container: best.container || null, countEl: best.countEl
        };
        return { upgrade, upgradeMeta };
    }
 
    /** 從 svg href 提取規範化物品 ID（去除 #、item_ 字首和 /items/ 路徑） */
    function normalizeItemId(rawHref) {
        const href = String(rawHref || "").trim();
        if (!href) return "";
        if (href.includes("#")) { const after = href.split("#").pop(); return String(after || "").replace(/^item_/, ""); }
        if (href.startsWith("/items/")) return href.slice("/items/".length);
        return href.replace(/^#/, "").replace(/^item_/, "");
    }
 
    /** 規範化購物車物品 ID（統一去除 /items/ 和 # 字首） */
    function normalizeCartItemId(itemId) {
        const raw = String(itemId || "").trim();
        if (!raw) return "";
        if (raw.startsWith("/items/")) return raw.slice("/items/".length);
        return raw.replace(/^#/, "");
    }
 
    /** 判斷引用是否像有效的物品引用（含 items_sprite、/items/ 或 # 開頭） */
    function isLikelyItemRef(rawRef) {
        const ref = String(rawRef || "").toLowerCase();
        if (!ref) return false;
        if (ref.includes("items_sprite")) return true;
        if (ref.includes("/items/")) return true;
        if (ref.startsWith("#") && !ref.includes("skills_")) return true;
        return false;
    }
 
    /** 獲取物品名稱（優先資料層 → SVG aria-label → DOM 文字 → 回退 ID） */
    function getItemName(itemRoot, fallbackId = "") {
        if (_dataLayer.ready && fallbackId) {
            const bareId = normalizeCartItemId(fallbackId);
            if (bareId) {
                const hrid = `/items/${bareId}`;
                const name = _dataLayer.hridToName(hrid);
                if (name) return name;
            }
        }
        if (!itemRoot || !(itemRoot instanceof Element)) return fallbackId || t("unknown_item");
        const svgName = itemRoot.querySelector("svg[aria-label]")?.getAttribute("aria-label");
        if (svgName) return safeText(svgName, 120);
        const nameEl = itemRoot.querySelector('[class*="Item_name"], [class*="Item_label"]');
        if (nameEl) {
            const txt = safeText(nameEl.textContent, 120);
            if (txt) return txt;
        }
        if (fallbackId) return fallbackId;
        return t("unknown_item");
    }
 
    /** 根據當前語言重新解析購物車物品的顯示名稱 */
    function resolveCartDisplayName(row) {
        if (_dataLayer.ready && row.itemId) {
            const hrid = toItemHrid(row.itemId);
            if (hrid) {
                const name = _dataLayer.hridToName(hrid);
                if (name) return name;
            }
        }
        return row.name || row.itemId || t("unknown_item");
    }
 
    // ★ 多層降級獲取 sprite base 路徑
    //   優先順序: 記憶體快取 → Performance API → DOM 掃描 → localStorage 跨會話快取
    //   解決購物車圖示在早期渲染時因 DOM 中尚無 items_sprite 引用而丟失的問題
    const _spriteLS_KEY = "mwi_mm_sprite_base_v1";
    let _spriteBaseCache = "";
    let _spriteBaseResolved = false; // 標記是否已最終確定（非 localStorage 猜測）
 
    /** 設定並快取 sprite 基礎路徑（變更時觸發購物車重繪修復圖示） */
    function _setSpriteBase(base, source) {
        if (!base || _spriteBaseCache === base) return;
        const old = _spriteBaseCache;
        _spriteBaseCache = base;
        _spriteBaseResolved = true;
        try { localStorage.setItem(_spriteLS_KEY, base); } catch { /* ignore */ }
        console.log(`[mwi-mm] sprite base 已確定（${source}）: ${base}`);
        // 如果之前為空或值發生變化（如遊戲更新了 hash），觸發購物車重繪修復圖示
        if (old !== base) {   // 不再依賴舊抽屜存在
            setTimeout(() => Store.notify("cart"), 50);
        }
    }
 
    /** 層1: Performance API — 從瀏覽器資源載入記錄中提取 */
    function _detectSpriteFromPerformance() {
        try {
            const entries = performance.getEntriesByType("resource");
            for (const entry of entries) {
                if (entry.name && entry.name.includes("items_sprite") && entry.name.endsWith(".svg")) {
                    // entry.name 是完整 URL，提取相對路徑
                    const url = new URL(entry.name);
                    return url.pathname; // 如 "/static/media/items_sprite.9c39e2ec.svg"
                }
            }
        } catch { /* ignore */ }
        return "";
    }
 
    /** 層2: DOM 掃描 — 從頁面中已渲染的 svg use 元素提取 */
    function _detectSpriteFromDOM() {
        const uses = document.querySelectorAll('svg use[href*="items_sprite"], svg use[xlink\\:href*="items_sprite"]');
        for (const use of uses) {
            const href = use.getAttribute("href") || use.getAttribute("xlink:href") || "";
            if (href && href.includes("#")) return href.split("#")[0];
        }
        return "";
    }
 
    /** 層3: localStorage 跨會話快取 — 上次成功的值 */
    function _detectSpriteFromStorage() {
        try {
            return localStorage.getItem(_spriteLS_KEY) || "";
        } catch { return ""; }
    }
 
    /** 多層降級檢測 sprite 基礎路徑（Performance API → DOM 掃描 → localStorage） */
    function detectItemsSpriteBase() {
        // 已確認的快取直接返回
        if (_spriteBaseCache && _spriteBaseResolved) return _spriteBaseCache;
 
        // 層1: Performance API（最早可用，遊戲 JS 載入時就請求了 sprite）
        const fromPerf = _detectSpriteFromPerformance();
        if (fromPerf) { _setSpriteBase(fromPerf, "Performance API"); return _spriteBaseCache; }
 
        // 層2: DOM 掃描
        const fromDOM = _detectSpriteFromDOM();
        if (fromDOM) { _setSpriteBase(fromDOM, "DOM"); return _spriteBaseCache; }
 
        // 層3: localStorage（跨會話降級，可能 hash 過期但聊勝於無）
        if (!_spriteBaseCache) {
            const fromLS = _detectSpriteFromStorage();
            if (fromLS) {
                _spriteBaseCache = fromLS; // 暫用，不標記 resolved
                return _spriteBaseCache;
            }
        }
 
        return _spriteBaseCache;
    }
 
    /** 啟動後非同步探測 sprite base，確保儘早獲取 */
    function _initSpriteBaseProbe() {
        // 立即嘗試一次
        detectItemsSpriteBase();
        if (_spriteBaseResolved) return;
 
        // 未成功則定時重試（遊戲載入較慢時 Performance API 可能還沒有記錄）
        let retries = 0;
        const timer = setInterval(() => {
            retries++;
            detectItemsSpriteBase();
            if (_spriteBaseResolved || retries > 30) { // 最多重試 30 次（約 15 秒）
                clearInterval(timer);
                if (!_spriteBaseResolved && _spriteBaseCache) {
                    // localStorage 值雖未驗證，但已經是最好的了
                    _spriteBaseResolved = true;
                    console.log("[mwi-mm] sprite base 使用 localStorage 快取（未驗證）:", _spriteBaseCache);
                }
            }
        }, 500);
    }
 
    /** 解析圖示 href（已有包含 # 的直接返回，否則拼接 sprite base） */
    function resolveItemIconHref(row) {
        const raw = String(row?.iconRef || "").trim();
        if (raw && raw.includes("#")) return raw;
        let id = "";
        if (raw && raw.startsWith("/items/")) {
            id = raw.replace(/^\/items\//, "");
        } else {
            id = normalizeCartItemId(row?.itemId || "");
        }
        if (!id) return "";
        const base = detectItemsSpriteBase();
        if (base) return `${base}#${id}`;
        return `#${id}`;
    }
 
    /** 生成物品圖示的 SVG HTML */
    function renderItemIconSvg(row) {
        const href = resolveItemIconHref(row);
        if (!href) return `<span class="mwi-mm-icon-fallback">?</span>`;
        const safeHref = escapeHtml(href);
        const title = escapeHtml(row?.name || row?.itemId || t("item"));
        return `<svg class="mwi-mm-item-icon" aria-label="${title}" viewBox="0 0 32 32"><use href="${safeHref}" xlink:href="${safeHref}"></use></svg>`;
    }
 
    /** 將 bareId 轉換為 hrid 格式（如 “/items/xxx”） */
    function toItemHrid(itemId) {
        const id = normalizeCartItemId(itemId);
        if (!id) return "";
        return `/items/${id}`;
    }
 
    /** HTML 實體轉義 */
    function escapeHtml(text) {
        return String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }
 
    /**
     * 解析 React Fiber 樹尋找擁有 handleGoToMarketplace 方法的元件例項
     * 用於實現「一鍵直達市場」功能
     */
    function resolveMarketplaceHandlerHost() {
        if (_fiberHostCache && (Date.now() - _fiberHostCachedAt) < FIBER_CACHE_TTL) {
            const fn = _fiberHostCache.handleGoToMarketplace || _fiberHostCache.goToMarketplace || _fiberHostCache.openMarketplace;
            if (typeof fn === "function") return _fiberHostCache;
            _fiberHostCache = null; _fiberHostCachedAt = 0;
        }
        if (window.PGE?.core && (typeof window.PGE.core.handleGoToMarketplace === "function" || typeof window.PGE.core.goToMarketplace === "function" || typeof window.PGE.core.openMarketplace === "function")) {
            _fiberHostCache = window.PGE.core; _fiberHostCachedAt = Date.now(); return window.PGE.core;
        }
        const roots = [];
        const pushRoot = (node) => { if (!node || typeof node !== "object" || roots.includes(node)) return; roots.push(node); };
        const rootEl = document.getElementById("root");
        if (rootEl) {
            pushRoot(rootEl._reactRootContainer?.current);
            pushRoot(rootEl._reactRootContainer?._internalRoot?.current);
            for (const key of Object.getOwnPropertyNames(rootEl)) {
                if (key.startsWith("__reactContainer") || key.startsWith("__reactFiber") || key.startsWith("__reactInternalInstance")) pushRoot(rootEl[key]);
            }
        }
        for (const key of Object.getOwnPropertyNames(document.body || {})) {
            if (key.startsWith("__reactContainer") || key.startsWith("__reactFiber") || key.startsWith("__reactInternalInstance")) pushRoot(document.body[key]);
        }
        if (!roots.length) return null;
        const seen = new Set();
        const stack = [...roots];
        let visited = 0;
        while (stack.length && visited < FIBER_MAX_DEPTH) {
            const fiber = stack.pop();
            if (!fiber || typeof fiber !== "object" || seen.has(fiber)) continue;
            seen.add(fiber); visited++;
            const stateNode = fiber.stateNode;
            if (stateNode && (typeof stateNode.handleGoToMarketplace === "function" || typeof stateNode.goToMarketplace === "function" || typeof stateNode.openMarketplace === "function")) {
                _fiberHostCache = stateNode; _fiberHostCachedAt = Date.now(); return stateNode;
            }
            if (fiber.child) stack.push(fiber.child);
            if (fiber.sibling) stack.push(fiber.sibling);
        }
        return null;
    }
 
    /** 通過 React Fiber 內部方法開啟市場頁面（嘗試多種參數組合） */
    function openMarketplaceByCore(itemId) {
        const hrid = toItemHrid(itemId);
        if (!hrid) return false;
        const host = resolveMarketplaceHandlerHost();
        if (!host) return false;
        const fn = host.handleGoToMarketplace || host.goToMarketplace || host.openMarketplace;
        if (typeof fn !== "function") return false;
        const argSets = [[hrid, 0], [hrid], [normalizeCartItemId(itemId), 0], [normalizeCartItemId(itemId)]];
        for (const args of argSets) {
            try { fn.call(host, ...args); return true; } catch (e) { /* next */ }
        }
        return false;
    }
 
    /** 判斷 href 是否匹配指定物品 ID */
    function matchesItemIdFromHref(rawHref, itemId) {
        const href = String(rawHref || "").toLowerCase();
        const id = normalizeCartItemId(itemId).toLowerCase();
        if (!href || !id) return false;
        return href.includes(`#${id}`) || href.includes(`/items/${id}`) || href.endsWith(id);
    }
 
    /** 開啟市場（通過 React 內部方法） */
    function openMarketplaceForItem(itemId) {
        return openMarketplaceByCore(itemId);
    }
 
    /** 找到當前可見的市場面板 */
    function findVisibleMarketplacePanel() {
        const panels = [...document.querySelectorAll('[class*="MarketplacePanel_marketplacePanel"]')];
        return panels.find((panel) => isVisible(panel)) || null;
    }
 
    /** 清除所有市場高亮標記 */
    function clearMarketTargetHighlight() {
        document.querySelectorAll(".mwi-mm-market-target").forEach((node) => {
            if (node instanceof Element) node.classList.remove("mwi-mm-market-target");
        });
    }
 
    /** 收集市場面板中的所有物品節點 */
    function collectMarketItemNodes(panel) {
        if (!panel) return [];
        const selectors = [`[class*="MarketplacePanel_marketItems"] ${SEL.itemCore}`, `[class*="MarketplacePanel_currentItem"] ${SEL.itemCore}`];
        const out = [], seen = new Set();
        for (const sel of selectors) {
            for (const node of panel.querySelectorAll(sel)) {
                if (!(node instanceof Element) || !isVisible(node) || seen.has(node)) continue;
                seen.add(node); out.push(node);
            }
        }
        return out;
    }
 
    /** 獲取物品節點的高亮宿主元素 */
    function getMarketHighlightHost(itemNode) {
        return itemNode.closest('[class*="Item_itemContainer"]') || itemNode;
    }
 
    /** 獲取購物車中所有有缺料的物品 ID 列表 */
    function getCartLocateIds() {
        const ids = [], seen = new Set();
        for (const row of STATE.cart.values()) {
            if (!row || Number(row.quantity || 0) <= 0) continue;
            const id = normalizeCartItemId(row.itemId);
            if (!id || seen.has(id)) continue;
            seen.add(id); ids.push(id);
        }
        return ids;
    }
 
    /** 在市場面板中定位並高亮購物車中的物品 */
    function locateCartItemsInMarketplace(options = {}) {
        const targetId = normalizeCartItemId(options.targetItemId || STATE.marketTargetItemId || "");
        const doScroll = Boolean(options.scroll);
        clearMarketTargetHighlight();
        const locateIds = getCartLocateIds();
        if (!locateIds.length) {
            STATE.marketPanelVisible = Boolean(findVisibleMarketplacePanel());
            STATE.marketMatchCount = 0; Store.notify("ui");
            return { ok: false, marketOpen: STATE.marketPanelVisible, found: 0, matchedTypes: 0, totalTypes: 0 };
        }
        const idSet = new Set(locateIds.map((x) => x.toLowerCase()));
        const panel = findVisibleMarketplacePanel();
        if (!panel) {
            STATE.marketPanelVisible = false; STATE.marketMatchCount = 0; Store.notify("ui");
            return { ok: false, marketOpen: false, found: 0, matchedTypes: 0, totalTypes: locateIds.length };
        }
        const nodes = collectMarketItemNodes(panel);
        const matches = [], matchedTypes = new Set(), firstHostById = new Map(), seenHost = new Set();
        for (const node of nodes) {
            const href = extractIconRef(node) || extractUseHref(node);
            if (!href) continue;
            let matchedId = "";
            for (const id of idSet) { if (matchesItemIdFromHref(href, id)) { matchedId = id; break; } }
            if (!matchedId) continue;
            const host = getMarketHighlightHost(node);
            if (seenHost.has(host)) continue;
            seenHost.add(host); host.classList.add("mwi-mm-market-target");
            matches.push(host); matchedTypes.add(matchedId);
            if (!firstHostById.has(matchedId)) firstHostById.set(matchedId, host);
        }
        STATE.marketPanelVisible = true; STATE.marketMatchCount = matchedTypes.size;
        if (doScroll && matches.length > 0) {
            const preferredHost = targetId ? firstHostById.get(targetId.toLowerCase()) : null;
            const scrollHost = preferredHost || matches[0];
            try { scrollHost.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" }); } catch (err) { scrollHost.scrollIntoView(); }
        }
        Store.notify("ui");
        return { ok: matchedTypes.size > 0, marketOpen: true, found: matches.length, matchedTypes: matchedTypes.size, totalTypes: locateIds.length };
    }
 
    /** 設定市場定位目標並執行定位 */
    function setMarketTarget(itemId, options = {}) {
        const targetId = normalizeCartItemId(itemId);
        STATE.marketTargetItemId = targetId;
        const result = STATE.locateEnabled ? locateCartItemsInMarketplace({ ...options, targetItemId: targetId }) : { ok: false, marketOpen: Boolean(findVisibleMarketplacePanel()), found: 0, matchedTypes: 0, totalTypes: getCartLocateIds().length, disabled: true };
        Store.notify("cart"); return result;
    }
 
    /** 清除市場定位目標 */
    function clearMarketTarget() {
        STATE.marketTargetItemId = ""; STATE.marketMatchCount = 0;
        STATE.marketPanelVisible = Boolean(findVisibleMarketplacePanel());
        clearMarketTargetHighlight(); Store.notify("cart");
    }
 
    /** 切換市場定位功能開關 */
    function setLocateEnabled(enabled) {
        STATE.locateEnabled = Boolean(enabled);
        if (!STATE.locateEnabled) { STATE.marketMatchCount = 0; clearMarketTargetHighlight(); Store.notify("cart"); Store.notify("ui"); return; }
        syncMarketLocator(); Store.notify("cart");
    }
 
    /** 同步市場定位狀態（用於重新整理時自動重新定位） */
    function syncMarketLocator() {
        if (!STATE.locateEnabled) { STATE.marketPanelVisible = Boolean(findVisibleMarketplacePanel()); STATE.marketMatchCount = 0; clearMarketTargetHighlight(); Store.notify("ui"); return; }
        locateCartItemsInMarketplace({ scroll: false, targetItemId: STATE.marketTargetItemId });
    }
 
    /** 判斷物品是否為金幣（庫存同步時跳過） */
    function isCoinItem(itemId) {
        const id = String(itemId || "").toLowerCase();
        return id.replace(/^\/items\//, "") === "coin";
    }
 
    let _invSnapshot = null;   // DOM 掃描庫存快照快取
    let _invSnapshotAt = 0;     // 快取時間戳
 
    /** 掃描 DOM 獲取庫存快照（有 WS 時直接用 WS 資料，否則遍歷背包面板） */
    function scanInventoryDOM(forceRefresh = false) {
        if (_wsInventory.ready) { const snapshot = _wsInventory.getSnapshot(); _invSnapshot = snapshot; _invSnapshotAt = Date.now(); return snapshot; }
        const now = Date.now();
        if (!forceRefresh && _invSnapshot && (now - _invSnapshotAt) < 200) return _invSnapshot;
        const result = new Map();
        const inventoryPanels = document.querySelectorAll('[class*="Inventory_inventory"]');
        if (!inventoryPanels.length) { _invSnapshot = result; _invSnapshotAt = now; return result; }
        for (const panel of inventoryPanels) {
            for (const container of panel.querySelectorAll('[class*="Item_itemContainer"]')) {
                try {
                    const useEl = container.querySelector('svg use[href]');
                    if (!useEl) continue;
                    const href = useEl.getAttribute("href") || "";
                    const hashIdx = href.lastIndexOf("#");
                    if (hashIdx < 0) continue;
                    const rawId = href.slice(hashIdx + 1);
                    if (!rawId) continue;
                    const countEl = container.querySelector('[class*="Item_count"]');
                    const countText = countEl?.textContent?.trim() || "0";
                    const count = parseInt(countText.replace(/[,\s]/g, ""), 10) || 0;
                    if (count > 0) result.set(rawId, (result.get(rawId) || 0) + count);
                } catch (err) { /* ignore */ }
            }
        }
        _invSnapshot = result; _invSnapshotAt = now; return result;
    }
 
    /** 獲取指定物品的庫存數量（WS 優先，回退 DOM） */
    function getInventoryCount(itemId) {
        const id = normalizeCartItemId(itemId);
        if (!id) return 0;
        if (_wsInventory.ready) return _wsInventory.getCount(id);
        const snapshot = scanInventoryDOM();
        return snapshot.get(id) || 0;
    }
 
 
    // ════════════════════════════════════════════════════════════════════════
    // §07 業務流程 Biz
    //     有效庫存與鎖定 / 購齊通知 / 庫存同步 / 持久化 / 購物車與計劃 CRUD
    //     約束:改資料後只發通知不碰 DOM —— 已完成 Store.notify 接線
    // ════════════════════════════════════════════════════════════════════════
 
    // ── 有效庫存（扣除其他計劃鎖定量）──────────────────
    /** 獲取有效庫存（實際庫存減去其他製作計劃的鎖定量） */
    function getEffectiveInventory(itemId, excludeRecipeHrid) {
        const raw = getInventoryCount(itemId);
        if (!STATE.craftingPlansEnabled || !STATE.craftingPlans.size) return raw;
        const bareId = normalizeCartItemId(itemId);
        // excludeRecipeHrid 可以是 string 或 Set<string>
        const isSet = excludeRecipeHrid instanceof Set;
        let locked = 0;
        for (const plan of STATE.craftingPlans.values()) {
            if (isSet ? excludeRecipeHrid.has(plan.recipeHrid) : plan.recipeHrid === excludeRecipeHrid) continue;
            if (plan.status === "completed") continue;
            locked += plan.materials[bareId] || 0;
        }
        return Math.max(0, raw - locked);
    }
 
    // ── 鎖定明細（徽章和 summary 的鎖定提示用）──────────
    /**
     * 獲取物品被其他製作計劃鎖定的明細。
     * 與 getEffectiveInventory 的遍歷邏輯對稱，但返回鎖定資料而非有效庫存。
     * @returns {{ total: number, byPlan: Array<{name:string, qty:number}> }}
     */
    function getLockedDetails(itemId, excludeRecipeHrid) {
        const empty = { total: 0, byPlan: [] };
        if (!STATE.craftingPlansEnabled || !STATE.craftingPlans.size) return empty;
        const bareId = normalizeCartItemId(itemId);
        if (!bareId) return empty;
        const isSet = excludeRecipeHrid instanceof Set;
        const byPlan = [];
        let total = 0;
        for (const plan of STATE.craftingPlans.values()) {
            if (isSet ? excludeRecipeHrid.has(plan.recipeHrid) : plan.recipeHrid === excludeRecipeHrid) continue;
            if (plan.status === "completed") continue;
            const qty = plan.materials[bareId] || 0;
            if (qty <= 0) continue;
            total += qty;
            byPlan.push({ name: plan.recipeName || plan.recipeHrid, qty });
        }
        return { total, byPlan };
    }
 
    /** 重置所有購物車項的基線庫存（用於重新校準同步） */
    function resetAllBaselines() {
        const snapshot = scanInventoryDOM(true);
        for (const row of STATE.cart.values()) {
            const id = normalizeCartItemId(row.itemId);
            row.baselineStock = snapshot.get(id) || 0;
        }
        saveCart();
    }
 
    /** 購物車面板是否處於開啟狀態 */
 
    // ── 採購完成 → 導航欄內聯橫幅（替代自動跳轉，滿足 1:1 人機對應） ──
    /** 當物品購齊被移出購物車時，通知導航欄顯示內聯完成橫幅 */
    function _notifyNavItemFulfilled(removedNames, removedRows) {
        // ★ 記錄已購齊物品(即使市場沒開也要記，否則下次開市場時它們不會出現在導航條上)
        _purchaseNav.noteFulfilled(removedRows || []);
        if (!findVisibleMarketplacePanel()) return;
        // 找下一個待購物品
        const candidates = [...STATE.cart.values()]
            .filter(r => r.quantity > 0 && !isCoinItem(r.itemId))
            .sort((a, b) => {
                if (a.starred && !b.starred) return -1;
                if (!a.starred && b.starred) return 1;
                return a.name.localeCompare(b.name, _getLocale());
            });
        _purchaseNav._onItemFulfilled(candidates[0] || null);
    }
 
    /**
     * 伺服器已確認的市場買入：直接按成交 count 扣清單。
     * 返回 true 表示本次確實命中了待購項，後續同筆庫存正 delta 應被遮蔽。
     */
    function applyConfirmedMarketPurchaseToCart(rawItemId, rawQuantity) {
        if (!STATE.inventorySyncEnabled) return false;
        const itemId = normalizeCartItemId(rawItemId);
        const quantity = Math.max(0, Math.floor(Number(rawQuantity) || 0));
        const row = itemId ? STATE.cart.get(itemId) : null;
        if (!row || row.quantity <= 0 || quantity <= 0 || isCoinItem(itemId)) return false;
 
        const removedRow = {
            itemId: row.itemId,
            name: resolveCartDisplayName(row),
            iconRef: row.iconRef || ""
        };
        const beforeQty = row.quantity;
        row.quantity = Math.max(0, beforeQty - quantity);
        // 先把預期入庫加到基線；若期間又有消耗，後續庫存更新只會向下校準，不會重複扣清單。
        const baseline = Number(row.baselineStock);
        row.baselineStock = (Number.isFinite(baseline) ? baseline : getInventoryCount(itemId)) + quantity;
        row.updatedAt = nowIso();
 
        let removed = false;
        if (row.quantity <= 0) {
            if (row.starred) row.quantity = 0;
            else { STATE.cart.delete(itemId); removed = true; }
        }
        saveCart();
        Store.notify("cart");
        _log.note("cart-sync", `${itemId} server purchase -${quantity}: ${beforeQty} => ${Math.max(0, beforeQty - quantity)}`);
 
        if (removed) {
            showToast(t("toast_auto_removed", 1), "info");
            _notifyNavItemFulfilled([removedRow.name], [removedRow]);
        }
        const activeCount = [...STATE.cart.values()].filter(r => r.quantity > 0).length;
        if (activeCount === 0 && STATE.autoCollapseEnabled) {
            try {
                if (_newShell.isOpenUI()) {
                    _newShell.collapseUI();
                    showToast(t("toast_all_fulfilled"), "success");
                }
            } catch (err) { /* ignore */ }
        }
        return true;
    }
 
    /**
     * 庫存同步：將購物車缺料與實際庫存變化對比
     * - 庫存增加 → 減少缺料
     * - 庫存減少 → 更新基線
     * - 常備量不足 → 自動回填
     */
    function syncCartWithInventory(changeInfo = null) {
        const suppressedDeltas = new Set();
        if (changeInfo?.source === "patch" && changeInfo.deltas instanceof Map) {
            for (const [itemId, delta] of changeInfo.deltas) {
                if (_marketPurchaseTracker.consumeSuppression(itemId, delta)) suppressedDeltas.add(itemId);
            }
        }
        if (!STATE.inventorySyncEnabled || !STATE.cart.size) return;
        const snapshot = scanInventoryDOM(true);
        if (!snapshot.size) return;
        const exactDeltas = changeInfo?.source === "patch" && changeInfo.deltas instanceof Map
            ? changeInfo.deltas
            : null;
        let changed = false;
        let dirty = false;
        const toRemove = [];
        for (const [id, row] of STATE.cart) {
            if (isCoinItem(id)) continue;
            const bareId = normalizeCartItemId(id);
            const currentStock = snapshot.get(bareId) || 0;
            // WS 路徑：每條 items_updated 單獨處理。負數是消耗，只校準基線；
            // 正數是本次真實入庫，直接扣減待購數量，不再使用跨事件的庫存淨差。
            if (exactDeltas && exactDeltas.has(bareId)) {
                let acquired = exactDeltas.get(bareId) || 0;
                if (suppressedDeltas.has(bareId)) acquired = 0;
                if (row.baselineStock !== currentStock) {
                    row.baselineStock = currentStock;
                    dirty = true;
                }
                if (acquired <= 0) continue;
                const nextQty = Math.max(0, row.quantity - acquired);
                if (nextQty !== row.quantity) {
                    row.quantity = nextQty;
                    changed = true;
                    dirty = true;
                }
                if (row.quantity <= 0) {
                    if (row.starred) row.quantity = 0;
                    else toRemove.push(id);
                }
                continue;
            }
            if (row.baselineStock == null) { row.baselineStock = currentStock; dirty = true; continue; }
            if (currentStock === row.baselineStock) continue;
            if (currentStock < row.baselineStock) { row.baselineStock = currentStock; dirty = true; continue; }
            const acquired = currentStock - row.baselineStock;
            row.baselineStock = currentStock;
            row.quantity = Math.max(0, row.quantity - acquired);
            changed = true;
            dirty = true;
            if (row.quantity <= 0) {
                if (row.starred) row.quantity = 0;
                else toRemove.push(id);
            }
        }
        const refilled = [];
        const nowTs = Date.now();
        for (const [id, row] of STATE.cart) {
            if (!row.starred || !row.threshold || row.threshold <= 0) continue;
            // ★ 使用者手動改數量 5 分鐘內不自動回填，避免覆蓋
            if (row._manualOverrideUntil && nowTs < row._manualOverrideUntil) continue;
            const currentStock = snapshot.get(normalizeCartItemId(id)) || 0;
            if (currentStock < row.threshold) {
                const newQty = row.threshold - currentStock;
                if (newQty !== row.quantity) {
                    row.quantity = newQty; row.baselineStock = currentStock;
                    row._justRefilled = true; changed = true; dirty = true; refilled.push(resolveCartDisplayName(row));
                }
            }
        }
        // ★ 先快照被移除的行(刪除後就取不到了)，供導航條把已購齊物品留在原位顯示
        const removedRows = toRemove.map(id => {
            const row = STATE.cart.get(id);
            if (!row) return null;
            return { itemId: row.itemId, name: resolveCartDisplayName(row), iconRef: row.iconRef || "" };
        }).filter(Boolean);
        const removedNames = removedRows.map(r => r.name);
        for (const id of toRemove) STATE.cart.delete(id);
        if (dirty || changed) {
            saveCart(); Store.notify("cart");
        }
        if (changed) {
            if (toRemove.length) showToast(t("toast_auto_removed", toRemove.length), "info");
            if (refilled.length === 1) showToast(t("toast_refill_one", refilled[0]), "info");
            else if (refilled.length > 1) showToast(t("toast_refill_multi", refilled[0], refilled.length), "info");
            const activeCount = [...STATE.cart.values()].filter(r => r.quantity > 0).length;
            if (activeCount === 0 && STATE.autoCollapseEnabled) {
                // 全部購齊且面板開著 → 自動收起
                try { if (_newShell.isOpenUI()) { _newShell.collapseUI(); showToast(t("toast_all_fulfilled"), "success"); } } catch (err) { /* ignore */ }
            }
            if (toRemove.length) _notifyNavItemFulfilled(removedNames, removedRows);
        }
    }
 
    let _syncDebounceTimer = null;
    let _syncFirstQueuedAt = 0;
    /** 觸發庫存同步(尾沿去抖)。舊版是前沿節流:視窗內後續呼叫全被丟棄,
     *  最後一次狀態永遠排不進來,清單數量會與真實庫存漂移。
     *  現改為每次呼叫重排計時器(以最後一次為準),並帶 400ms 最長等待,
     *  事件連環觸發時也不會無限順延。 */
    function triggerInventorySync(delay = 50) {
        if (!STATE.inventorySyncEnabled) return;
        const now = Date.now();
        if (_syncDebounceTimer) {
            clearTimeout(_syncDebounceTimer);
            _syncDebounceTimer = null;
            if (now - _syncFirstQueuedAt > 400) { _syncFirstQueuedAt = 0; syncCartWithInventory(); return; }
        } else {
            _syncFirstQueuedAt = now;
        }
        _syncDebounceTimer = setTimeout(() => { _syncDebounceTimer = null; _syncFirstQueuedAt = 0; syncCartWithInventory(); }, delay);
    }
 
    /**
     * 判斷當前是否在「當前行動」模式（而非配方列表）
     * ★ 接受 scopeModal 參數，將 tab 搜尋限定在 modal 所屬的面板容器內，
     *   避免其他技能面板的 tab 狀態干擾當前面板的判斷。
     */
    function isCurrentActionMode(scopeModal) {
        let searchRoot = document;
        if (scopeModal) {
            const container = scopeModal.closest('[class*="MainPanel_subPanelContainer"]')
                || scopeModal.closest('[class*="MainPanel_mainPanel"]')
                || scopeModal.parentElement;
            if (container) searchRoot = container;
        }
        const selectedTabs = [...searchRoot.querySelectorAll('button.Mui-selected[role="tab"], button[aria-selected="true"][role="tab"]')];
        for (const tab of selectedTabs) {
            if (!isVisible(tab)) continue;
            const text = safeText(tab.textContent || "", 40);
            if (/当前行动|當前行動|current\s*action/i.test(text)) return true;
        }
        return false;
    }
 
    /** 判斷彈窗是否包含原生行動次數輸入框 */
    function hasNativeActionCountInput(modal) {
        if (!modal) return false;
        for (const scope of _getActionCountScopes(modal)) {
            const containers = [...scope.querySelectorAll('[class*="SkillActionDetail_maxActionCountInput"]')].filter((el) => isVisible(el));
            for (const container of containers) {
                const input = container.querySelector('input[class*="Input_input"]');
                if (input && isVisible(input)) return true;
            }
        }
        return false;
    }
 
    /** 等待遊戲頁面載入完成（檢測 GamePage 存在且無載入遮罩） */
    function waitForGameReady() {
        return new Promise((resolve) => {
            function check() {
                const gamePage = document.querySelector('[class*="GamePage_gamePage"], [class^="GamePage"]');
                if (!gamePage) return false;
                const loadingOverlay = document.querySelector('[class*="LoadingContainer"], [class*="ConnectionStatusBar_disconnected"], [class*="ConnectionStatus_connecting"]');
                if (loadingOverlay && isVisible(loadingOverlay)) return false;
                return true;
            }
            if (check()) { setTimeout(resolve, 1500); return; }
            let elapsed = 0;
            const interval = setInterval(() => {
                elapsed += 500;
                if (check() || elapsed >= 30000) { clearInterval(interval); setTimeout(resolve, 1500); }
            }, 500);
        });
    }
 
    /** 顯示 FAB 懸浮按鈕並恢復儲存的位置 */
    // 注:showToast 是 UI 工具,物理位置在業務區(歷史原因,勿在此區新增 UI 程式碼)
 
    /** 顯示 Toast 提示訊息（1.8s 後淡出） */
    function showToast(msg, tone = "info") {
        const box = document.createElement("div");
        box.className = `mwi-mm-toast mwi-mm-toast-${tone}`;
        box.textContent = msg;
        document.body.appendChild(box);
        setTimeout(() => { box.style.opacity = "0"; box.style.transform = "translateY(-8px)"; }, 1800);
        setTimeout(() => box.remove(), 2300);
    }
 
    // ── 持久化 ──────────────────────────────────────────────────
 
    /** localStorage 寫入共用出口:配額滿與其他錯誤都有訊號,任何持久化失敗不再無聲蒸發 */
    function persistToStorage(key, value, label) {
        try {
            localStorage.setItem(key, value);
        } catch (err) {
            if (err?.name === "QuotaExceededError") { console.warn("[mwi-mm] localStorage 配額已滿(" + label + ")"); showToast("儲存空間不足，" + label + "可能未儲存", "error"); }
            else console.warn("[mwi-mm] save " + label + " failed", err);
        }
    }

    /** 儲存購物車資料到 localStorage */
    function saveCart() {
        const payload = { savedAt: nowIso(), items: [...STATE.cart.values()] };
        persistToStorage(SCRIPT.cartKey, JSON.stringify(payload), "清單");
        // ★ 廣播購物車變化事件給公共 API 訂閱者
        try { _apiInternal.fire("cart:change", () => ({ items: _publicAPI.getCartItems() })); }
        catch (e) { /* never block save on broadcast failure */ }
    }
 
    /** 從 localStorage 載入購物車資料 */
    function loadCart() {
        try {
            const raw = localStorage.getItem(SCRIPT.cartKey);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            const items = Array.isArray(parsed?.items) ? parsed.items : [];
            for (const row of items) {
                if (!row || !row.itemId) continue;
                const itemId = normalizeCartItemId(row.itemId);
                if (!itemId) continue;
                const qty = Number(row.quantity || 0);
                if (!Number.isFinite(qty) || qty < 0) continue;
                if (qty <= 0 && !row.starred) continue;
                STATE.cart.set(itemId, {
                    itemId, name: row.name || itemId, iconRef: row.iconRef || "",
                    quantity: qty, starred: Boolean(row.starred),
                    threshold: (typeof row.threshold === "number" && row.threshold > 0) ? row.threshold : null,
                    baselineStock: row.baselineStock ?? null, source: row.source || "unknown", updatedAt: row.updatedAt || nowIso()
                });
            }
        } catch (err) { console.warn("[mwi-mm] load cart failed", err); }
    }
 
    /** 儲存開關狀態到 localStorage */
    function saveToggles() {
        // 表驅動序列化;欄位與順序由 SETTINGS_SCHEMA 決定(與舊版 一致)
        const out = {};
        for (const def of SETTINGS_SCHEMA) out[def.key] = STATE[def.key];
        persistToStorage(SCRIPT.togglesKey, JSON.stringify(out), "設定");
        Store.notify("settings");   // 設定變更廣播(設定頁據此重繪)
    }
 
    /** 從 localStorage 載入開關狀態 */
    function loadToggles() {
        // 表驅動讀取;各 type 的校驗語義與舊版 的逐欄位寫法 1:1 等價:
        //   bool     → typeof === "boolean" 才覆蓋
        //   num      → typeof === "number" 且通過 validate 才覆蓋(zScore 範圍 / 暴飲袋 -1..20)
        //   shortcut → 物件且 code 為非空字串才覆蓋,並做欄位歸一化(與原結構校驗一致)
        try {
            const raw = localStorage.getItem(SCRIPT.togglesKey);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            for (const def of SETTINGS_SCHEMA) {
                const v = parsed[def.key];
                if (def.type === "bool") {
                    if (typeof v === "boolean") STATE[def.key] = v;
                } else if (def.type === "num") {
                    if (typeof v === "number" && (!def.validate || def.validate(v))) STATE[def.key] = v;
                } else if (def.type === "enum") {
                    if (typeof v === "string" && def.values && def.values.includes(v)) STATE[def.key] = v;
                } else if (def.type === "shortcut") {
                    if (v && typeof v === "object" && typeof v.code === "string" && v.code) {
                        // 顯示名自愈 —— 錄製器存過空白顯示名(Space → " "),按 code 重建
                        let disp = String(v.display || "").trim();
                        if (!disp) {
                            if (v.code === "Space") disp = "Space";
                            else if (v.code.startsWith("Arrow")) disp = v.code.slice(5);
                            else if (v.code.startsWith("Key") && v.code.length === 4) disp = v.code.slice(3);
                            else disp = v.code;
                        }
                        STATE[def.key] = {
                            code: String(v.code),
                            display: disp,
                            ctrl: !!v.ctrl, shift: !!v.shift, alt: !!v.alt, meta: !!v.meta
                        };
                    }
                }
            }
        } catch (err) { /* ignore */ }
    }
 
    // ── 製作計劃持久化 ──────────────────────────────────
 
    /** 儲存製作計劃到 localStorage */
    function savePlans() {
        const arr = [...STATE.craftingPlans.values()];
        persistToStorage(SCRIPT.plansKey, JSON.stringify({ savedAt: nowIso(), plans: arr }), "製作計劃");
    }
 
    /** 從 localStorage 載入製作計劃 */
    function loadPlans() {
        try {
            const raw = localStorage.getItem(SCRIPT.plansKey);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            const plans = Array.isArray(parsed?.plans) ? parsed.plans : [];
            for (const p of plans) {
                if (!p || !p.recipeHrid) continue;
                if (p.status === "completed") continue;
                STATE.craftingPlans.set(p.recipeHrid, {
                    recipeHrid: p.recipeHrid,
                    recipeName: p.recipeName || p.recipeHrid,
                    craftCount: p.craftCount || 1,
                    materials: p.materials || {},
                    materialsPerAction: p.materialsPerAction || {},
                    status: p.status || "active",
                    craftedCount: p.craftedCount || 0,
                    // 快照進度欄位（老版本存檔無此欄位 → 取空值，載入後不顯示進度條，鎖與手動完成不受影響）
                    outputItemId: p.outputItemId || "",
                    outputPerAction: p.outputPerAction || 1,
                    baselineOutput: (typeof p.baselineOutput === "number") ? p.baselineOutput : null,
                    createdAt: p.createdAt || nowIso(),
                    updatedAt: p.updatedAt || nowIso()
                });
            }
        } catch (err) { console.warn("[mwi-mm] load plans failed", err); }
    }
 
    /** 建立或更新制作計劃（記錄配方所需材料及數量） */
    function createOrUpdatePlan(recipeHrid, recipeName, craftCount, allItems) {
        if (!recipeHrid) return;
        const materials = {};
        const materialsPerAction = {};
        for (const item of allItems) {
            const bareId = normalizeCartItemId(item.itemId);
            if (bareId && !isCoinItem(bareId)) {
                // 累加而非覆寫:升級件同時也是配方材料時(allItems 含 requirements + upgrade),
                // 覆寫會丟掉其中一份需求量,導致鎖定量偏低、其他計劃缺料算少
                materials[bareId] = (materials[bareId] || 0) + item.totalNeeded;
                materialsPerAction[bareId] = (materialsPerAction[bareId] || 0)
                    + (item.needPerAction || (craftCount > 0 ? item.totalNeeded / craftCount : item.totalNeeded));
            }
        }
        if (!Object.keys(materials).length) return;
        // 派生產出物資訊：僅生產類配方有乾淨產出物；其餘 outputItemId 留空 → 無進度條（鎖不受影響）
        // 用可選鏈安全讀取資料層（早期未就緒時自然得到空值，非吞錯）
        const _action = _dataLayer?._actionMap?.[recipeHrid] || null;
        let outputItemId = "", outputPerAction = 1;
        if (_action && _action.function === "/action_functions/production" && _action.outputItems?.[0]) {
            outputItemId = String(_action.outputItems[0].itemHrid || "").replace(/^\/items\//, "");
            outputPerAction = _action.outputItems[0].count || 1;
        }
        const existing = STATE.craftingPlans.get(recipeHrid);
        if (existing) {
            existing.materials = materials;
            existing.materialsPerAction = materialsPerAction;
            existing.craftCount = craftCount;
            // 更新計劃數量時保留已經觀測到的單調進度；若目標調小則鉗制到新目標。
            existing.craftedCount = Math.min(
                Math.max(1, Math.round(Number(craftCount) || 1)),
                Math.max(0, Math.round(Number(existing.craftedCount) || 0))
            );
            existing.status = "active";
            existing.updatedAt = nowIso();
            // 已有快照基線則保留（避免重新加購/改數量導致進度跳變）；
            // 缺失時（老版本計劃或此前未取到產出資訊）就地補建基線
            if (!existing.outputItemId || typeof existing.baselineOutput !== "number") {
                existing.outputItemId = outputItemId;
                existing.outputPerAction = outputPerAction;
                existing.baselineOutput = outputItemId ? getInventoryCount(outputItemId) : null;
            }
        } else {
            STATE.craftingPlans.set(recipeHrid, {
                recipeHrid, recipeName, craftCount, materials, materialsPerAction,
                status: "active", craftedCount: 0,
                outputItemId, outputPerAction,
                baselineOutput: outputItemId ? getInventoryCount(outputItemId) : null,
                createdAt: nowIso(), updatedAt: nowIso()
            });
        }
        savePlans();
        Store.notify("plans");
    }
 
    /** 更新計劃製作數量並重算材料鎖定 */
    function updatePlanCraftCount(recipeHrid, newCount) {
        const plan = STATE.craftingPlans.get(recipeHrid);
        if (!plan) return;
        const count = Math.max(1, Math.round(newCount) || 1);
        plan.craftCount = count;
        plan.craftedCount = Math.min(count, Math.max(0, Math.round(Number(plan.craftedCount) || 0)));
        // 用 perAction 重算總鎖定量
        if (plan.materialsPerAction) {
            for (const [bareId, perAction] of Object.entries(plan.materialsPerAction)) {
                plan.materials[bareId] = Math.ceil(perAction * count - 1e-9);
            }
        }
        plan.updatedAt = nowIso();
        savePlans();
        Store.notify("plans");
        STATE.lastDataSignature = "";
        refreshNow();
    }
 
    /** 刪除指定製作計劃 */
    function removePlan(recipeHrid) {
        STATE.craftingPlans.delete(recipeHrid);
        savePlans();
        Store.notify("plans");
        STATE.lastDataSignature = "";
        refreshNow();
    }
 
    /**
     * 計算計劃進度（WS 累計 + 庫存快照補償）。
     * 線上完成次數寫入 craftedCount；庫存淨增量用於補償腳本未執行時完成的製作。
     * 兩者取較大值並回寫高水位，確保產物庫存下降時進度仍保持單調。
     * 返回 null 表示無法計算（無產出物 / 無基線，如非生產類或老版本計劃）。
     */
    function getPlanProgress(plan) {
        if (!plan || !plan.outputItemId) return null;
        if (typeof plan.baselineOutput !== "number") return null;
        const targetActions = Math.max(1, Math.round(Number(plan.craftCount) || 1));
        const outputPerAction = Math.max(1, Number(plan.outputPerAction) || 1);
        const target = Math.max(1, Math.round(targetActions * outputPerAction));
        const now = getInventoryCount(plan.outputItemId);
        const inventoryDelta = Math.max(0, now - plan.baselineOutput);
        const inventoryActions = Math.floor(inventoryDelta / outputPerAction + 1e-9);
        const storedActions = Math.max(0, Math.round(Number(plan.craftedCount) || 0));
        const doneActions = Math.min(targetActions, Math.max(storedActions, inventoryActions));
        if (doneActions !== storedActions) {
            plan.craftedCount = doneActions;
            plan.updatedAt = nowIso();
            savePlans();
        }
        const done = Math.min(target, Math.round(doneActions * outputPerAction));
        return { done, target, pct: target > 0 ? Math.round(done / target * 100) : 0 };
    }
 
    /** 清空所有制作計劃 */
    function clearAllPlans() {
        STATE.craftingPlans.clear();
        savePlans();
        Store.notify("plans");
        STATE.lastDataSignature = "";
        refreshNow();
    }
 
    // ── 購物車操作 ────────────────────────────────────────────────
 
    /**
     * 新增物品到購物車的核心實現（不觸發持久化/渲染）。
     * 單條插入返回 true，參數無效返回 false。
     * 用於內部批次寫場景（API 陣列寫入、採購導航等）以減少重複 saveCart/通知。
     */
    function _addToCartCore(item) {
        if (!item || item.itemId == null) return false;
        const itemId = normalizeCartItemId(item.itemId);
        if (!itemId) return false;
        const qty = Number(item.quantity || 0);
        if (!Number.isFinite(qty) || qty <= 0) return false;
        const existing = STATE.cart.get(itemId);
        if (existing) {
            existing.quantity += qty; existing.updatedAt = nowIso();
            if (!existing.name && item.name) existing.name = item.name;
            if (item.iconRef) existing.iconRef = item.iconRef;
            if (item.source) existing.source = item.source;
        } else {
            STATE.cart.set(itemId, {
                itemId,
                name: item.name || itemId,
                iconRef: item.iconRef || "",
                quantity: qty,
                starred: false,
                threshold: null,
                baselineStock: getInventoryCount(itemId),
                source: item.source || "manual",
                updatedAt: nowIso()
            });
        }
        return true;
    }
 
    /** 新增物品到購物車（已存在則累加數量） */
    function addToCart(item) {
        if (_addToCartCore(item)) {
            saveCart(); Store.notify("cart");
        }
    }
 
    /** 更新購物車物品數量（≤ 0 則刪除或保留收藏） */
    function updateCartItemQty(itemId, newQty) {
        const id = normalizeCartItemId(itemId);
        if (!id) return;
        const row = STATE.cart.get(id);
        if (!row) return;
        const qty = Number(newQty);
        if (!Number.isFinite(qty) || qty <= 0) {
            if (row.starred) row.quantity = 0;
            else STATE.cart.delete(id);
        } else {
            row.quantity = qty;
            row.baselineStock = getInventoryCount(id);
            row.updatedAt = nowIso();
            // ★ 手動改過數量後 5 分鐘內，自動回填不要覆蓋使用者的修改
            row._manualOverrideUntil = Date.now() + 5 * 60 * 1000;
        }
        saveCart(); Store.notify("cart");
    }
 
    /** 從購物車移除物品 */
    function removeCartItem(itemId) { STATE.cart.delete(normalizeCartItemId(itemId)); saveCart(); Store.notify("cart"); }
 
    /** 切換購物車物品的收藏狀態 */
    function toggleCartItemStar(itemId) {
        const id = normalizeCartItemId(itemId);
        if (!id) return;
        const row = STATE.cart.get(id);
        if (!row) return;
        if (row.starred && row.threshold) row.threshold = null;
        row.starred = !row.starred;
        if (!row.starred && row.quantity <= 0) STATE.cart.delete(id);
        saveCart(); Store.notify("cart");
    }
 
    /** 清空整個購物車 */
    function clearCart() { STATE.cart.clear(); saveCart(); Store.notify("cart"); }
 
    /** 清除未收藏物品 */
    function clearNonStarred() {
        let removed = 0;
        for (const [id, row] of STATE.cart) { if (!row.starred) { STATE.cart.delete(id); removed++; } }
        saveCart(); Store.notify("cart"); return removed;
    }
 
    /** 設定物品常備量閾值（低於此值自動回填缺料） */
    function setCartItemThreshold(itemId, value) {
        const id = normalizeCartItemId(itemId);
        if (!id) return;
        const row = STATE.cart.get(id);
        if (!row) return;
        const val = Number(value);
        if (!Number.isFinite(val) || val <= 0) { row.threshold = null; }
        else {
            row.threshold = Math.ceil(val);
            if (!row.starred) row.starred = true;
            const currentStock = getInventoryCount(id);
            if (currentStock < row.threshold) { row.quantity = row.threshold - currentStock; row.baselineStock = currentStock; }
        }
        saveCart(); Store.notify("cart");
    }
 
    /** 清除物品常備量閾值 */
    function clearCartItemThreshold(itemId) { setCartItemThreshold(itemId, 0); }
 
 
 
    // ════════════════════════════════════════════════════════════════════════
    // §07A Actions —— UI 操作入口清單
    //     紀律:未來的新 UI 只允許呼叫 Actions / Store / saveToggles 三者,
    //     不得直接觸碰 §04–§08 的內部函式。函式宣告提升,別名定義即生效。
    // ════════════════════════════════════════════════════════════════════════
    const Actions = {
        // 購物車
        addToCart, updateCartItemQty, removeCartItem, toggleCartItemStar,
        clearCart, clearNonStarred, setCartItemThreshold, clearCartItemThreshold,
        // 製作計劃
        createOrUpdatePlan, updatePlanCraftCount, removePlan, clearAllPlans,
        // 市場定位與跳轉
        // 注:個別別名(clearCartItemThreshold/resetAllBaselines/setMarketTarget/clearMarketTarget)
        // 當前無呼叫者,作為操作面完整性保留,供 UI 演進使用。
        openMarketplaceForItem, setMarketTarget, clearMarketTarget,
        setLocateEnabled, locateCartItemsInMarketplace,
        // 庫存基線
        resetAllBaselines
    };
 
    // ════════════════════════════════════════════════════════════════════════
    // §08 面板檢測與需求提取 Extract
    //     findActiveModal / 房屋面板 / 資料層路徑與 DOM 回退雙路徑並存
    //     DOM 回退路徑是資料層不可用時的備援,需長期保留
    // ════════════════════════════════════════════════════════════════════════
 
    // ── 面板檢測 ──────────────────────────────────────────────────
 
    // ★ 獲取當前可見的主面板容器（非 hidden 的 subPanelContainer）
    //   遊戲切換技能頁面時不銷燬舊面板，只是用 MainPanel_hidden 隱藏容器。
    /** 詳情面板候選是否位於隱藏的主面板容器內(切頁後殘留在 DOM 的舊面板)。
     *  檢測器搜尋範圍為全文件(彈窗等容器外頂層 UI 可見即檢),僅排除此類隱藏舊面板。 */
    function _inHiddenMainContainer(node) {
        const c = node.closest?.('[class*="MainPanel_subPanelContainer"]');
        if (!c) return false;                       // 容器外(彈窗等頂層 UI)→ 不算隱藏
        const cls = c.className || "";
        if (cls.includes("hidden") || cls.includes("Hidden")) return true;
        return !isVisible(c);
    }
 
    function findActiveModal() {
        // 兩遍掃描:先掃主面板容器之外的候選(彈窗層),再掃容器內的內聯詳情。
        const all = [...document.querySelectorAll(SEL.detailRoot)];
        const inMain = (n) => !!n.closest?.('[class*="MainPanel_subPanelContainer"]');
        const nodes = [...all.filter((n) => !inMain(n)), ...all.filter(inMain)];
        for (const node of nodes) {
            if (!isVisible(node)) continue;
            if (_inHiddenMainContainer(node)) continue;
            if (!node.querySelector(SEL.requirements)) continue;
            // 去掉 regularComponent 白名單門禁 —— 它是鍊金/強化「在外掛眼中不存在」
            //   (徽章+加購按鈕一起消失)的根因。現在凡有需求容器的可見技能詳情面板都納入,
            //   語義在 extractRequirements 內由 actionDetail.function 區分。
            return node;
        }
        return null;
    }
 
    /** 查詢當前可見的房屋建造面板（Modal 彈窗中） */
    function findActiveHousePanel() {
        // ★ 修復: 房屋面板在 Modal 彈窗中（Modal_modal → HousePanel_modalContent），
        //   不在 MainPanel_subPanelContainer 內，因此直接搜尋 document。
        const nodes = [...document.querySelectorAll(SEL.houseRoot)];
        for (const node of nodes) {
            if (!isVisible(node)) continue;
            if (!node.querySelector(SEL.houseRequirements)) continue;
            return node;
        }
        return null;
    }
 
    // ★ Housing 面板簽名快取 — 資料未變時跳過 DOM 寫入，減少 mutation 風暴
    let _lastHouseSignature = null;
 
    /** 根據面板標題 + 需求格子文本生成輕量簽名 */
    function getHousingSignature(panel) {
        const name = panel.querySelector('[class*="HousePanel_header"]')?.textContent?.trim() || '';
        const costs = [...panel.querySelectorAll('[class*="HousePanel_itemRequirementCell"]')]
            .map(el => el.textContent.trim())
            .join('|');
        return name + '::' + costs;
    }
 
 
    // ── 資料層路徑 — 從面板標題識別配方 ──────────────────
 
    /** 從技能面板中提取配方標題文字 */
    function _extractPanelTitle(modal) {
        for (const sel of [
            '[class*="SkillActionDetail_name"]',
            '[class*="SkillActionDetail_title"]',
            '[class*="SkillActionDetail_header"]'
        ]) {
            const el = modal.querySelector(sel);
            if (el && isVisible(el)) {
                const text = textWithoutInjected(el).trim();
                if (text && text.length > 0 && text.length < 80) return text;
            }
        }
        return "";
    }
 
    /** 通過 SVG 圖示匹配產出物品，反向查詢對應的製作配方 */
    function _resolveActionBySvg(modal) {
        if (!_dataLayer._outputToAction) return null;
        const svgUses = [...modal.querySelectorAll("svg use")];
        const candidates = new Map();
        for (const use of svgUses) {
            const href = use.getAttribute("href") || use.getAttribute("xlink:href") || "";
            if (!href.includes("items_sprite") || !href.includes("#")) continue;
            const bareId = href.split("#").pop();
            if (!bareId) continue;
            const itemHrid = `/items/${bareId}`;
            const action = _dataLayer._outputToAction.get(itemHrid);
            if (action && action.inputItems && action.inputItems.length > 0) {
                candidates.set(action.hrid, action);
            }
        }
        if (candidates.size === 1) return [...candidates.values()][0];
        return null;
    }
 
    /**
     * 從資料層構建缺料資訊（優先於 DOM 解析）
     * 白名單策略：僅當 regularComponent 存在時才使用資料層，
     * 避免在鍊金/強化之類面板上誤匹配。
     */
    function _buildRequirementsFromData(modal, trace, ctx) {
        // 配方識別優先用 React Fiber 讀到的確定 actionHrid(ctx.actionHrid);
        //   拿不到 ctx 時才回退標題/SVG 啟發式。無 ctx 且無 regularComponent → DOM 未就緒,放棄。
        const title = _extractPanelTitle(modal);   // 函式作用域:既供標題/SVG 回退,也供底部 _recipeName 顯示名
        let actionEntry = (ctx && ctx.actionHrid) ? _dataLayer.resolveActionByHrid(ctx.actionHrid) : null;
        if (!actionEntry) {
            if (!ctx && !modal.querySelector('[class*="SkillActionDetail_regularComponent"]')) { if (trace) trace.push("無 ctx 且無 regularComponent(DOM 未就緒)"); return null; }
            actionEntry = title ? _dataLayer.resolveActionByTitle(title) : null;
            if (!actionEntry) actionEntry = _resolveActionBySvg(modal);
        }
        if (!actionEntry || !actionEntry.inputItems || !actionEntry.inputItems.length) { if (trace) trace.push("配方未解析(ctx=" + JSON.stringify(ctx && ctx.actionHrid) + ", 標題/SVG 回退" + (actionEntry ? "命中但無材料" : "未命中") + ")"); return null; }
 
        if (actionEntry.function !== "/action_functions/production") { if (trace) trace.push("非生產類配方: " + actionEntry.function); return null; }
 
        let actionCount = readActionCount(modal);
        const inCurrentAction = isCurrentActionMode(modal);
        const noNativeInput = !hasNativeActionCountInput(modal);
        const needManualCount = inCurrentAction && noNativeInput;
 
        if (needManualCount && STATE.manualActionCount > 0) {
            actionCount = { value: STATE.manualActionCount, raw: String(STATE.manualActionCount), infinite: false };
        }
 
        const requirementsEl = modal.querySelector(SEL.requirements);
        // 僅保留帶遊戲 CSS-Modules 類名的節點 — 防第三方仿冒類名的注入節點
        //       頂失敗下方的行數交叉校驗(校驗失敗會整體退到易汙染的 DOM 解析路徑)
        const requirementItems = requirementsEl ? [...requirementsEl.querySelectorAll(`:scope > ${SEL.requirementItems}`)].filter(hasGameClass) : [];
        const inventoryEls = requirementsEl ? [...requirementsEl.querySelectorAll(`:scope > ${SEL.requirementInventory}`)].filter(hasGameClass) : [];
        const inputEls = requirementsEl ? [...requirementsEl.querySelectorAll(`:scope > ${SEL.requirementInput}`)].filter(hasGameClass) : [];
 
        if (requirementItems.length > 0 && requirementItems.length !== actionEntry.inputItems.length) {
            if (trace) trace.push("行數交叉校驗失敗: DOM " + requirementItems.length + " 行 vs 資料層 " + actionEntry.inputItems.length + " 項");
            return null;
        }
 
        // 交叉校驗 — 確認 DOM 中的材料圖示與資料層配方的材料一致
        if (requirementItems.length > 0) {
            const dataInputIds = new Set(actionEntry.inputItems.map(i => i.itemHrid.replace(/^\/items\//, "").toLowerCase()));
            let mismatch = false;
            let identified = 0;
            for (const itemWrap of requirementItems) {
                const itemCore = itemWrap.querySelector(SEL.itemCore) || itemWrap;
                const href = extractIconRef(itemCore) || extractUseHref(itemCore);
                const domId = isLikelyItemRef(href) ? normalizeItemId(href).toLowerCase() : "";
                if (domId) {
                    identified++;
                    if (!dataInputIds.has(domId)) { mismatch = true; break; }
                }
            }
            if (mismatch) { if (trace) trace.push("材料圖示交叉校驗失敗(DOM 圖示不在資料層配方中)"); return null; }
            if (identified === 0) { if (trace) trace.push("材料圖示全部無法識別(extractIconRef 失效?)"); return null; }
        }
 
        const artisanBuff = _dataLayer._getArtisanBuff(actionEntry.type);
        const recipeHrid = actionEntry.hrid || "";
 
        const requirements = actionEntry.inputItems.map((input, index) => {
            const bareId = input.itemHrid.replace(/^\/items\//, "");
            const name = _dataLayer.hridToName(input.itemHrid) || getItemName(requirementItems[index]?.querySelector(SEL.itemCore), bareId);
            // ★ 使用有效庫存（扣除其他計劃的鎖定量）
            const currentStock = getEffectiveInventory(bareId, recipeHrid);
            // ★ 金幣不參與 artisan/Z-score 偏移計算（工匠茶不減免金幣）
            const coinItem = isCoinItem(bareId);
            const zVal = _zScoreCalc._effectiveZ(actionCount.value);
            let _zExpected, _zMargin, _zTotal, needPerAction;
            if (coinItem) {
                const linear = Math.ceil(input.count * actionCount.value - 1e-9);
                _zExpected = linear; _zMargin = 0; _zTotal = linear;
                needPerAction = input.count;
            } else {
                ({ expected: _zExpected, margin: _zMargin, total: _zTotal } = _zScoreCalc.calcMaterials(input.count, actionCount.value, artisanBuff, zVal));
                needPerAction = input.count * (1 - artisanBuff);
            }
            const totalNeeded = _zExpected;
            const totalNeededCeil = _zTotal;
            const missing = Math.max(0, totalNeededCeil - currentStock);
 
            return {
                type: "material", index, itemId: bareId, name, currentStock,
                needPerAction, totalNeeded, missing, missingRounded: missing,
                canAddToCart: true, iconRef: input.itemHrid,
                _zExpected, _zMargin, _zTotal, _isCoin: coinItem,
                // 被其他計劃鎖定的明細（金幣不參與）
                lockedByOtherPlans: coinItem ? { total: 0, byPlan: [] } : getLockedDetails(bareId, recipeHrid),
                itemWrap: requirementItems[index] || null,
                inventoryEl: inventoryEls[index] || null,
                inputEl: inputEls[index] || null
            };
        });
 
        let upgrade = null;
        const upgradeMeta = { containerFound: false, hasSelected: false, href: "", countText: "", parseSource: "", candidateCount: 0 };
 
        if (STATE.includeUpgrade && actionEntry.upgradeItemHrid && actionEntry.upgradeItemHrid !== "") {
            const upgHrid = actionEntry.upgradeItemHrid;
            const upgBareId = upgHrid.replace(/^\/items\//, "");
            const upgName = _dataLayer.hridToName(upgHrid) || getItemName(null, upgBareId);
            let upgStock = getEffectiveInventory(upgBareId, recipeHrid);
            const upgNeedPerAction = 1;
            const upgTotalNeeded = upgNeedPerAction * actionCount.value;
            const upgTotalCeil = Math.ceil(upgTotalNeeded - 1e-9);
 
            const matchingReq = requirements.find(r => r.itemId === upgBareId);
            let effectiveStock = upgStock;
            if (matchingReq) effectiveStock = Math.max(0, upgStock - matchingReq.totalNeeded);
            const upgMissing = Math.max(0, upgTotalCeil - effectiveStock);
 
            const container = findBestUpgradeContainer(modal);
            const countEl = container ? pickBestCountElement(container) : null;
 
            upgrade = {
                type: "upgrade", itemId: upgBareId, name: upgName, iconRef: upgHrid,
                currentStock: upgStock, needPerAction: upgNeedPerAction, totalNeeded: upgTotalNeeded,
                missing: upgMissing, missingRounded: upgMissing,
                canAddToCart: true, container: container || null, countEl,
                // 升級材料同樣記錄被其他計劃鎖定的明細
                lockedByOtherPlans: getLockedDetails(upgBareId, recipeHrid)
            };
            upgradeMeta.containerFound = Boolean(container);
            upgradeMeta.hasSelected = true;
            upgradeMeta.href = upgHrid;
        }
 
        const all = upgrade ? [...requirements, upgrade] : requirements;
        const missingList = all.filter(x => {
            if (!x || x.missingRounded <= 0) return false;
            if (x.itemId) return !isCoinItem(x.itemId);
            return true;
        });
 
        return {
            actionCount, requirements, upgrade, upgradeMeta,
            totalMissingTypes: missingList.length,
            totalMissingQty: missingList.reduce((sum, r) => sum + r.missingRounded, 0),
            missingList, isCurrentAction: inCurrentAction, needManualCount,
            _dataLayerUsed: true,
            _artisanBuff: artisanBuff,
            _recipeHrid: recipeHrid,
            _recipeName: title || actionEntry.name || "",
            _isUpgradeChainRecipe: !!(actionEntry.upgradeItemHrid),
            _outputItemHrid: actionEntry.outputItems?.[0]?.itemHrid || ""
        };
    }
 
    /**
     * 從製作面板提取缺料資料（DOM 回退路徑）
     * 優先嘗試資料層解析，失敗則通過 DOM 元素讀取庫存/需求。
     */
    let _lastExtractPath = "";    // 提取路徑變化打點(資料層↔DOM 來回切換是重要線索)
    function _noteExtractPath(path) {
        if (path !== _lastExtractPath) { _lastExtractPath = path; _log.note("extract", "路徑=" + path); }
    }
    function extractRequirements(modal) {
        // 統一入口。先用 React Fiber 讀確定的 actionDetail.function 決定語義,
        //   再按型別分派。production → 資料層(精確,DOM 總量兜底);alchemy/enhancing → DOM
        //   每次消耗語義。全程 fail-open:有可見需求行就一定出資料,絕不返回 null 導致整盤清空。
        const ctx = resolveActionContext(modal);
        const fn = (ctx && ctx.fn) || _inferFunctionFromDom(modal);
 
        if (fn === "/action_functions/production" || fn === "") {
            _dataLayer.ensureReady();   // 資料層未就緒時懶重試(10s 節流;就緒後僅一次布林判斷)
            if (_dataLayer.ready) {
                try {
                    const dataResult = _buildRequirementsFromData(modal, null, ctx);
                    if (dataResult) { _noteExtractPath("資料層"); return dataResult; }
                } catch (e) {
                    console.error("[mwi-mm] _buildRequirementsFromData failed, falling back to DOM:", e);
                }
            }
            _noteExtractPath(fn ? "生產DOM" : "未知DOM");
            return _extractByDom(modal, { perAction: false, kind: fn ? "production" : "generic" });
        }
 
        // 鍊金/強化等非生產:斜槓右側 = 每次消耗,總需 = 每次 × 次數
        const kind = fn === "/action_functions/alchemy" ? "alchemy"
            : fn === "/action_functions/enhancing" ? "enhancing" : "other";
        _noteExtractPath(kind + "DOM");
        return _extractByDom(modal, { perAction: true, kind });
    }
 
    /**
     * 從房屋建造面板提取缺料資料
     * 房屋建造始終為單次操作，無升級物品。
     */
    function extractHouseRequirements(panel) {
        const requirementsEl = panel.querySelector(SEL.houseRequirements);
        if (!requirementsEl) {
            return { actionCount: { value: 1, raw: "1", infinite: false }, requirements: [], upgrade: null, totalMissingTypes: 0, totalMissingQty: 0, missingList: [], isCurrentAction: false, needManualCount: false, isHousePanel: true };
        }
        const actionCount = { value: 1, raw: "1", infinite: false };
        const requirementItems = [...requirementsEl.querySelectorAll(`:scope > ${SEL.requirementItems}`)].filter(hasGameClass);   // 防注入,見 §06 防禦塊
        const inventoryEls = [...requirementsEl.querySelectorAll(`:scope > ${SEL.houseInventory}`)].filter(hasGameClass);
        const inputEls = [...requirementsEl.querySelectorAll(`:scope > ${SEL.houseInput}`)].filter(hasGameClass);
 
        const requirements = requirementItems.map((itemWrap, index) => {
            const itemCore = itemWrap.querySelector(SEL.itemCore) || itemWrap;
            const itemHref = extractIconRef(itemCore) || extractUseHref(itemCore);
            const itemId = isLikelyItemRef(itemHref) ? normalizeItemId(itemHref) : "";
            const name = getItemName(itemCore, itemId);
            const inventoryEl = inventoryEls[index] || null;
            const inputEl = inputEls[index] || null;
            const inventoryText = textWithoutInjected(inventoryEl) || "0";
            const inputText = textWithoutInjected(inputEl) || "0";
 
            let currentStock;
            if (_wsInventory.ready && itemId) currentStock = _wsInventory.getCount(itemId);
            else currentStock = parseInventoryValue(inventoryText);
            let needPerAction = parseRequiredPerAction(inputText);
            // L2: 越界 = 解析被第三方注入汙染 → 該行按解析失敗處理
            if (!rowLooksSane(currentStock, needPerAction)) {
                warnSuspectOnce("house-row", { name, inventoryText, inputText });
                needPerAction = 0;
                currentStock = Math.min(Math.max(Number(currentStock) || 0, 0), MAX_SANE_STOCK);
            }
            const totalNeeded = needPerAction;
            const totalNeededCeil = Math.ceil(totalNeeded - 1e-9);
            const missing = Math.max(0, totalNeededCeil - currentStock);
 
            return { type: "material", index, itemId, name, currentStock, needPerAction, totalNeeded, missing, missingRounded: missing, canAddToCart: Boolean(itemId), iconRef: itemHref || "", itemWrap, inventoryEl, inputEl };
        });
 
        const missingList = requirements.filter((x) => {
            if (!x || x.missingRounded <= 0) return false;
            if (x.itemId) return !isCoinItem(x.itemId);
            return true;
        });
 
        return { actionCount, requirements, upgrade: null, upgradeMeta: null, totalMissingTypes: missingList.length, totalMissingQty: missingList.reduce((sum, row) => sum + row.missingRounded, 0), missingList, isCurrentAction: false, needManualCount: false, isHousePanel: true };
    }
 
 
    // ════════════════════════════════════════════════════════════════════════
    // §09 嵌入式渲染(封存區)
    //     面板徽章 / 鏈樹子行 / 摘要面板 —— 借遊戲樣式嵌入,使用者已確認滿意
    //     本區只隨主題令牌換膚,結構與邏輯不動
    // ════════════════════════════════════════════════════════════════════════
 
    // ── 渲染邏輯 ──────────────────────────────────────────────────
 
    /** 從面板元素向上讀 React Fiber 的 actionDetail(確定的 actionHrid/function)。
     *  探針證實三類面板(製作/鍊金/強化)第 1 層 memoizedProps 即帶 actionDetail,故只淺走幾層。
     *  讀不到時返回 null,由 _inferFunctionFromDom 用 DOM 類名兜底。 */
    function resolveActionContext(modal) {
        try {
            if (!modal) return null;
            const key = Object.keys(modal).find((k) => k.startsWith("__reactFiber$"))
                || Reflect.ownKeys(modal).find((k) => typeof k === "string" && k.startsWith("__reactFiber$"));
            if (!key) return null;
            let f = modal[key], depth = 0;
            while (f && depth < 8) {
                const p = f.memoizedProps;
                if (p && typeof p === "object" && p.actionDetail && p.actionDetail.hrid) {
                    const ad = p.actionDetail;
                    return { actionHrid: ad.hrid, fn: ad.function || "", name: ad.name || "" };
                }
                f = f.return; depth++;
            }
        } catch (e) { /* Fiber 結構變化時靜默回退 DOM 判定 */ }
        return null;
    }
 
    /** Fiber 讀不到時,用 DOM 類名推斷 action function(兜底,非主路徑)。 */
    function _inferFunctionFromDom(modal) {
        if (modal.querySelector('[class*="SkillActionDetail_regularComponent"]')) return "/action_functions/production";
        if (modal.closest && modal.closest('[class*="AlchemyPanel"]')) return "/action_functions/alchemy";
        if (modal.closest && modal.closest('[class*="EnhancingPanel"], [class*="EnhancementPanel"], [class*="EnhancePanel"]')) return "/action_functions/enhancing";
        return "";   // 未知 → extractRequirements 歸入生產分支(資料層通常仍能按標題/SVG 命中)
    }
 
    /** 非生產語義的所需量解析:斜槓右側 = 每次消耗,總需 = 每次 × 次數(鍊金/強化共用)。 */
    function _resolveNeedPerAction(inputText, actionCountValue) {
        const pair = parseStockNeedPair(inputText);
        if (pair) {
            const needPerAction = pair.total;
            return { needPerAction, totalNeeded: needPerAction * actionCountValue, stockOverride: pair.stock, inferred: true };
        }
        const needPerAction = parseRequiredPerAction(inputText);
        return { needPerAction, totalNeeded: needPerAction * actionCountValue, stockOverride: null, inferred: false };
    }
 
    /** 統一 DOM 提取器。opts.perAction=false → 斜槓右側按「總需」(resolveNeed,製作/沖泡);
     *  =true → 斜槓右側按「每次消耗」(鍊金/強化)。逐行鉗制可疑值(降級該行,絕不整盤 null)。
     *  防注入過濾若把行全過濾光則回退原始行(fail-open),確保有可見行就一定出資料。 */
    function _extractByDom(modal, opts) {
        const perAction = !!(opts && opts.perAction);
        const kind = (opts && opts.kind) || "generic";
        const requirementsEl = modal.querySelector(SEL.requirements);
        if (!requirementsEl) {
            return { actionCount: { value: 1, raw: "", infinite: false }, requirements: [], upgrade: null, upgradeMeta: null, totalMissingTypes: 0, totalMissingQty: 0, missingList: [], isCurrentAction: false, needManualCount: false, _recipeHrid: null, _recipeName: _extractPanelTitle(modal) || kind };
        }
 
        let actionCount = readActionCount(modal);
        const inCurrentAction = isCurrentActionMode(modal);
        const noNativeInput = !hasNativeActionCountInput(modal);
        const needManualCount = inCurrentAction && noNativeInput;
        if (needManualCount && STATE.manualActionCount > 0) {
            actionCount = { value: STATE.manualActionCount, raw: String(STATE.manualActionCount), infinite: false };
        }
 
        // 僅生產類用有效庫存(扣其他計劃鎖定量);非生產不參與鎖定
        let domRecipeHrid = "";
        if (!perAction && _dataLayer.ready) {
            const title = _extractPanelTitle(modal);
            const ae = title ? _dataLayer.resolveActionByTitle(title) : null;
            if (ae && ae.function === "/action_functions/production") domRecipeHrid = ae.hrid || "";
        }
 
        // 防注入:僅取帶遊戲 CSS-Modules 類名的行;若過濾後為空但原始有行 → 回退原始(fail-open)
        const pick = (sel) => {
            const raw = [...requirementsEl.querySelectorAll(`:scope > ${sel}`)];
            const filtered = raw.filter(hasGameClass);
            return (filtered.length === 0 && raw.length > 0) ? raw : filtered;
        };
        const requirementItems = pick(SEL.requirementItems);
        const inventoryEls = pick(SEL.requirementInventory);
        const inputEls = pick(SEL.requirementInput);
        const countVal = actionCount.infinite ? 1 : Math.max(1, actionCount.value || 1);
 
        const requirements = requirementItems.map((itemWrap, index) => {
            const itemCore = itemWrap.querySelector(SEL.itemCore) || itemWrap;
            const itemHref = extractIconRef(itemCore) || extractUseHref(itemCore);
            const itemId = isLikelyItemRef(itemHref) ? normalizeItemId(itemHref) : "";
            const name = getItemName(itemCore, itemId);
            const inventoryEl = inventoryEls[index] || null;
            const inputEl = inputEls[index] || null;
            const inventoryText = textWithoutInjected(inventoryEl) || "0";
            const inputText = textWithoutInjected(inputEl) || "0";
 
            const resolved = perAction ? _resolveNeedPerAction(inputText, countVal) : resolveNeed(inputText, actionCount.value);
            let needPerAction = resolved.needPerAction;
            let totalNeeded = resolved.totalNeeded;
            let currentStock;
            if (_wsInventory.ready && itemId) currentStock = (!perAction && domRecipeHrid) ? getEffectiveInventory(itemId, domRecipeHrid) : _wsInventory.getCount(itemId);
            else currentStock = parseInventoryValue(inventoryText);
            if (resolved.stockOverride != null && !_wsInventory.ready) currentStock = resolved.stockOverride;
 
            if (!rowLooksSane(currentStock, needPerAction) || !(totalNeeded <= MAX_SANE_STOCK)) {
                warnSuspectOnce(kind + "-row", { name, inventoryText, inputText });
                needPerAction = 0; totalNeeded = 0;
                currentStock = Math.min(Math.max(Number(currentStock) || 0, 0), MAX_SANE_STOCK);
            }
            const totalNeededCeil = Math.ceil(totalNeeded - 1e-9);
            const missing = Math.max(0, totalNeededCeil - currentStock);
            return { type: "material", index, itemId, name, currentStock, needPerAction, totalNeeded, missing, missingRounded: missing, canAddToCart: Boolean(itemId), iconRef: itemHref || "", itemWrap, inventoryEl, inputEl };
        });
 
        // 升級件僅生產類面板有(鍊金/強化無)
        let upgrade = null, upgradeMeta = null, effectiveUpgrade = null;
        if (!perAction) {
            const u = extractUpgradeFromModal(modal, actionCount);
            upgrade = u.upgrade; upgradeMeta = u.upgradeMeta;
            effectiveUpgrade = STATE.includeUpgrade ? upgrade : null;
            if (effectiveUpgrade && effectiveUpgrade.itemId) {
                if (_wsInventory.ready) effectiveUpgrade.currentStock = _wsInventory.getCount(effectiveUpgrade.itemId);
                const upgId = normalizeCartItemId(effectiveUpgrade.itemId);
                const matchingReq = requirements.find((r) => normalizeCartItemId(r.itemId) === upgId);
                const baseStock = matchingReq ? Math.max(0, matchingReq.currentStock - matchingReq.totalNeeded) : effectiveUpgrade.currentStock;
                effectiveUpgrade.missing = Math.max(0, Math.ceil(effectiveUpgrade.totalNeeded - 1e-9) - baseStock);
                effectiveUpgrade.missingRounded = effectiveUpgrade.missing;
            }
        }
 
        const all = effectiveUpgrade ? [...requirements, effectiveUpgrade] : requirements;
        const missingList = all.filter((x) => {
            if (!x || x.missingRounded <= 0) return false;
            if (x.itemId) return !isCoinItem(x.itemId);
            return true;
        });
        return { actionCount, requirements, upgrade, upgradeMeta, totalMissingTypes: missingList.length, totalMissingQty: missingList.reduce((sum, row) => sum + row.missingRounded, 0), missingList, isCurrentAction: inCurrentAction, needManualCount, _recipeHrid: domRecipeHrid || null, _recipeName: _extractPanelTitle(modal) || kind };
    }
 
    /** 生成資料簽名（用於判斷是否需要重繪） */
    function buildDataSignature(data) {
        if (!data) return "";
        const base = [`ac:${formatQty(data.actionCount?.value || 1)}`, `inf:${data.actionCount?.infinite ? 1 : 0}`, `ca:${data.isCurrentAction ? 1 : 0}`, `mc:${formatQty(STATE.manualActionCount)}`, `iu:${STATE.includeUpgrade ? 1 : 0}`, `dl:${data._dataLayerUsed ? 1 : 0}`, `pl:${STATE.craftingPlansEnabled ? STATE.craftingPlans.size : 0}`, `zi:${STATE.zScoreIndex}`, `zt:${STATE.zScoreThreshold}`, `gl:${STATE.guzzlingPouchLevel}`];
        const mats = (data.requirements || []).map((row) => [row.itemId || row.name || "", formatQty(row.currentStock || 0), formatQty(row.needPerAction || 0), formatQty(row.missingRounded || 0)].join(":"));
        base.push(`m:${mats.join("|")}`);
        if (data.upgrade) base.push(["u", data.upgrade.itemId || data.upgrade.name || "", formatQty(data.upgrade.currentStock || 0), formatQty(data.upgrade.needPerAction || 0), formatQty(data.upgrade.missingRounded || 0)].join(":"));
        else base.push("u:none");
        return base.join(";");
    }
 
    /** 清除彈窗中所有外掛注入的徽章標記 */
    function clearInlineBadges(modal) {
        if (!modal) return;
        withObserverSuppressed(() => {
            modal.querySelectorAll("[data-mm-badge]").forEach((el) => { el.removeAttribute("data-mm-badge"); el.removeAttribute("data-mm-badge-type"); });
            modal.querySelectorAll(".mwi-mm-upgrade-badge, .mwi-mm-upgrade-inline").forEach((el) => el.remove());
        });
    }
 
    /** 徽章逐行完整性核對(「部分抹除」也會觸發補繪):
     *  每個應有徽章的行(非金幣、有掛點)其掛點須仍在文件中且帶 data-mm-badge;
     *  升級件若容器存活則內聯章須在。任一缺失或出錯 → 返回 false,守衛放行全量補繪。 */
    let _badgesFailReason = "";   // _badgesIntact 最近一次判失敗的原因(診斷用)
    function _badgesIntact(modal, data) {
        try {
            for (const r of (data && data.requirements) || []) {
                if (!r.inputEl) continue;
                if (r.itemId && isCoinItem(r.itemId)) continue;
                if (!r.inputEl.isConnected) { _badgesFailReason = "掛點失聯:" + (r.itemId || "?"); return false; }      // 元素被 React 重掛,舊章隨元素丟失
                if (!r.inputEl.hasAttribute("data-mm-badge")) { _badgesFailReason = "章被抹:" + (r.itemId || "?"); return false; }
            }
            if (STATE.includeUpgrade && data && data.upgrade && data.upgrade.container && data.upgrade.container.isConnected) {
                if (!modal.querySelector(".mwi-mm-upgrade-inline, .mwi-mm-upgrade-badge")) { _badgesFailReason = "升級章缺失"; return false; }
            }
            return true;
        } catch (err) { _badgesFailReason = "核對異常:" + (err && err.message); return false; }
    }
 
    /** 在技能面板材料行上渲染缺料徽章（如「缺12」「✓」） */
    function renderInlineBadges(modal, data) {
        // 構造鎖定 hover 文字（徽章共用）。byPlan 按量降序，列全。
        const buildLockedHover = (locked, includeTitle) => {
            if (!locked || !locked.total || !locked.byPlan?.length) return "";
            const sorted = [...locked.byPlan].sort((a, b) => b.qty - a.qty);
            const lines = sorted.map(p => t("locked_hover_line", p.name, formatQty(p.qty)));
            return (includeTitle ? t("locked_hover_title") + "\n" : "") + lines.join("\n");
        };
        withObserverSuppressed(() => {
            const activeEls = new Set();
            const zActive = _zScoreCalc._effectiveZ(data.actionCount?.value || 1) > 0 && data._artisanBuff > 0;
            for (const row of data.requirements) {
                if (!row.inputEl) continue;
                // 金幣行跳過 badge（金幣提醒已在摘要面板顯示）
                if (row._isCoin || isCoinItem(row.itemId)) { activeEls.add(row.inputEl); continue; }
                let badgeText, badgeType;
                if (row.missingRounded > 0) {
                    // 缺料 badge
                    if (zActive && row._zMargin > 0) {
                        const missingBase = Math.max(0, row._zExpected - row.currentStock);
                        badgeText = ` ${t("shortage_n", formatQty(missingBase))}⁺${formatQty(row._zMargin)}`;
                    } else {
                        badgeText = ` ${t("shortage_n", formatQty(row.missingRounded))}`;
                    }
                    badgeType = "missing";
                } else {
                    // 餘量 badge — 顯示做完後還剩多少
                    const surplus = row.currentStock - Math.ceil((row._zTotal || row.totalNeeded) - 1e-9);
                    if (surplus > 0) {
                        badgeText = ` ${t("surplus_n", formatQty(surplus))}`;
                        badgeType = "surplus";
                    } else {
                        badgeText = ` ${t("surplus_n", "0")}`;
                        badgeType = "ok";
                    }
                }
                // 追加鎖定字尾（🔒N）
                const lockedTotal = row.lockedByOtherPlans?.total || 0;
                if (lockedTotal > 0) {
                    badgeText += `（${t("locked_badge", formatQty(lockedTotal))}）`;
                }
                if (row.inputEl.getAttribute("data-mm-badge") !== badgeText) row.inputEl.setAttribute("data-mm-badge", badgeText);
                if (row.inputEl.getAttribute("data-mm-badge-type") !== badgeType) row.inputEl.setAttribute("data-mm-badge-type", badgeType);
                // hover：z-score 公式 + 鎖定明細（按需合併）
                const lockedHover = buildLockedHover(row.lockedByOtherPlans, true);
                let hoverText = "";
                if (zActive && row._zMargin > 0 && row.missingRounded > 0) {
                    hoverText = t("zscore_hover", row._zExpected, row._zMargin, row._zTotal);
                }
                if (lockedHover) hoverText = hoverText ? hoverText + "\n\n" + lockedHover : lockedHover;
                if (hoverText) {
                    if (row.inputEl.getAttribute("title") !== hoverText) row.inputEl.setAttribute("title", hoverText);
                } else {
                    if (row.inputEl.hasAttribute("title")) row.inputEl.removeAttribute("title");
                }
                activeEls.add(row.inputEl);
            }
            if (data.upgrade && STATE.includeUpgrade) {
                const container = data.upgrade.container || data.upgrade.countEl?.closest(SEL.upgradeContainer) || modal.querySelector(SEL.upgradeContainer);
                if (container) {
                    const upgIsMissing = data.upgrade.missingRounded > 0;
                    let newText, upgType;
                    if (upgIsMissing) {
                        newText = t("shortage_n", formatQty(data.upgrade.missingRounded));
                        upgType = "missing";
                    } else {
                        const upgSurplus = (data.upgrade.currentStock || 0) - Math.ceil((data.upgrade.totalNeeded || 0) - 1e-9);
                        newText = upgSurplus > 0 ? t("surplus_n", formatQty(upgSurplus)) : t("surplus_n", "0");
                        upgType = upgSurplus > 0 ? "surplus" : "ok";
                    }
                    // upgrade 行追加鎖定字尾
                    const upgLockedTotal = data.upgrade.lockedByOtherPlans?.total || 0;
                    if (upgLockedTotal > 0) {
                        newText += `（${t("locked_badge", formatQty(upgLockedTotal))}）`;
                    }
                    let inline = container.querySelector(".mwi-mm-upgrade-inline");
                    if (!inline) {
                        inline = document.createElement("div");
                        inline.className = "mwi-mm-upgrade-inline";
                        const warning = container.querySelector('[class*="SkillActionDetail_warning"]');
                        if (warning && warning.parentElement === container) container.insertBefore(inline, warning);
                        else container.appendChild(inline);
                    }
                    if (inline.textContent !== newText) inline.textContent = newText;
                    const hadMissing = inline.classList.contains("is-missing");
                    const hadSurplus = inline.classList.contains("is-surplus");
                    if (upgType === "missing") { if (!hadMissing) { inline.classList.add("is-missing"); inline.classList.remove("is-ok", "is-surplus"); } }
                    else if (upgType === "surplus") { if (!hadSurplus) { inline.classList.add("is-surplus"); inline.classList.remove("is-missing", "is-ok"); } }
                    else { if (hadMissing || hadSurplus) { inline.classList.add("is-ok"); inline.classList.remove("is-missing", "is-surplus"); } }
                    // upgrade 的鎖定 hover
                    const upgLockedHover = buildLockedHover(data.upgrade.lockedByOtherPlans, true);
                    if (upgLockedHover) {
                        if (inline.getAttribute("title") !== upgLockedHover) inline.setAttribute("title", upgLockedHover);
                    } else {
                        if (inline.hasAttribute("title")) inline.removeAttribute("title");
                    }
                    activeEls.add(inline);
                }
            }
            modal.querySelectorAll("[data-mm-badge]").forEach((el) => { if (!activeEls.has(el)) { el.removeAttribute("data-mm-badge"); el.removeAttribute("data-mm-badge-type"); if (el.hasAttribute("title")) el.removeAttribute("title"); } });
            modal.querySelectorAll(".mwi-mm-upgrade-inline").forEach((el) => { if (!activeEls.has(el)) el.remove(); });
 
            // 清理舊的展開按鈕（已改為自動鏈樹）
            modal.querySelectorAll(".mwi-mm-chain-btn").forEach(el => el.remove());
        });
    }
 
    /**
     * 渲染配方鏈子樹行（table 佈局 + 展開/收起）
     */
    function renderChainSubRows(panel, data) {
        let container = panel.querySelector(".mwi-mm-chain-tree");
        if (!data._isUpgradeChainRecipe || !data._outputItemHrid) {
            if (container) container.remove();
            return;
        }
        if (!container) {
            container = document.createElement("div");
            container.className = "mwi-mm-chain-tree";
            const buttonsEl = panel.querySelector(".mwi-mm-summary-buttons");
            if (buttonsEl) panel.insertBefore(container, buttonsEl);
            else panel.appendChild(container);
            // 展開/收起按鈕事件委託
            container.addEventListener("click", (e) => {
                const toggle = e.target.closest(".mwi-mm-chain-toggle");
                if (!toggle) return;
                STATE.chainTreeOpen = !STATE.chainTreeOpen;
                const body = container.querySelector(".mwi-mm-chain-body");
                const arrow = container.querySelector(".mwi-mm-chain-arrow");
                if (body) body.style.display = STATE.chainTreeOpen ? "" : "none";
                if (arrow) arrow.textContent = STATE.chainTreeOpen ? "▼" : "▶";
            });
            // 步驟勾選狀態記入 STATE —— 全量重繪(庫存變動觸發)後據此還原,勾選不再被重置為全選
            container.addEventListener("change", (e) => {
                const cb = e.target.closest(".mwi-mm-chain-step-cb");
                if (!cb || !cb.dataset.stepHrid) return;
                if (cb.checked) STATE.chainStepUnchecked.delete(cb.dataset.stepHrid);
                else STATE.chainStepUnchecked.add(cb.dataset.stepHrid);
            });
        }
        const steps = _recipeChain.getChainSteps(data._outputItemHrid, data.actionCount?.value || 1);
        if (!steps.length) { container.remove(); return; }
        // ★ 收集本鏈所有步驟的 action HRID，顯示庫存時排除自身鏈的鎖定
        const chainExcludeSet = new Set();
        for (const step of steps) {
            const act = _dataLayer._outputToAction?.get(step.stepHrid);
            if (act?.hrid) chainExcludeSet.add(act.hrid);
        }
        const arrow = STATE.chainTreeOpen ? "▼" : "▶";
        const bodyDisplay = STATE.chainTreeOpen ? "" : "none";
        let html = `<div class="mwi-mm-chain-title"><span>${t("chain_title", steps.length)}</span><button class="mwi-mm-chain-toggle"><span class="mwi-mm-chain-arrow">${arrow}</span></button></div>`;
        html += `<table class="mwi-mm-chain-body" style="display:${bodyDisplay}">`;
        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            const isFirst = i === 0;
            const isLast = !step.upgradeFromHrid;
            const stepLabel = isFirst ? t("chain_current") : (isLast ? t("chain_tail") : t("chain_step_from"));
            const stepChecked = STATE.chainStepUnchecked.has(step.stepHrid) ? "" : " checked";
            html += `<tr class="mwi-mm-chain-step-head"><td colspan="3"><label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer"><input type="checkbox" class="mwi-mm-chain-step-cb" data-step-index="${i}" data-step-hrid="${escapeHtml(step.stepHrid)}"${stepChecked} style="cursor:pointer">${escapeHtml(step.stepName)} <span class="mwi-mm-chain-upgrade">${stepLabel}</span> ×${step.craftRuns}</label></td></tr>`;
            for (const mat of step.materials) {
                const bareId = mat.hrid.replace(/^\/items\//, "");
                const stock = getEffectiveInventory(bareId, chainExcludeSet);
                // ★ 扣除購物車已有量，展示真實可用庫存
                const cartRow = STATE.cart.get(bareId);
                const cartReserved = cartRow ? Math.max(0, cartRow.quantity) : 0;
                const availableStock = Math.max(0, stock - cartReserved);
                const missing = Math.max(0, mat.qty - availableStock);
                const surplus = missing === 0 ? availableStock - mat.qty : 0;
                const cls = missing > 0 ? "is-missing" : (surplus > 0 ? "is-surplus" : "is-ok");
                const statusText = missing > 0 ? t("shortage_n", formatQty(missing)) : t("surplus_n", formatQty(surplus));
                html += `<tr class="mwi-mm-chain-row ${cls}"><td class="mwi-mm-chain-name">${escapeHtml(mat.name)}</td>` +
                    `<td class="mwi-mm-chain-qty">${formatQty(mat.qty)}</td>` +
                    `<td class="mwi-mm-chain-stock">(${statusText})</td></tr>`;
            }
        }
        html += `</table>`;
        container.innerHTML = html;
    }
 
    /** 確保彈窗底部存在摘要面板容器（不存在則建立） */
    function ensureSummaryPanel(modal) {
        let panel = modal.querySelector(".mwi-mm-summary-panel");
        if (panel) return panel;
        panel = document.createElement("div");
        panel.className = "mwi-mm-summary-panel";
        const actionContainer = modal.querySelector(SEL.actionContainer);
        if (actionContainer?.parentElement) actionContainer.parentElement.insertBefore(panel, actionContainer);
        else {
            const upgradeBtn = modal.querySelector(SEL.houseUpgradeBtn);
            if (upgradeBtn?.parentElement) upgradeBtn.parentElement.insertBefore(panel, upgradeBtn);
            else { const costsEl = modal.querySelector(SEL.houseCosts); if (costsEl?.nextSibling) costsEl.parentElement.insertBefore(panel, costsEl.nextSibling); else modal.appendChild(panel); }
        }
        return panel;
    }
 
    /** 從遊戲 DOM 中探測按鈕 CSS 類名（用於保持風格一致） */
    function detectGameButtonClass() {
        const btn = document.querySelector('button[class*="Button_button"]');
        if (!btn) return "";
        return [...btn.classList].filter((c) => c.startsWith("Button_button") || c.startsWith("Button_fullWidth")).join(" ");
    }
 
    /** 生成摘要面板的結構 key（用於判斷是否需要重建 DOM） */
    function buildSummaryStructureKey(data) {
        // 增加 hl（has-locked）維度 — 有/無鎖定切換時重建 DOM；純數字變化走快路徑
        let hasLocked = 0;
        for (const row of data.requirements || []) {
            if (row.lockedByOtherPlans?.total > 0) { hasLocked = 1; break; }
        }
        if (!hasLocked && data.upgrade && STATE.includeUpgrade && data.upgrade.lockedByOtherPlans?.total > 0) hasLocked = 1;
        return [`manual:${data.needManualCount ? 1 : 0}`, `iu:${STATE.includeUpgrade ? 1 : 0}`, `mt:${data.totalMissingTypes}`, `mq:${formatQty(data.totalMissingQty)}`, `plan:${!STATE.craftingPlansEnabled ? "off" : data._recipeHrid ? (STATE.craftingPlans.has(data._recipeHrid) ? "y" : "n") : "?"}`, `zi:${STATE.zScoreIndex}`, `zt:${STATE.zScoreThreshold}`, `hl:${hasLocked}`].join("##");
    }
 
    /** 渲染彈窗底部的摘要面板（顯示缺料統計 + 「加入購物清單」按鈕） */
    function renderSummaryPanel(modal, data) {
        const panel = ensureSummaryPanel(modal);
        const structKey = buildSummaryStructureKey(data);
        const prevStructKey = panel.dataset.structKey || "";
 
        // 聚合當前配方所有材料（含 upgrade）被其他計劃鎖定的明細
        const computeLockSummary = () => {
            const items = [];
            const pushIfLocked = (row) => {
                if (!row) return;
                const locked = row.lockedByOtherPlans;
                if (!locked || !locked.total || !locked.byPlan?.length) return;
                items.push({ name: row.name || row.itemId || "?", total: locked.total, byPlan: locked.byPlan });
            };
            for (const row of data.requirements || []) pushIfLocked(row);
            if (data.upgrade && STATE.includeUpgrade) pushIfLocked(data.upgrade);
            if (!items.length) return { hasLocked: false, tagText: "", hoverText: "" };
            const lines = [];
            for (const it of items) {
                lines.push(t("summary_locked_hover_item", it.name, formatQty(it.total)));
                const sorted = [...it.byPlan].sort((a, b) => b.qty - a.qty);
                for (const p of sorted) lines.push(t("summary_locked_hover_sub", p.name, formatQty(p.qty)));
            }
            return {
                hasLocked: true,
                tagText: t("summary_locked_tag", items.length),
                hoverText: t("locked_hover_title") + "\n" + lines.join("\n")
            };
        };
        const lockSummary = computeLockSummary();
 
        if (structKey === prevStructKey && panel.querySelector("[data-mm-stattext]")) {
            withObserverSuppressed(() => {
                // 只更新統計文位元組點，不能給整個 .stat 賦 textContent；後者會刪除
                // 資料層、工匠茶、已有計劃和鎖定提示等子元素。
                const statTextEl = panel.querySelector("[data-mm-stattext]");
                if (statTextEl) {
                    const newStat = data.totalMissingTypes > 0 ? t("summary_missing", data.totalMissingTypes, formatQty(data.totalMissingQty)) : t("summary_sufficient");
                    if (statTextEl.textContent !== newStat) statTextEl.textContent = newStat;
                }
                // lockTag 文字和 hover 跟數字變化同步
                const lockTagEl = panel.querySelector("[data-mm-locktag]");
                if (lockTagEl && lockSummary.hasLocked) {
                    if (lockTagEl.textContent !== lockSummary.tagText) lockTagEl.textContent = lockSummary.tagText;
                    if (lockTagEl.getAttribute("title") !== lockSummary.hoverText) lockTagEl.setAttribute("title", lockSummary.hoverText);
                }
                const manualInput = panel.querySelector(".mwi-mm-manual-input");
                if (manualInput && document.activeElement !== manualInput) { const newVal = String(Math.max(1, STATE.manualActionCount)); if (manualInput.value !== newVal) manualInput.value = newVal; }
            });
            panel._latestData = data; return;
        }
 
        const gameBtnCls = detectGameButtonClass();
        const statText = data.totalMissingTypes > 0 ? t("summary_missing", data.totalMissingTypes, formatQty(data.totalMissingQty)) : t("summary_sufficient");
        const zLabel = _zScoreCalc._effectiveZ(data.actionCount?.value || 1) > 0 ? ` · ${t("zscore_tag", _zScoreCalc.activeLabel())}` : "";
        const sourceTag = data._dataLayerUsed
            ? ` <span style="font-size:9px;color:rgba(99,140,255,0.6);margin-left:4px;">${t("data_layer_tag")}${data._artisanBuff > 0 ? ` · ${t("artisan_tag", (data._artisanBuff * 100).toFixed(1))}${zLabel}` : ""}</span>`
            : '';
        const hasPlan = STATE.craftingPlansEnabled && data._recipeHrid && STATE.craftingPlans.has(data._recipeHrid);
        const planTag = hasPlan ? ` <span style="font-size:9px;color:rgba(96,165,250,0.7);margin-left:4px;display:inline-flex;align-items:center;gap:2px;vertical-align:middle;"><svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>${t("has_plan_tag")}</span>` : '';
        // 鎖定標籤（琥珀色，和藍色的資料層/已有計劃區分；white-space:nowrap 防異常換行）
        const lockTagHtml = lockSummary.hasLocked
            ? ` <span data-mm-locktag="1" style="font-size:9px;color:rgba(240,180,41,0.8);margin-left:4px;white-space:nowrap;cursor:help;"></span>`
            : '';
        const manualCountHtml = data.needManualCount ? `<div class="mwi-mm-manual-count-row"><label class="mwi-mm-manual-label">${t("plan_count_label")}</label><input type="text" inputmode="numeric" pattern="[0-9]*" min="1" step="1" value="${Math.max(1, STATE.manualActionCount)}" class="mwi-mm-manual-input" /></div>` : "";
 
        withObserverSuppressed(() => {
            const prevInput = panel.querySelector(".mwi-mm-manual-input");
            if (prevInput && document.activeElement === prevInput) { STATE._manualInputFocused = true; STATE._manualInputSelStart = prevInput.selectionStart; STATE._manualInputSelEnd = prevInput.selectionEnd; }
            const hasCraftable = data._dataLayerUsed && data._isUpgradeChainRecipe;
            const chainBtn = hasCraftable ? `<button data-act="add-chain" class="${escapeHtml(gameBtnCls)}">${t("add_chain")}</button>` : "";
            // 「建計劃」核取方塊：僅當功能開啟且有真實配方時顯示；預設不勾。
            //   同一配方跨重繪保留使用者勾選；切換到不同配方時重置為不勾（避免誤帶上一個配方的勾選）。
            const planChkKey = data._recipeHrid || "";
            const showPlanChk = STATE.craftingPlansEnabled && !!planChkKey;
            if (showPlanChk) {
                const prevChk = panel.querySelector("[data-mm-planchk]");
                if (STATE._planChkKey !== planChkKey) { STATE._planChkKey = planChkKey; STATE._planChkOn = false; }
                else if (prevChk) { STATE._planChkOn = prevChk.checked; }
            }
            const planChkHtml = showPlanChk
                ? `<label class="mwi-mm-plan-chk" style="display:inline-flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;margin-left:8px;user-select:none;opacity:0.85;"><input type="checkbox" data-mm-planchk${STATE._planChkOn ? " checked" : ""} style="cursor:pointer;margin:0;">${t("create_plan_chk")}</label>`
                : "";
            panel.innerHTML = `<div class="mwi-mm-summary-head"><div class="stat"><span data-mm-stattext="1">${escapeHtml(statText)}</span>${sourceTag}${planTag}${lockTagHtml}</div></div>${manualCountHtml}<div class="mwi-mm-summary-buttons"><button data-act="add" class="${escapeHtml(gameBtnCls)}">${t("add_to_cart")}</button>${chainBtn}${planChkHtml}</div>`;
            // innerHTML 後回填 lockTag 的文字和 title（用 setAttribute 確保換行符保留）
            if (lockSummary.hasLocked) {
                const lockTagEl = panel.querySelector("[data-mm-locktag]");
                if (lockTagEl) {
                    lockTagEl.textContent = lockSummary.tagText;
                    lockTagEl.setAttribute("title", lockSummary.hoverText);
                }
            }
        });
 
        panel.dataset.structKey = structKey;
        panel._latestData = data;
 
        const manualInput = panel.querySelector(".mwi-mm-manual-input");
        if (manualInput) {
            let debounceTimer = null;
            manualInput.addEventListener("input", () => {
                const val = parseInt(manualInput.value, 10);
                STATE.manualActionCount = (Number.isFinite(val) && val > 0) ? val : 1;
                if (debounceTimer) clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => { STATE.lastDataSignature = ""; refreshNow(); }, 180);
            });
            manualInput.addEventListener("keydown", (e) => e.stopPropagation());
            if (STATE._manualInputFocused) {
                STATE._manualInputFocused = false; manualInput.focus();
                try { manualInput.setSelectionRange(STATE._manualInputSelStart ?? manualInput.value.length, STATE._manualInputSelEnd ?? manualInput.value.length); } catch (e) { /* ignore */ }
            }
        }
 
        panel.querySelector('button[data-act="add"]')?.addEventListener("click", () => {
            const latestData = panel._latestData || data;
            let addedQty = 0, addedTypes = 0;
            const skipped = [];
            for (const row of latestData.missingList) {
                if (!row.itemId) { skipped.push(row.name || t("unknown_item")); continue; }
                addToCart({ itemId: row.itemId, name: row.name, iconRef: row.iconRef || "", quantity: row.missingRounded, source: row.type });
                addedQty += row.missingRounded; addedTypes += 1;
            }
            // ★ 同時創建制作計劃（僅在勾選「建計劃」、功能開啟、且有缺料時）
            const wantPlan = panel.querySelector("[data-mm-planchk]")?.checked;
            if (wantPlan && STATE.craftingPlansEnabled && latestData._recipeHrid && latestData.missingList.length > 0 && addedTypes > 0) {
                const allItems = [...latestData.requirements];
                if (latestData.upgrade && STATE.includeUpgrade) allItems.push(latestData.upgrade);
                createOrUpdatePlan(latestData._recipeHrid, latestData._recipeName || latestData._recipeHrid, latestData.actionCount?.value || 1, allItems);
            }
            if (latestData.missingList.length === 0) showToast(t("toast_no_missing"), "info");
            else if (addedTypes <= 0) showToast(t("toast_no_id"), "error");
            else {
                const msg = skipped.length ? t("toast_added_skipped", addedTypes, skipped.length) : t("toast_added", addedTypes, formatQty(addedQty));
                showToast(msg, "success");
            }
            setAction(t("action_added_to_cart")); Store.notify("cart"); try { _newShell.openUI("cart"); } catch (err) { /* ignore */ }
        });
 
        // 「加入全鏈材料」按鈕 — 升級鏈全步驟葉子材料彙總（核取方塊篩選；逐步計劃）
        panel.querySelector('button[data-act="add-chain"]')?.addEventListener("click", () => {
            const latestData = panel._latestData || data;
            if (!latestData._dataLayerUsed || !latestData._outputItemHrid) return;
            // 收集勾選的步驟索引
            const chainTree = panel.querySelector(".mwi-mm-chain-tree");
            const checkedSet = new Set();
            if (chainTree) {
                chainTree.querySelectorAll(".mwi-mm-chain-step-cb").forEach(cb => {
                    if (cb.checked) checkedSet.add(Number(cb.dataset.stepIndex));
                });
            }
            // 獲取全鏈步驟，只彙總勾選的步驟材料
            const steps = _recipeChain.getChainSteps(latestData._outputItemHrid, latestData.actionCount?.value || 1);
            const leafMap = new Map();
            // ★ 收集所有勾選步驟的 action HRID，用於排除自身鏈計劃
            const chainExcludeSet = new Set();
            for (let i = 0; i < steps.length; i++) {
                if (checkedSet.size > 0 && !checkedSet.has(i)) continue;
                const stepAction = _dataLayer._outputToAction?.get(steps[i].stepHrid);
                if (stepAction?.hrid) chainExcludeSet.add(stepAction.hrid);
                for (const mat of steps[i].materials) {
                    leafMap.set(mat.hrid, (leafMap.get(mat.hrid) || 0) + mat.qty);
                }
            }
            // toCartItems 排除本鏈所有步驟的計劃，避免自身鎖定導致誤算
            const cartItems = _recipeChain.toCartItems(leafMap, chainExcludeSet);
            let addedQty = 0, addedTypes = 0;
            for (const item of cartItems) {
                addToCart({ itemId: item.itemId, name: item.name, iconRef: item.iconRef, quantity: item.missing, source: "material" });
                addedQty += item.missing;
                addedTypes += 1;
            }
            // ★ 為每個勾選步驟建立獨立製作計劃（僅在勾選「建計劃」時；路過產物也鎖定各步庫存）
            const wantPlan = panel.querySelector("[data-mm-planchk]")?.checked;
            if (wantPlan && STATE.craftingPlansEnabled) {
                for (let i = 0; i < steps.length; i++) {
                    if (checkedSet.size > 0 && !checkedSet.has(i)) continue;
                    const step = steps[i];
                    const stepAction = _dataLayer._outputToAction?.get(step.stepHrid);
                    const stepRecipeHrid = stepAction?.hrid;
                    if (!stepRecipeHrid) continue;
                    const stepPlanItems = [];
                    for (const mat of step.materials) {
                        const bareId = mat.hrid.replace(/^\/items\//, "");
                        if (isCoinItem(bareId)) continue;
                        stepPlanItems.push({ itemId: bareId, totalNeeded: mat.qty });
                    }
                    if (stepPlanItems.length > 0 || STATE.craftingPlans.has(stepRecipeHrid)) {
                        createOrUpdatePlan(stepRecipeHrid, step.stepName, step.craftRuns, stepPlanItems);
                    }
                }
            }
            if (addedTypes > 0) {
                showToast(t("toast_chain_added", addedTypes, formatQty(addedQty)), "success");
            } else {
                showToast(t("toast_no_missing"), "info");
            }
            setAction(t("action_added_to_cart")); Store.notify("cart"); try { _newShell.openUI("cart"); } catch (err) { /* ignore */ }
        });
    }
 
 
 
    // ════════════════════════════════════════════════════════════════════════
    // §10A 雙形態殼 UI(桌面側欄 / 移動抽屜 · 支援熱切換)
    //     內容:清單(圖示/星標/閾值/數量步進與直填/刪除/單價小計/合計/清空/定位)
    //           + 計劃(產量步進/刪除/清空) + 任務(生產任務進度) + 設定(Schema 渲染)。
    //     形態:matchMedia(760px) 選 rail/sheet,跨斷點熱切換;桌面=邊緣熱區+手柄+
    //           側欄;移動=迷你條(錨定聊天輸入框上方)+兩檔抽屜+鍵盤避讓。
    //     紀律:寫操作只經 §07A Actions 與 saveToggles;只讀白名單:
    //       escapeHtml / formatQty / formatGold / resolveCartDisplayName /
    //       renderItemIconSvg / getInventoryCount / isVisible / isCoinItem /
    //       normalizeCartItemId / SETTINGS_SCHEMA / _themeProbe.tokens /
    //       _marketPrice.{ready,loading,getPrice,ensureData} /
    //       _questTracker.getProductionTasks。此外不得觸碰 §04–§08 內部。
    //     舊浮窗:已物理刪除,本殼為唯一介面(常駐;__shell 僅會話級掛卸除錯)。
    // ════════════════════════════════════════════════════════════════════════
    const _newShell = {
        LS_KEY: "mwi_mm_shell_v1",
        host: null, root: null, els: {},
        _form: null,
        _ui: { open: false, pinned: false, handleY: 30, railW: 340 },   // 預設加寬
        _detent: "mini",
        _tab: "cart",                               // cart | plans | quests | set
        _mq: null, _mqHandler: null,
        _unsubs: [], _suppressClickUntil: 0, _vvHandler: null, _rsHandler: null,
        _holdLock: false, _holdTimer: null, _holdIv: null,
        _priceAsked: false, _priceCheckTimer: null,
        _sx(zh, en) { return _currentLang === "zh" ? zh : en; },
        _jumpHintDismissed() { try { return localStorage.getItem("mwi_mm_jump_hint_dismissed") === "1"; } catch (e) { return false; } },
        SVG: {
            cart: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1.6"/><circle cx="19" cy="21" r="1.6"/><path d="M2 3h3l2.6 12.5a2 2 0 0 0 2 1.5h8.7a2 2 0 0 0 2-1.6L22 7H6"/></svg>',
            pin: '<svg class="ic" viewBox="0 0 24 24" fill="currentColor"><path d="M14.5 2.5l7 7-2 2-.9-.3-3.3 3.3.4 3.2-2 2-4.2-4.2L4 20l-1-1 4.5-4.5L3.3 10.3l2-2 3.2.4 3.3-3.3-.3-.9 2-2z"/></svg>',
            star: '<svg class="ic" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4 6.1 20.5l1.2-6.5L2.5 9.4l6.6-.9z"/></svg>'
        },
 
        CSS: `
:host { all: initial; }
* { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent;
  font-family: "PingFang SC","Microsoft YaHei",system-ui,sans-serif; }
.ic { display: block; }
button { font-family: inherit; border: none; background: none; cursor: pointer; color: inherit; }
::-webkit-scrollbar { width: 7px; }
::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--mm2-textMut) 28%, transparent); border-radius: 4px; }
::-webkit-scrollbar-track { background: transparent; }
 
/* ── Tab:扁平分段 ── */
.mm2-tabs { display: flex; gap: 2px; margin: 8px 12px 0; padding: 2px; flex: 0 0 auto;
  background: color-mix(in srgb, var(--mm2-text) 5%, transparent); border-radius: 7px; }
.mm2-tabs button { flex: 1; padding: 7px 0; font-size: 12px; font-weight: 600;
  color: var(--mm2-textMut); border-radius: 5px; transition: color .12s, background-color .12s; }
.mm2-tabs button:hover { color: var(--mm2-text); }
.mm2-tabs button.on { color: #fff; background: var(--mm2-accent); }
 
/* ── 列表與行 ── */
.mm2-list { flex: 1 1 auto; min-height: 100px; overflow-y: auto; padding: 4px 12px 6px; }
.mm2-prow { display: flex; align-items: center; gap: 9px; min-height: 50px; padding: 5px 2px;
  border-bottom: 1px solid color-mix(in srgb, var(--mm2-line) 40%, transparent); }
.mm2-row { display: grid; grid-template-columns: 26px 44px minmax(0,1fr) auto auto; column-gap: 9px; row-gap: 2px;
  align-items: center; min-height: 56px; padding: 7px 2px;
  border-bottom: 1px solid color-mix(in srgb, var(--mm2-line) 40%, transparent); }
.mm2-row:hover, .mm2-prow:hover { background: color-mix(in srgb, var(--mm2-text) 4%, transparent); }
.mm2-row > .rstar { grid-column: 1; grid-row: 1 / span 2; }
.mm2-row > .mm2-icon { grid-column: 2; grid-row: 1 / span 2; }
.mm2-row > .meta { grid-column: 3; grid-row: 1; }
.mm2-row > .mm2-step, .mm2-row > .mm2-done-tag { grid-column: 4; grid-row: 1; justify-self: end; }
.mm2-row > .rdel { grid-column: 5; grid-row: 1; }
.mm2-row > .sub { grid-column: 3 / 6; grid-row: 2; margin-top: 0; cursor: pointer; }
.nm { font-size: 13.5px; font-weight: 600; color: var(--mm2-text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sub { display: block; font-size: 11px; color: var(--mm2-textMut); margin-top: 2px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sub .th { text-decoration: underline dotted; text-underline-offset: 2px; cursor: pointer; }
.sub .th:hover { color: var(--mm2-gold); }
.sub .pr { color: color-mix(in srgb, var(--mm2-gold) 78%, var(--mm2-textMut)); }
.mm2-row .meta, .mm2-prow .meta { flex: 1; min-width: 0; cursor: pointer; }
.mm2-icon { width: 36px; height: 36px; flex: 0 0 auto; display: flex; align-items: center; justify-content: center;
  background: var(--mm2-cardBg); border-radius: 7px; cursor: pointer; }
.mm2-row .mm2-icon { width: 42px; height: 42px; border-radius: 8px; justify-self: center; }
.mm2-icon:hover { background: color-mix(in srgb, var(--mm2-cardBg) 88%, white); }
.mwi-mm-item-icon { width: 27px; height: 27px; }
.mm2-row .mwi-mm-item-icon { width: 32px; height: 32px; }
.mwi-mm-icon-fallback { color: var(--mm2-textMut); font-weight: 700; font-size: 13px; }
.mm2-row .rstar { width: 26px; height: 32px; display: flex; align-items: center; justify-content: center;
  color: color-mix(in srgb, var(--mm2-textMut) 32%, transparent); border-radius: 5px; transition: color .12s; }
.mm2-row .rstar:hover { color: color-mix(in srgb, var(--mm2-gold) 70%, transparent); }
.mm2-row .rstar.on { color: var(--mm2-gold); }
.mm2-row .rstar .ic { width: 14px; height: 14px; }
.mm2-row .rdel, .mm2-prow .rdel { flex: 0 0 auto; width: 26px; height: 32px; border-radius: 5px;
  color: color-mix(in srgb, var(--mm2-textMut) 55%, transparent); font-size: 15px; transition: color .12s, background-color .12s; }
.mm2-row .rdel:hover, .mm2-prow .rdel:hover { color: #ff8d96; background: color-mix(in srgb, #e05a64 14%, transparent); }
.mm2-row.done .nm { color: var(--mm2-textMut); text-decoration: line-through; font-weight: 500; }
.mm2-done-tag { flex: 0 0 auto; font-size: 11px; font-weight: 700; color: #3edd8b; padding: 3px 8px;
  background: color-mix(in srgb, #3edd8b 12%, transparent); border-radius: 5px; }
.mm2-empty { color: var(--mm2-textMut); text-align: center; font-size: 12.5px; line-height: 1.7; padding: 26px 12px;
  background: color-mix(in srgb, var(--mm2-text) 4%, transparent); border-radius: 8px; margin: 12px 2px; }
 
/* ── 數量步進:扁平槽 ── */
.mm2-step { flex: 0 0 auto; display: flex; align-items: stretch; border-radius: 6px; overflow: hidden;
  background: color-mix(in srgb, var(--mm2-text) 6%, transparent); }
.mm2-step button { width: 27px; font-size: 15px; color: var(--mm2-textMut); transition: color .12s, background-color .12s; }
.mm2-step button:hover { color: var(--mm2-text); background: color-mix(in srgb, var(--mm2-text) 9%, transparent); }
.mm2-step .qv { width: 56px; height: 30px; border: none; outline: none; text-align: center; background: transparent;
  color: var(--mm2-gold); font-size: 13.5px; font-weight: 700; font-variant-numeric: tabular-nums; font-family: inherit; }
.mm2-step .qv:focus { background: color-mix(in srgb, var(--mm2-accent) 16%, transparent); }
 
/* ── 任務 ── */
.mm2-qrow { padding: 10px 4px; border-bottom: 1px solid color-mix(in srgb, var(--mm2-line) 40%, transparent); }
.mm2-qrow .qh { display: flex; justify-content: space-between; align-items: baseline; font-size: 13px; font-weight: 600; color: var(--mm2-text); }
.mm2-qrow .qh b { color: var(--mm2-gold); font-weight: 700; font-size: 11px; font-variant-numeric: tabular-nums; }
.mm2-qbar { height: 4px; background: color-mix(in srgb, var(--mm2-text) 7%, transparent); border-radius: 2px; margin-top: 7px; overflow: hidden; }
.mm2-qbar i { display: block; height: 100%; background: var(--mm2-accent); }
 
/* ── 設定 ── */
.mm2-srow { display: flex; align-items: center; gap: 10px; min-height: 48px; padding: 5px 4px;
  border-bottom: 1px solid color-mix(in srgb, var(--mm2-line) 32%, transparent); }
.mm2-srow .sl { flex: 1; min-width: 0; font-size: 13px; color: var(--mm2-text); font-weight: 600; }
.mm2-srow .sd { display: block; font-size: 10.5px; color: var(--mm2-textMut); font-weight: 400; margin-top: 2px; }
.mm2-swt { flex: 0 0 auto; font-size: 10.5px; color: var(--mm2-textMut); min-width: 18px; text-align: right; }
.mm2-swt.on { color: #3edd8b; font-weight: 700; }
.mm2-sw { flex: 0 0 auto; width: 42px; height: 23px; border-radius: 99px; position: relative;
  background: color-mix(in srgb, var(--mm2-text) 10%, transparent); transition: background-color .15s; }
.mm2-sw::after { content: ""; position: absolute; top: 3px; left: 3px; width: 17px; height: 17px; border-radius: 50%;
  background: #fff; opacity: .5; transition: transform .15s, opacity .15s; }
.mm2-sw.on { background: #29c274; }
.mm2-sw.on::after { transform: translateX(19px); opacity: 1; }
.mm2-sel { flex: 0 0 auto; font-size: 11.5px; color: var(--mm2-text); border: none; border-radius: 6px;
  padding: 6px 8px; background: color-mix(in srgb, var(--mm2-text) 7%, transparent); font-family: inherit; cursor: pointer; }
.mm2-sel:hover { background: color-mix(in srgb, var(--mm2-text) 11%, transparent); }
.mm2-sel option { background: var(--mm2-panelBg); color: var(--mm2-text); }
.mm2-numin { flex: 0 0 auto; width: 76px; font-size: 12px; font-weight: 600; color: var(--mm2-text); text-align: center;
  border: 1px solid color-mix(in srgb, var(--mm2-text) 14%, transparent); border-radius: 6px;
  background: color-mix(in srgb, var(--mm2-text) 6%, transparent); padding: 6px 8px; outline: none;
  font-family: inherit; font-variant-numeric: tabular-nums; transition: border-color .12s, background-color .12s; }
.mm2-numin:focus { border-color: var(--mm2-accent); background: color-mix(in srgb, var(--mm2-text) 9%, transparent); }
.mm2-shint { font-size: 10px; color: var(--mm2-textMut); line-height: 1.7; padding: 12px 4px 4px; }
.mm2-jhint { display: flex; align-items: center; gap: 6px; font-size: 10.5px; color: var(--mm2-textMut);
  padding: 5px 4px 7px; border-bottom: 1px solid color-mix(in srgb, var(--mm2-line) 40%, transparent); }
.mm2-jhint span { flex: 1 1 auto; min-width: 0; line-height: 1.5; }
.mm2-jhint .jhint-x { flex: 0 0 auto; width: 18px; height: 18px; border-radius: 4px; font-size: 13px; line-height: 1;
  color: color-mix(in srgb, var(--mm2-textMut) 60%, transparent); transition: color .12s, background-color .12s; }
.mm2-jhint .jhint-x:hover { color: var(--mm2-text); background: color-mix(in srgb, var(--mm2-text) 6%, transparent); }
.mm2-kbd { display: inline-flex; align-items: center; padding: 3px 8px; border-radius: 5px; font-size: 11px; font-weight: 700;
  color: var(--mm2-gold); background: color-mix(in srgb, var(--mm2-text) 7%, transparent); }
.mm2-mini { padding: 6px 10px; border-radius: 6px; font-size: 11px; font-weight: 600; color: var(--mm2-textMut);
  background: color-mix(in srgb, var(--mm2-text) 7%, transparent); transition: color .12s, background-color .12s; }
.mm2-mini:hover { color: var(--mm2-text); background: color-mix(in srgb, var(--mm2-text) 11%, transparent); }
 
/* ── 頭/腳 ── */
.mm2-head { display: flex; align-items: center; gap: 8px; padding: 11px 14px 9px; flex: 0 0 auto; color: var(--mm2-text);
  border-bottom: 1px solid color-mix(in srgb, var(--mm2-line) 55%, transparent); }
.mm2-head .t { font-size: 14px; font-weight: 700; letter-spacing: .2px; }
.mm2-head .s { font-size: 10.5px; padding: 2px 7px; border-radius: 5px;
  background: color-mix(in srgb, var(--mm2-gold) 12%, transparent); color: color-mix(in srgb, var(--mm2-gold) 85%, white); }
.mm2-head .s:empty { display: none; }
.mm2-head .hb { margin-left: auto; display: flex; gap: 3px; }
.mm2-head .hb button { width: 27px; height: 27px; display: flex; align-items: center; justify-content: center;
  color: var(--mm2-textMut); font-size: 14px; line-height: 1; border-radius: 5px; transition: color .12s, background-color .12s; }
.mm2-head .hb button:hover { color: var(--mm2-text); background: color-mix(in srgb, var(--mm2-text) 9%, transparent); }
.mm2-head .hb button .ic { width: 13px; height: 13px; }
.mm2-head .hb button.pin.on { color: var(--mm2-gold); background: color-mix(in srgb, var(--mm2-gold) 13%, transparent); }
.mm2-foot { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 10px 14px; font-size: 11px;
  color: var(--mm2-textMut); border-top: 1px solid color-mix(in srgb, var(--mm2-line) 55%, transparent); }
.mm2-foot .total { font-size: 10px; line-height: 1.35; }
.mm2-foot .total b { display: block; font-size: 15px; color: var(--mm2-gold); font-weight: 700; font-variant-numeric: tabular-nums; }
.mm2-foot .fbtn { margin-left: auto; padding: 9px 18px; border-radius: 6px; font-size: 12.5px; font-weight: 700;
  color: var(--mm2-text); background: color-mix(in srgb, var(--mm2-text) 8%, transparent); transition: color .12s, background-color .12s; }
.mm2-foot .fbtn:hover { background: color-mix(in srgb, var(--mm2-text) 13%, transparent); }
.mm2-foot .fbtn[data-act="clear"]:hover, .mm2-foot .fbtn[data-act="pclear"]:hover {
  color: #ff8d96; background: color-mix(in srgb, #e05a64 14%, transparent); }
@media (pointer: coarse) {
  .mm2-row, .mm2-prow { min-height: 54px; }
  .mm2-step button { width: 33px; }
  .mm2-step .qv { height: 34px; }
  .mm2-head .hb button { width: 33px; height: 33px; }
  .mm2-foot .fbtn { padding: 11px 20px; }
}
 
/* ── 桌面:自適應高度懸浮卡 ── */
/* ── 邊緣熱區:漸變帶 + 箭頭提示(頻寬跟隨 edgeZoneWidth) ── */
.mm2-hotline { position: fixed; top: 0; right: 0; bottom: 0; width: 2px; pointer-events: none;
  background: linear-gradient(270deg, color-mix(in srgb, var(--mm2-accent) 34%, transparent), transparent);
  opacity: 0; transition: opacity .16s; }
.mm2-hotline.on { opacity: 1; }
.mm2-hzchip { position: absolute; top: 50%; right: 100%; margin-right: 8px; transform: translate(8px,-50%);
  color: var(--mm2-accent); font-size: 19px; font-weight: 800; line-height: 1;
  opacity: 0; transition: opacity .16s, transform .16s; }
.mm2-hotline.on .mm2-hzchip { opacity: 1; transform: translate(0,-50%); }
.mm2-handle { position: fixed; right: 0; width: 32px; height: 62px; cursor: pointer; user-select: none; touch-action: none;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px;
  color: var(--mm2-text); border-radius: 9px 0 0 9px; background: var(--mm2-panelBg);
  box-shadow: -2px 2px 10px rgba(0,0,0,.3); opacity: .85; transition: opacity .15s; }
.mm2-handle:hover { opacity: 1; }
.mm2-handle.hidden { display: none; }
.mm2-handle .ic { width: 16px; height: 16px; }
/* ── 懸浮按鈕待購提示:描金耳朵 + 脈衝點 ── */
.mm2-handle.has-items { box-shadow: -2px 2px 10px rgba(0,0,0,.3), inset 2px 0 0 var(--mm2-gold); }
.mm2-badge { position: absolute; top: 9px; right: 7px; width: 7px; height: 7px; border-radius: 50%;
  background: var(--mm2-gold); box-shadow: 0 0 0 2px var(--mm2-panelBg); }
.mm2-badge.zero { display: none; }
.mm2-badge::after { content: ""; position: absolute; inset: -3px; border-radius: 50%;
  border: 1.5px solid var(--mm2-gold); opacity: .6; animation: mm2BadgePulse 1.6s ease-out infinite; }
@keyframes mm2BadgePulse { 0% { transform: scale(.7); opacity: .7 } 100% { transform: scale(1.9); opacity: 0 } }
@media (prefers-reduced-motion: reduce) { .mm2-badge::after { animation: none; } }
.mm2-rail { position: fixed; top: 56px; right: 10px; display: flex; flex-direction: column;
  max-height: calc(100vh - 96px); min-height: 320px;
  background: var(--mm2-panelBg); border-radius: 10px;
  box-shadow: 0 10px 32px rgba(0,0,0,.45), 0 0 0 1px color-mix(in srgb, var(--mm2-line) 70%, transparent);
  transform: translateX(calc(100% + 16px)); transition: transform .2s ease; }
.mm2-rail.open { transform: translateX(0); }
.mm2-grip { position: absolute; left: -3px; top: 0; bottom: 0; width: 7px; cursor: ew-resize; touch-action: none; border-radius: 10px 0 0 10px; }
.mm2-grip:hover { background: color-mix(in srgb, var(--mm2-accent) 25%, transparent); }
 
/* ── 移動 sheet ── */
.mm2-sheet { position: fixed; left: 0; right: 0; bottom: 0; height: 52%;
  background: var(--mm2-panelBg); border-radius: 14px 14px 0 0;
  box-shadow: 0 -10px 32px rgba(0,0,0,.5);
  display: flex; flex-direction: column; transform: translateY(105%);
  transition: transform .22s ease, height .22s ease; }
.mm2-sheet[data-detent="half"] { transform: translateY(0); height: 52%; }
.mm2-sheet[data-detent="full"] { transform: translateY(0); height: 90%; }
.mm2-grab { padding: 9px 0 4px; cursor: pointer; flex: 0 0 auto; }
.mm2-grab i { display: block; width: 44px; height: 4px; border-radius: 2px;
  background: color-mix(in srgb, var(--mm2-textMut) 45%, transparent); margin: 0 auto; }
`,
 
        // ── 生命週期與形態────────────────────────────────────────
        init() {
            try {
                this._loadUI();
                if (!this._mq) {
                    this._mq = matchMedia("(max-width: 760px)");
                    this._mqHandler = () => { try { this._switchForm(); } catch (err) { /* ignore */ } };
                    this._mq.addEventListener("change", this._mqHandler);
                }
                this._mountForm();
            } catch (err) { console.warn("[mwi-mm] §10A 掛載失敗:", err); }
        },
        destroy() {
            this._teardownDom();
            if (this._priceCheckTimer) { clearTimeout(this._priceCheckTimer); this._priceCheckTimer = null; }
            this._priceAsked = false;
            if (this._mq && this._mqHandler) { try { this._mq.removeEventListener("change", this._mqHandler); } catch (e) { /* ignore */ } }
            this._mq = null; this._mqHandler = null; this._form = null;
        },
        _switchForm() {
            const want = this._mq.matches ? "sheet" : "rail";
            if (want === this._form) return;
            this._teardownDom();
            this._mountForm();
        },
        _mountForm() {
            this._form = this._mq.matches ? "sheet" : "rail";
            if (this._form === "rail") this._mountRail(); else this._mountSheet();
            console.info("[mwi-mm] §10A 已掛載形態:" + this._form);
        },
        _teardownDom() {
            for (const un of this._unsubs) { try { un(); } catch (e) { /* ignore */ } }
            this._unsubs = [];
            this._removeGlobalListeners();
            if (this._holdCommit) { try { this._holdCommit(); } catch (e) { /* ignore */ } }   // 結算殘留的按住會話,防 _holdLock 永久為 true 凍結重繪
            this._clearHold();
            this._holdLock = false;
            if (this._dragEndSession) { try { this._dragEndSession(); } catch (e) { /* ignore */ } }
            if (this.host) { this.host.remove(); }
            this.host = null; this.root = null; this.els = {};
        },
        _makeHost(html) {
            const host = document.createElement("div");
            host.id = "mwi-mm2-host";
            host.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;z-index:2147482198;";
            document.body.appendChild(host);
            this.host = host;
            this.root = host.attachShadow({ mode: "open" });
            this.root.innerHTML = `<style>${this.CSS}</style>` + html;
            this._applyTheme();
            this._unsubs.push(Store.subscribe("cart", () => { if (this._tab === "cart") this._renderCurrent(); else this._renderBadgesOnly(); }));
            this._unsubs.push(Store.subscribe("plans", () => { if (this._tab === "plans") this._renderCurrent(); }));
            this._unsubs.push(Store.subscribe("quests", () => { if (this._tab === "quests") this._renderCurrent(); }));
            this._unsubs.push(Store.subscribe("settings", () => { if (this._tab === "set") this._renderCurrent(); }));
        },
        _applyTheme() {
            if (!this.host) return;
            const tk = (_themeProbe && _themeProbe.tokens) || _themeProbe.STATIC;
            for (const key of _themeProbe.ORDER) this.host.style.setProperty("--mm2-" + key, tk[key]);
        },
 
        // ── 公共骨架(Tab + 列表 + 腳部)──────────────────────────────────────
        _contentHTML() {
            const tb = (id, zh, en) => `<button data-t="${id}"${this._tab === id ? ' class="on"' : ""}>${this._sx(zh, en)}</button>`;
            return `<nav class="mm2-tabs">${tb("cart", "清單", "Cart")}${tb("plans", "計劃", "Plans")}${tb("quests", "任務", "Quests")}${tb("set", "設定", "Settings")}</nav>
<div class="mm2-list"></div>
<div class="mm2-foot"></div>`;
        },
        _bindContent() {
            this.root.querySelector(".mm2-tabs").addEventListener("click", (e) => {
                const b = e.target.closest("button[data-t]");
                if (!b) return;
                this._tab = b.dataset.t;
                this.root.querySelectorAll(".mm2-tabs button").forEach(x => x.classList.toggle("on", x === b));
                this._renderCurrent();
            });
            // 列表事件委託
            const list = this.els.list;
            list.addEventListener("click", (e) => this._onListClick(e));
            list.addEventListener("change", (e) => this._onListChange(e));
            list.addEventListener("pointerdown", (e) => this._onListPointerDown(e));
            this.els.foot.addEventListener("click", (e) => this._onFootClick(e));
        },
 
        // ── 渲染排程 ─────────────────────────────────────────────────────────
        _renderCurrent() {
            if (!this.els.list) return;
            if (this._holdLock) return;                                  // 步進按住期間暫緩重繪
            const fe = this.root.activeElement;
            if (fe && fe.classList && (fe.classList.contains("qv") || fe.classList.contains("mm2-numin"))) {     // 數量/數字輸入聚焦時暫緩
                this._pendingRender = true;
                return;
            }
            this._renderBadgesOnly();
            if (this._tab === "cart") this._renderCart();
            else if (this._tab === "plans") this._renderPlans();
            else if (this._tab === "quests") this._renderQuests();
            else this._renderSettings();
        },
        _renderBadgesOnly() {
            const rows = [...STATE.cart.values()];
            const active = rows.filter(r => r.quantity > 0).length;
            if (this.els.badge) {
                this.els.badge.classList.toggle("zero", active === 0);   // 待購點不顯數字,數量見展開後表頭
            }
            if (this.els.handle) {
                this.els.handle.classList.toggle("has-items", active > 0);
            }
            const countText = active > 0 ? this._sx(`缺 ${active} 項`, `${active} missing`) : this._sx("無缺料", "all set");
            if (this.els.headCount) this.els.headCount.textContent = countText;
        },
 
        // ── 清單 ─────────────────────────────────────────────────────────────
        _priceReady() { return STATE.priceEnabled && _marketPrice.ready; },
        _schedulePriceCheck(delay) {
            if (this._priceCheckTimer) clearTimeout(this._priceCheckTimer);
            if (!STATE.priceEnabled) { this._priceCheckTimer = null; return; }
            const wait = Math.max(250, Number(delay) || 0);
            this._priceCheckTimer = setTimeout(() => {
                this._priceCheckTimer = null;
                this._ensurePrices();
            }, wait);
        },
        _ensurePrices() {
            if (!STATE.priceEnabled || this._priceAsked) return;
            // 有效快取繼續顯示，並在恰好過期時主動重新整理；不再把「有快取」誤當成永久就緒。
            if (_marketPrice.fresh) {
                this._schedulePriceCheck(_marketPrice.refreshDueIn + 100);
                return;
            }
            // 請求失敗後的退避視窗內只排一個定時重試，避免渲染迴圈連續轟擊介面。
            if (_marketPrice.retryDueIn > 0) {
                this._schedulePriceCheck(_marketPrice.retryDueIn + 100);
                return;
            }
            this._priceAsked = true;
            Promise.resolve(_marketPrice.ensureData()).then((ok) => {
                this._priceAsked = false;
                if (ok) {
                    this._schedulePriceCheck(_marketPrice.refreshDueIn + 100);
                    this._renderCurrent();
                } else {
                    this._schedulePriceCheck(Math.max(1000, _marketPrice.retryDueIn));
                }
            }).catch((err) => {
                this._priceAsked = false;
                console.warn("[mwi-mm] Market price refresh scheduling failed:", err);
                this._schedulePriceCheck(_marketPrice.RETRY_INTERVAL);
            });
        },
        _rowHTML(id, r) {
            const done = r.starred && r.quantity <= 0;
            const name = escapeHtml(resolveCartDisplayName(r) || String(id));
            const stock = getInventoryCount(id);
            const sub = [this._sx("庫存 ", "stock ") + formatQty(stock)];
            if (r.starred) {
                const tv = r.threshold > 0 ? r.threshold : this._sx("未設", "off");
                sub.push(`<span class="th" data-act="th">${this._sx("閾值 ", "min ")}${tv}</span>`);
            }
            if (this._priceReady() && !isCoinItem(id)) {
                const p = _marketPrice.getPrice(id);
                if (p > 0) sub.push(`<span class="pr">${formatGold(p)} · ${this._sx("計 ", "= ")}${formatGold(p * Math.max(0, Math.ceil(r.quantity)))}</span>`);
            }
            const mid = done
                ? `<span class="mm2-done-tag">${this._sx("已購齊", "done")}</span>`
                : `<span class="mm2-step"><button data-act="dec">−</button><input class="qv" type="text" inputmode="numeric" value="${Math.max(0, Math.round(r.quantity))}"><button data-act="inc">＋</button></span>`;
            return `<div class="mm2-row${done ? " done" : ""}" data-id="${escapeHtml(String(id))}">
<button class="rstar${r.starred ? " on" : ""}" data-act="star" title="${this._sx("收藏:購齊後保留並監控閾值", "Star: keep & watch")}">${this.SVG.star}</button>
<span class="mm2-icon" data-act="mkt">${renderItemIconSvg(r)}</span>
<span class="meta" data-act="mkt"><span class="nm">${name}</span></span>
${mid}
<button class="rdel" data-act="del" title="${this._sx("移除", "Remove")}">×</button>
<span class="sub" data-act="mkt">${sub.join(" · ")}</span></div>`;
        },
        _renderCart() {
            this._ensurePrices();
            const rows = [...STATE.cart.entries()];
            const hint = (rows.length && !this._jumpHintDismissed())
                ? `<div class="mm2-jhint"><span>${this._sx("點選物品或所在行即可跳轉到市場", "Tap an item or its row to open it in the market")}</span><button class="jhint-x" data-act="jhintclose" title="${this._sx("不再提示", "Dismiss")}">×</button></div>`
                : "";
            this.els.list.innerHTML = rows.length
                ? hint + rows.map(([id, r]) => this._rowHTML(id, r)).join("")
                : `<div class="mm2-empty">${this._sx("清單為空 — 在製作面板點「加入購物清單」", "Cart is empty")}</div>`;
            // 腳部:合計 + 清空 + 定位
            let totalHTML = "";
            if (!STATE.cartTotalEnabled) {
                totalHTML = `<span class="total">${this._sx("共", "Total")} ${rows.length} ${this._sx("條", "items")}</span>`;
            } else if (this._priceReady()) {
                let total = 0, unpriced = 0;
                for (const [id, r] of rows) {
                    const q = Math.ceil(r.quantity || 0);
                    if (q <= 0 || isCoinItem(id)) continue;
                    const p = _marketPrice.getPrice(id);
                    if (p > 0) total += p * q; else unpriced++;
                }
                totalHTML = `<span class="total">${this._sx("補齊合計", "Total")}<b>${formatGold(total)}${unpriced > 0 ? `<small style="font-size:9px;color:var(--mm2-textMut)"> +${unpriced}${this._sx("項未估價", " unpriced")}</small>` : ""}</b></span>`;
            } else {
                totalHTML = `<span class="total">${this._sx("共", "Total")} ${rows.length} ${this._sx("條", "items")}${STATE.priceEnabled ? `<b style="font-size:10px">${this._sx("價格載入中…", "loading prices…")}</b>` : ""}</span>`;
            }
            this.els.foot.innerHTML = `${totalHTML}
<button class="fbtn" data-act="clear" title="${this._sx("清除未收藏項(收藏項保留)", "Clear non-starred")}">${this._sx("清空未收藏", "Clear")}</button>`;
        },
 
        // ── 計劃 ─────────────────────────────────────────────────────────────
        _renderPlans() {
            const plans = [...STATE.craftingPlans.entries()];
            this.els.list.innerHTML = plans.length
                ? plans.map(([hrid, p]) => {
                    const name = escapeHtml(p.recipeName || p.name || String(hrid).replace(/^\/actions\//, ""));
                    const cnt = Math.max(1, Math.round(p.craftCount || 1));
                    // 進度（快照法）：僅生產類且有基線的計劃才有；否則不畫進度條
                    const prog = getPlanProgress(p);
                    const progHtml = prog
                        ? `<div style="display:flex;align-items:center;gap:6px;width:100%;"><div class="mm2-qbar" style="flex:1;margin-top:0;"><i style="width:${prog.pct}%"></i></div><span style="font-size:10px;color:var(--mm2-textMut);white-space:nowrap;">${prog.done}/${prog.target}</span></div>`
                        : "";
                    // 鎖定明細：列出該計劃鎖定的材料及數量
                    const matEntries = Object.entries(p.materials || {});
                    const matStr = matEntries.length
                        ? matEntries.map(([id, qty]) => `${escapeHtml(_dataLayer.hridToName("/items/" + id) || id)}×${formatQty(qty)}`).join("、")
                        : "—";
                    const lockedHtml = `<div style="font-size:10px;color:var(--mm2-textMut);line-height:1.4;width:100%;word-break:break-word;">${this._sx("鎖定", "Locked")}: ${matStr}</div>`;
                    return `<div class="mm2-prow" data-hrid="${escapeHtml(String(hrid))}" style="flex-direction:column;align-items:stretch;gap:6px;">
<div style="display:flex;align-items:center;gap:9px;width:100%;">
<span class="meta"><span class="nm">${name}</span><span class="sub">${this._sx("計劃次數", "actions")} ×${cnt}</span></span>
<span class="mm2-step"><button data-act="pdec">−</button><input class="qv" type="text" inputmode="numeric" value="${cnt}"><button data-act="pinc">＋</button></span>
<button class="rdel" data-act="pdone" title="${this._sx("完成並釋放鎖定", "Complete & release lock")}" style="width:auto;padding:0 9px;font-size:11px;color:var(--mm2-accent);">${this._sx("完成", "Done")}</button>
<button class="rdel" data-act="pdel" title="${this._sx("刪除計劃", "Remove plan")}">×</button></div>
${progHtml}${lockedHtml}</div>`;
                }).join("")
                : `<div class="mm2-empty">${this._sx("暫無製作計劃 — 在製作面板勾選「建計劃」後加購", "No crafting plans")}</div>`;
            this.els.foot.innerHTML = `<span>${this._sx("計劃", "plans")} ${plans.length}</span>
<button class="fbtn" data-act="pclear">${this._sx("清空計劃", "Clear plans")}</button>`;
        },
 
        // ── 任務 ─────────────────────────────────────────────────────────────
        _renderQuests() {
            if (!STATE.questPanelEnabled) {
                this.els.list.innerHTML = `<div class="mm2-empty">${this._sx("任務追蹤已在設定中關閉", "Quest tracking disabled in settings")}</div>`;
                this.els.foot.innerHTML = "";
                return;
            }
            let tasks = [];
            try { tasks = _questTracker.getProductionTasks() || []; } catch (err) { /* ignore */ }
            this.els.list.innerHTML = tasks.length
                ? tasks.map(q => {
                    const pct = q.total > 0 ? Math.min(100, Math.round(q.done / q.total * 100)) : 0;
                    return `<div class="mm2-qrow"><div class="qh"><span>${escapeHtml(q.itemName || q.actionName)}</span><b>${q.done} / ${q.total}</b></div>
<div class="mm2-qbar"><i style="width:${pct}%"></i></div></div>`;
                }).join("")
                : `<div class="mm2-empty">${this._sx("暫無進行中的生產任務(或資料層未就緒)", "No production quests")}</div>`;
            this.els.foot.innerHTML = `<span>${this._sx("生產任務", "tasks")} ${tasks.length}</span>`;
        },
 
        // ── 設定(由 §02B Schema 渲染)────────────────────────────────────────
        SET_LABELS: null,
        _setLabels() {
            if (this.SET_LABELS) return this.SET_LABELS;
            const L = (zh, en, dzh, den) => ({ l: this._sx(zh, en), d: this._sx(dzh || "", den || "") });
            this.SET_LABELS = {
                locateEnabled: L("市場定位高亮", "Market locate", "在市場中脈衝標記清單物品", "Pulse-mark cart items"),
                includeUpgrade: L("計算升級材料", "Include upgrade", "缺料計算包含升級物品", ""),
                inventorySyncEnabled: L("庫存同步購齊", "Inventory sync", "買入後自動劃除清單", "Auto check-off on buy"),
                autoCollapseEnabled: L("購齊自動收起", "Auto collapse", "全部購齊後收起面板", ""),
                autoPrefillEnabled: L("市場數量預填", "Market prefill", "市場彈窗自動填缺料數量", ""),
                purchaseNavEnabled: L("採購導航條", "Purchase nav", "市場頂部的待購物品導航", ""),
                craftingPlansEnabled: L("製作計劃功能", "Crafting plans", "", ""),
                questPanelEnabled: L("任務追蹤功能", "Quest tracking", "", ""),
                priceEnabled: L("價格顯示", "Prices", "清單行顯示單價與小計", ""),
                cartTotalEnabled: L("合計顯示", "Cart total", "", ""),
                edgeZoneWidth: L("邊緣熱區寬度", "Edge zone", "僅桌面;0 = 停用熱區只留手柄", "Desktop only; 0 = off"),
                zScoreIndex: L("備料餘量", "Material buffer", "多備料，減少工匠茶隨機波動", "Buy extra to reduce artisan-tea variance"),
                zScoreThreshold: L("補料起算行動次數", "Buffer threshold", "超過此次數才補料", "Buffer only above this count"),
                guzzlingPouchLevel: L("暴飲袋等級", "Guzzling pouch level", "工匠茶濃縮倍率;自動 = 按已裝備暴飲袋等級檢測", "Tea concentration; auto = detect equipped pouch")
            };
            return this.SET_LABELS;
        },
        _renderSettings() {
            const labels = this._setLabels();
            let html = "";
            for (const def of SETTINGS_SCHEMA) {
                const lab = labels[def.key];
                if (!lab) continue;                                       // 高階項(zScore/暴飲袋/快捷鍵)暫不在此渲染
                const left = `<span class="sl">${lab.l}${lab.d ? `<span class="sd">${lab.d}</span>` : ""}</span>`;
                if (def.type === "bool") {
                    const on = Boolean(STATE[def.key]);
                    html += `<div class="mm2-srow">${left}<span class="mm2-swt${on ? " on" : ""}">${on ? this._sx("開", "on") : this._sx("關", "off")}</span><button class="mm2-sw${on ? " on" : ""}" data-set="${def.key}"></button></div>`;
                } else if (def.key === "edgeZoneWidth") {
                    const opts = [0, 8, 10, 12, 16, 24].map(v =>
                        `<option value="${v}"${STATE.edgeZoneWidth === v ? " selected" : ""}>${v === 0 ? this._sx("停用", "off") : v + "px"}</option>`).join("");
                    html += `<div class="mm2-srow">${left}<select class="mm2-sel" data-sel="edgeZoneWidth">${opts}</select></div>`;
                } else if (def.key === "zScoreIndex") {
                    const opts = Z_OPTIONS.map((o, i) =>
                        `<option value="${i}"${STATE.zScoreIndex === i ? " selected" : ""}>${escapeHtml(this._sx(o.zh, o.en))}${o.pct ? "(" + o.pct + ")" : ""}</option>`).join("");
                    html += `<div class="mm2-srow">${left}<select class="mm2-sel" data-sel="zScoreIndex">${opts}</select></div>`;
                } else if (def.key === "zScoreThreshold") {
                    const cur = Number(STATE.zScoreThreshold) || 10;
                    html += `<div class="mm2-srow">${left}<input class="mm2-numin" data-num="zScoreThreshold" type="text" inputmode="numeric" value="${cur}"></div>`;
                } else if (def.key === "guzzlingPouchLevel") {
                    // -1 的真實語義是「自動檢測」(起,經 WS 查已裝備暴飲袋等級),
                    //       遷入新殼時被誤標為「關」,導致使用者以為自動檢測被砍。邏輯從未改動。
                    let opts = `<option value="-1"${STATE.guzzlingPouchLevel === -1 ? " selected" : ""}>${this._sx("自動檢測", "Auto")}</option>`;
                    for (let v = 0; v <= 20; v++) opts += `<option value="${v}"${STATE.guzzlingPouchLevel === v ? " selected" : ""}>Lv.${v}</option>`;
                    html += `<div class="mm2-srow">${left}<select class="mm2-sel" data-sel="guzzlingPouchLevel">${opts}</select></div>`;
                }
            }
            // 下一項快捷鍵(錄製式)
            {
                const s = STATE.nextItemShortcut;
                html += `<div class="mm2-srow"><span class="sl">${this._sx("下一項快捷鍵", "Next-item shortcut")}<span class="sd">${this._sx("採購導航:跳轉下一個待購物品", "Purchase nav: jump to next item")}</span></span>
${s ? `<span class="mm2-kbd">${escapeHtml(s.display || s.code)}</span>` : `<span class="mm2-swt">${this._sx("未設", "off")}</span>`}
<button class="mm2-mini" data-act="rec">${this._sx("錄製", "Record")}</button>
${s ? `<button class="mm2-mini" data-act="recclear">${this._sx("清除", "Clear")}</button>` : ""}</div>`;
            }
            this.els.list.innerHTML = html;
            this.els.foot.innerHTML = `<span>${this._sx("設定即時生效並自動儲存", "Saved automatically")}</span>`;
        },
 
        // ── 事件:列表委託 ───────────────────────────────────────────────────
        _onListClick(e) {
            const act = e.target.closest("[data-act]")?.dataset.act;
            // 設定開關 / 下拉
            const sw = e.target.closest(".mm2-sw");
            if (sw) {
                const key = sw.dataset.set;
                const next = !STATE[key];
                if (key === "locateEnabled") { try { Actions.setLocateEnabled(next); } catch (err) { STATE[key] = next; } }
                else STATE[key] = next;
                saveToggles();
                this._renderCurrent();
                return;
            }
            if (!act) return;
            if (act === "jhintclose") {
                try { localStorage.setItem("mwi_mm_jump_hint_dismissed", "1"); } catch (e) { /* ignore */ }
                this._renderCart();
                return;
            }
            const row = e.target.closest(".mm2-row");
            const prow = e.target.closest(".mm2-prow");
            const id = row?.dataset.id, hrid = prow?.dataset.hrid;
            try {
                if (act === "star" && id) Actions.toggleCartItemStar(id);
                else if (act === "del" && id) Actions.removeCartItem(id);
                else if (act === "mkt" && id) {
                    Actions.openMarketplaceForItem(id);
                    if (this._form === "sheet") this._setDetent("mini");
                }
                else if (act === "th" && id) {
                    e.stopPropagation();
                    const cur = STATE.cart.get(id)?.threshold || 0;
                    const raw = prompt(this._sx("庫存低於多少時重新提醒補貨?(0=取消監控閾值)", "Restock threshold (0 = off):"), String(cur));
                    if (raw !== null) {
                        const v = Math.max(0, Math.round(Number(raw) || 0));
                        Actions.setCartItemThreshold(id, v);
                    }
                }
                else if (act === "pdone" && hrid) {
                    const _nm = STATE.craftingPlans.get(hrid)?.recipeName || hrid;
                    Actions.removePlan(hrid);
                    showToast(t("toast_plan_completed", _nm), "success");
                }
                else if (act === "pdel" && hrid) Actions.removePlan(hrid);
                else if (act === "rec") {
                    e.stopPropagation();
                    const btn = e.target.closest("[data-act]");
                    btn.textContent = this._sx("按任意鍵…(Esc 取消)", "press a key… (Esc cancels)");
                    // 改調 §07 _shortcutManager.captureOnce 統一錄製入口(白名單追加),
                    //       替代 在本區重寫的簡化錄製器(丟了顯示名特判/修飾鍵過濾/觸發抑制)
                    _shortcutManager.captureOnce(() => this._renderCurrent());
                }
                else if (act === "recclear") { STATE.nextItemShortcut = null; saveToggles(); }
            } catch (err) { console.warn("[mwi-mm] §10A 操作失敗:", act, err); }
        },
        _onListChange(e) {
            const input = e.target;
            if (!input.classList || !input.classList.contains("qv")) return;
            const v = Math.max(0, Math.round(Number(input.value) || 0));
            const row = input.closest(".mm2-row");
            const prow = input.closest(".mm2-prow");
            try {
                if (row) Actions.updateCartItemQty(row.dataset.id, v);
                else if (prow) Actions.updatePlanCraftCount(prow.dataset.hrid, Math.max(1, v));
            } catch (err) { console.warn("[mwi-mm] §10A 數量更新失敗:", err); }
            if (this._pendingRender) { this._pendingRender = false; this._renderCurrent(); }
        },
        /** 步進按鈕:點按 ±1,按住連發(400ms 後每 80ms 一次,2 秒後步長 ×10) */
        _onListPointerDown(e) {
            const btn = e.target.closest("[data-act]");
            if (!btn) return;
            const act = btn.dataset.act;
            if (!["dec", "inc", "pdec", "pinc"].includes(act)) return;
            e.preventDefault();
            const row = btn.closest(".mm2-row"), prow = btn.closest(".mm2-prow");
            const input = (row || prow)?.querySelector(".qv");
            if (!input) return;
            const dir = (act === "inc" || act === "pinc") ? 1 : -1;
            const isPlan = Boolean(prow);
            const floor = isPlan ? 1 : 0;
            let ticks = 0;
            const apply = () => {
                ticks++;
                const step = ticks > 25 ? 10 : 1;
                const v = Math.max(floor, (Math.round(Number(input.value) || 0)) + dir * step);
                input.value = String(v);
            };
            const commit = () => {
                this._holdCommit = null;
                this._holdLock = false;
                this._clearHold();
                const v = Math.max(floor, Math.round(Number(input.value) || 0));
                try {
                    if (row) Actions.updateCartItemQty(row.dataset.id, v);
                    else Actions.updatePlanCraftCount(prow.dataset.hrid, v);
                } catch (err) { console.warn("[mwi-mm] §10A 步進提交失敗:", err); }
                window.removeEventListener("pointerup", commit);
                window.removeEventListener("pointercancel", commit);
                window.removeEventListener("blur", commit);
            };
            // 前一次按住若沒等到 pointerup(被第三方吞掉/跨形態切換),先結算防計時器與監聽器疊加
            if (this._holdCommit) { try { this._holdCommit(); } catch (err) { /* ignore */ } }
            this._holdLock = true;                                       // 按住期間暫緩訂閱重繪
            apply();
            this._holdTimer = setTimeout(() => { this._holdIv = setInterval(apply, 80); }, 400);
            this._holdCommit = commit;
            window.addEventListener("pointerup", commit);
            window.addEventListener("pointercancel", commit);
            window.addEventListener("blur", commit);   // 視窗失焦收不到 pointerup,一併結算
        },
        _clearHold() {
            if (this._holdTimer) { clearTimeout(this._holdTimer); this._holdTimer = null; }
            if (this._holdIv) { clearInterval(this._holdIv); this._holdIv = null; }
        },
        _onFootClick(e) {
            const act = e.target.closest("[data-act]")?.dataset.act;
            if (!act) return;
            try {
                if (act === "clear") {
                    if (confirm(this._sx("清除全部未收藏的清單項?(收藏項保留)", "Clear all non-starred items?"))) Actions.clearNonStarred();
                } else if (act === "pclear") {
                    if (confirm(this._sx("清空全部製作計劃?", "Clear all crafting plans?"))) Actions.clearAllPlans();
                }
            } catch (err) { console.warn("[mwi-mm] §10A 操作失敗:", act, err); }
        },
        _selChange(e) {
            // 自由數字輸入（如 補料起算行動次數）—— change 在失焦/回車時觸發
            const numIn = e.target.closest("input[data-num]");
            if (numIn) {
                const key = numIn.dataset.num;
                if (key === "zScoreThreshold") {
                    const raw = String(numIn.value).trim();
                    let v = STATE.zScoreThreshold;                       // 空/非法 → 維持原值
                    if (raw !== "") {
                        const n = Number(raw);
                        if (Number.isFinite(n)) v = Math.max(1, Math.round(n));   // 0/負 → 下限1
                    }
                    STATE.zScoreThreshold = v;
                    numIn.value = String(v);                 // 回寫,聚焦提交時顯示也一致
                    saveToggles();
                    STATE.lastDataSignature = "";
                    try { refreshNow(); } catch (err) { /* ignore */ }
                }
                return;
            }
            const sel = e.target.closest("select[data-sel]");
            if (!sel) return;
            const key = sel.dataset.sel;
            if (key === "edgeZoneWidth") {
                STATE.edgeZoneWidth = Number(sel.value) || 0;
                saveToggles();
            } else if (key === "zScoreIndex") {
                STATE.zScoreIndex = Math.max(0, Math.min(Z_OPTIONS.length - 1, Number(sel.value) || 0));
                saveToggles();
            } else if (key === "zScoreThreshold") {
                STATE.zScoreThreshold = Math.max(1, Math.round(Number(sel.value) || 10));
                saveToggles();
            } else if (key === "guzzlingPouchLevel") {
                STATE.guzzlingPouchLevel = Math.max(-1, Math.min(20, Number(sel.value)));
                saveToggles();
            }
            // 影響缺料計算的設定改動後立即重算（否則要等看門狗下一拍）
            if (key === "zScoreIndex" || key === "zScoreThreshold" || key === "guzzlingPouchLevel") {
                STATE.lastDataSignature = "";
                try { refreshNow(); } catch (e) { /* ignore */ }
            }
        },
 
        /** 拖動會話通用:pointerup/pointercancel/blur 三徑收尾,重入先結算舊會話,監聽器絕不殘留疊加 */
        _beginDragSession(onMove, onEnd) {
            if (this._dragEndSession) { try { this._dragEndSession(); } catch (err) { /* ignore */ } }
            const end = () => {
                this._dragEndSession = null;
                window.removeEventListener("pointermove", onMove);
                window.removeEventListener("pointerup", end);
                window.removeEventListener("pointercancel", end);
                window.removeEventListener("blur", end);
                try { onEnd(); } catch (err) { /* ignore */ }
            };
            this._dragEndSession = end;
            window.addEventListener("pointermove", onMove);
            window.addEventListener("pointerup", end);
            window.addEventListener("pointercancel", end);
            window.addEventListener("blur", end);
        },
        /** 手柄通用:縱向拖動(handleY 兩形態共享並持久化)+ 點選回撥 */
        _attachHandleDrag(handleEl, onClick) {
            let dragMoved = false;
            handleEl.addEventListener("pointerdown", (e) => {
                dragMoved = false;
                const startY = e.clientY, startTop = this._ui.handleY;
                this._beginDragSession((ev) => {
                    const dy = ev.clientY - startY;
                    if (Math.abs(dy) > 4) dragMoved = true;
                    this._ui.handleY = Math.min(90, Math.max(5, startTop + (dy / window.innerHeight) * 100));
                    handleEl.style.top = this._ui.handleY + "%";
                }, () => { if (dragMoved) this._saveUI(); });
            });
            handleEl.addEventListener("click", () => { if (!dragMoved) onClick(); });
        },
 
        // ════════ 桌面 rail ════════
        _mountRail() {
            this._makeHost(`
<div class="mm2-hotline"><span class="mm2-hzchip">‹</span></div>
<button class="mm2-handle" title="${this._sx("市場伴侶(可拖動)", "Market Mate (drag)")}">${this.SVG.cart}<span class="mm2-badge zero"></span></button>
<aside class="mm2-rail" role="complementary">
  <div class="mm2-grip" title="${this._sx("拖動調整寬度", "Drag to resize")}"></div>
  <div class="mm2-head">
    <span class="t">${this._sx("市場伴侶", "Market Mate")}</span><span class="s"></span>
    <div class="hb">
      <button class="pin" title="${this._sx("固定(點外部不收起)", "Pin")}">${this.SVG.pin}</button>
      <button class="fold" title="${this._sx("收起 (Esc)", "Collapse (Esc)")}">»</button>
    </div>
  </div>
  ${this._contentHTML()}
</aside>`);
            this.els = {
                hotline: this.root.querySelector(".mm2-hotline"),
                handle: this.root.querySelector(".mm2-handle"),
                badge: this.root.querySelector(".mm2-badge"),
                rail: this.root.querySelector(".mm2-rail"),
                grip: this.root.querySelector(".mm2-grip"),
                headCount: this.root.querySelector(".mm2-head .s"),
                pin: this.root.querySelector(".mm2-head .pin"),
                fold: this.root.querySelector(".mm2-head .fold"),
                list: this.root.querySelector(".mm2-list"),
                foot: this.root.querySelector(".mm2-foot"),
                mbText: null
            };
            this._applyRailUI();
            this._renderCurrent();
            this._bindContent();
            this.root.addEventListener("change", (e) => this._selChange(e));
            this._bindRail();
        },
        _applyRailUI() {
            const u = this._ui;
            this.els.handle.style.top = u.handleY + "%";
            this.els.rail.style.width = u.railW + "px";
            this.els.rail.classList.toggle("open", u.open);
            this.els.handle.classList.toggle("hidden", u.open);
            this.els.pin.classList.toggle("on", u.pinned);
        },
        toggle() { this._ui.open ? this.close() : this.openRail(); },
        openRail() { if (this._form !== "rail") return; this._ui.open = true; this._applyRailUI(); },
        close() { if (this._form !== "rail") return; this._ui.open = false; this._applyRailUI(); },
        /** 跨形態開啟介面,可指定 Tab(舊抽屜刪除後的統一入口) */
        openUI(tab) {
            if (tab && ["cart", "plans", "quests", "set"].includes(tab)) this._tab = tab;
            if (this._form === "rail") { this._ui.open = true; this._applyRailUI(); }
            else if (this._form === "sheet") this._setDetent("half");
            try {
                this.root.querySelectorAll(".mm2-tabs button").forEach(x => x.classList.toggle("on", x.dataset.t === this._tab));
                this._renderCurrent();
            } catch (err) { /* ignore */ }
        },
        isOpenUI() { return this._form === "rail" ? this._ui.open : this._detent !== "mini"; },
        collapseUI() { if (this._form === "rail") this.close(); else if (this._form === "sheet") this._setDetent("mini"); },
        _bindRail() {
            this.els.fold.addEventListener("click", () => this.close());
            this.els.pin.addEventListener("click", () => { this._ui.pinned = !this._ui.pinned; this._applyRailUI(); this._saveUI(); });
            this._attachHandleDrag(this.els.handle, () => this.openRail());
            this.els.grip.addEventListener("pointerdown", (e) => {
                e.preventDefault();
                const startX = e.clientX, startW = this._ui.railW;
                this._beginDragSession((ev) => {
                    this._ui.railW = Math.min(560, Math.max(240, startW + (startX - ev.clientX)));
                    this.els.rail.style.width = this._ui.railW + "px";
                }, () => this._saveUI());
            });
            this._onDown = (e) => this._railPointerDown(e);
            this._onClickCap = (e) => {
                if (Date.now() >= this._suppressClickUntil) return;
                // 只吞掉邊緣熱區 pointerdown 衍生的那一次合成 click;
                // 自家 shadow host 內的點選(剛展開的側欄按鈕)一律放行,吞過一次即解除
                const path = e.composedPath ? e.composedPath() : [];
                if (this.host && path.includes(this.host)) return;
                this._suppressClickUntil = 0;
                e.stopPropagation(); e.preventDefault();
            };
            this._onMove = (e) => {
                const W = STATE.edgeZoneWidth;
                const on = !this._ui.open && W > 0 && e.clientX >= window.innerWidth - Math.max(W, 3);
                if (on) {                                              // 熱區頻寬度跟隨 edgeZoneWidth
                    const wpx = Math.max(W, 3) + "px";
                    if (this.els.hotline.style.width !== wpx) this.els.hotline.style.width = wpx;
                }
                this.els.hotline.classList.toggle("on", on);
            };
            this._onKey = (e) => { if (e.key === "Escape" && this._ui.open) this.close(); };
            document.addEventListener("pointerdown", this._onDown, true);
            document.addEventListener("click", this._onClickCap, true);
            document.addEventListener("pointermove", this._onMove, true);
            document.addEventListener("keydown", this._onKey, true);
        },
        _railPointerDown(e) {
            const path = e.composedPath ? e.composedPath() : [];
            if (this.host && path.includes(this.host)) return;
            const W = STATE.edgeZoneWidth;
            const inZone = W > 0 && e.clientX >= window.innerWidth - W;
            if (inZone && !this._isScrollbarHit(e)) {
                e.stopPropagation(); e.preventDefault();
                this._suppressClickUntil = Date.now() + 350;
                this.toggle();
                return;
            }
            if (this._ui.open && !this._ui.pinned) this.close();
        },
        _isScrollbarHit(e) {
            let el = e.target;
            for (let i = 0; i < 4 && el && el instanceof Element; i++, el = el.parentElement) {
                if (el.scrollHeight > el.clientHeight + 1) {
                    const rect = el.getBoundingClientRect();
                    if (el.offsetWidth - el.clientWidth >= 8) {
                        // 經典捲軸:佔佈局寬度,精確判定
                        const sbLeft = rect.left + el.clientLeft + el.clientWidth;
                        if (e.clientX >= sbLeft) return true;
                    } else if (e.clientX >= rect.right - 14) {
                        // overlay 捲軸(macOS/移動端):不佔佈局寬度,offsetWidth-clientWidth === 0,
                        // 以右緣 14px 內點選可滾動元素視為拖動捲軸,避免吞掉拖動
                        return true;
                    }
                }
            }
            return false;
        },
 
        // ════════ 移動 sheet ════════
        _mountSheet() {
            this._detent = "mini";
            this._makeHost(`
<button class="mm2-handle" title="${this._sx("市場伴侶(可拖動)", "Market Mate (drag)")}">${this.SVG.cart}<span class="mm2-badge zero"></span></button>
<section class="mm2-sheet" data-detent="mini" role="complementary">
  <div class="mm2-grab"><i></i></div>
  <div class="mm2-head">
    <span class="t">${this._sx("市場伴侶", "Market Mate")}</span><span class="s"></span>
    <div class="hb"><button class="down" title="${this._sx("收起", "Minimize")}">×</button></div>
  </div>
  ${this._contentHTML()}
</section>`);
            this.els = {
                handle: this.root.querySelector(".mm2-handle"),
                badge: this.root.querySelector(".mm2-badge"),
                sheet: this.root.querySelector(".mm2-sheet"),
                grab: this.root.querySelector(".mm2-grab"),
                down: this.root.querySelector(".mm2-head .down"),
                headCount: this.root.querySelector(".mm2-head .s"),
                list: this.root.querySelector(".mm2-list"),
                foot: this.root.querySelector(".mm2-foot"),
                mbText: null
            };
            this.els.handle.style.top = this._ui.handleY + "%";
            this._renderCurrent();
            this._bindContent();
            this.root.addEventListener("change", (e) => this._selChange(e));
            this._bindSheet();
        },
        _setDetent(d) {
            this._detent = d;
            if (!this.els.sheet) return;
            this.els.sheet.dataset.detent = d;
            if (this.els.handle) this.els.handle.classList.toggle("hidden", d !== "mini");
        },
        _bindSheet() {
            this._attachHandleDrag(this.els.handle, () => this._setDetent("half"));
            this.els.grab.addEventListener("click", () => this._setDetent(this._detent === "half" ? "full" : "half"));
            this.els.down.addEventListener("click", () => this._setDetent("mini"));
            this._onDown = (e) => {
                const path = e.composedPath ? e.composedPath() : [];
                if (this.host && path.includes(this.host)) return;
                if (this._detent !== "mini") this._setDetent("mini");
            };
            this._onKey = (e) => { if (e.key === "Escape" && this._detent !== "mini") this._setDetent("mini"); };
            document.addEventListener("pointerdown", this._onDown, true);
            document.addEventListener("keydown", this._onKey, true);
            // 鍵盤彈出(視口驟減)→ 收回手柄態,不與系統鍵盤搶底部
            if (window.visualViewport) {
                let base = window.visualViewport.height;
                this._vvHandler = () => {
                    const h = window.visualViewport.height;
                    if (h < base - 150 && this._detent !== "mini") this._setDetent("mini");
                    if (h > base) base = h;
                };
                window.visualViewport.addEventListener("resize", this._vvHandler);
            }
        },
        // ── 全域監聽清理 / 持久化 ────────────────────────────────────────────
        _removeGlobalListeners() {
            if (this._onDown) document.removeEventListener("pointerdown", this._onDown, true);
            if (this._onClickCap) document.removeEventListener("click", this._onClickCap, true);
            if (this._onMove) document.removeEventListener("pointermove", this._onMove, true);
            if (this._onKey) document.removeEventListener("keydown", this._onKey, true);
            if (this._vvHandler && window.visualViewport) window.visualViewport.removeEventListener("resize", this._vvHandler);
            if (this._rsHandler) window.removeEventListener("resize", this._rsHandler);
            this._onDown = this._onClickCap = this._onMove = this._onKey = this._vvHandler = this._rsHandler = null;
        },
        _loadUI() {
            try {
                const raw = localStorage.getItem(this.LS_KEY);
                if (!raw) return;
                const p = JSON.parse(raw);
                if (typeof p.handleY === "number" && p.handleY >= 5 && p.handleY <= 90) this._ui.handleY = p.handleY;
                if (typeof p.railW === "number" && p.railW >= 240 && p.railW <= 560) this._ui.railW = p.railW;
                if (this._ui.railW === 312) this._ui.railW = 340;   // 舊預設值一次性升級(自定義值保留)
                if (typeof p.pinned === "boolean") this._ui.pinned = p.pinned;
            } catch (err) { /* ignore */ }
        },
        _saveUI() {
            try {
                localStorage.setItem(this.LS_KEY, JSON.stringify({
                    handleY: this._ui.handleY, railW: this._ui.railW, pinned: this._ui.pinned
                }));
            } catch (err) { /* ignore */ }
        }
    };
 
 
 
    // ════════════════════════════════════════════════════════════════════════
    // §10 舊浮窗 UI —— 已物理刪除(FAB/抽屜/舊設定面板/舊計劃與
    //     任務浮窗/三套拖拽),功能由 §10A 新殼完整承接。
    //     舊位置/尺寸 localStorage 鍵不再讀取(未刪除,可自行清理):
    //     mwi_missing_cart_fab_pos_v1 / mwi_missing_cart_drawer_pos_v1 /
    //     mwi_missing_cart_drawer_size_v2 / mwi_crafting_plans_pos_v1。
    //     §13 樣式表中的舊選擇器成為死規則,無副作用,後續隨樣式重構清理。
    // ════════════════════════════════════════════════════════════════════════
 
    // ════════════════════════════════════════════════════════════════════════
    // §11 重新整理與守護 Guard
    //     refreshNow / scheduleRefresh / Observer×2 / 舊版 重掛看門狗
    // ════════════════════════════════════════════════════════════════════════
 
    // ── 重新整理邏輯 ──────────────────────────────────────────────────
 
    /**
     * 立即重新整理：檢測當前彈窗，提取缺料資料，更新 UI
     * ★ 增加強化面板重建冷卻保護，防止面板清空期間誤清資料
     */
    function refreshNow() {
        // 房屋彈窗為模態層級，優先檢測；關閉後自然回退到技能面板
        let modal = findActiveHousePanel();
        let data = null;
 
        if (modal) {
            // Housing 簽名快取:僅當簽名未變 且 摘要面板仍在 時跳過(面板可能被 React 重渲染抹掉)
            const hSig = getHousingSignature(modal);
            if (hSig && hSig === _lastHouseSignature && modal.querySelector(".mwi-mm-summary-panel")) {
                syncMarketLocator();
                return;
            }
            _lastHouseSignature = hSig;
            try {
                data = extractHouseRequirements(modal);
            } catch (e) {
                console.error("[mwi-mm] extractHouseRequirements failed:", e);
                return;
            }
        } else {
            _lastHouseSignature = null;
            // findActiveModal 已去掉 regularComponent 門禁,統一覆蓋 製作/鍊金/強化;
            //   語義由 extractRequirements 內 resolveActionContext(Fiber) 按 actionDetail.function 分派。
            modal = findActiveModal();
            if (modal) {
                try {
                    data = extractRequirements(modal);
                } catch (e) {
                    console.error("[mwi-mm] extractRequirements failed:", e);
                    return;
                }
            }
        }
 
        // ★ 修復 B: 強化面板重建冷卻保護
        // 遊戲在每次強化完成後會完全拆毀面板 DOM 並在 3-5 秒後重建。
        // 空白期間如果清除資料，會導致摘要面板/計劃次數輸入框丟失、badges 閃爍。
        // 策略: 面板從"有資料"變為"空/不存在"時進入 6 秒冷卻期，保持舊資料不清除。
        const now = Date.now();
        const dataIsEmpty = !modal || !data || (data.requirements.length === 0 && !data.upgrade);
        const hadData = STATE.currentData && (STATE.currentData.requirements.length > 0 || STATE.currentData.upgrade);
 
        if (dataIsEmpty && hadData) {
            // 面板剛變空 — 設定冷卻期
            if (!STATE.enhCooldownUntil || STATE.enhCooldownUntil < now) {
                STATE.enhCooldownUntil = now + 6000;
                STATE.lastNonEmptyModal = STATE.currentModal;
                _log.note("refresh", "面板變空,入6s冷卻(保留舊UI)");
            }
        }
 
        // 在冷卻期內，面板為空時跳過重新整理，保持舊資料
        if (dataIsEmpty && STATE.enhCooldownUntil && now < STATE.enhCooldownUntil) {
            return;
        }
 
        // 冷卻期已過或面板已恢復 — 重置冷卻狀態
        if (!dataIsEmpty) {
            STATE.enhCooldownUntil = 0;
            STATE.lastNonEmptyModal = null;
        }
 
        // 彈窗確實已關閉（冷卻期也過了）→ 清理狀態
        if (!modal) {
            // 僅在確有注入殘留時才執行清理與記錄;無面板期間的空轉直接返回(否則市場
            // 瀏覽等高頻 mutation 會讓本路徑反覆執行並刷出大量同義 log)。
            if (STATE.currentModal || STATE.currentData) {
                _log.note("refresh", "面板離開,清理注入UI");
                if (STATE.currentModal) clearInlineBadges(STATE.currentModal);
                STATE.currentModal = null;
                STATE.currentData = null;
                STATE.lastDataSignature = "";
            }
            STATE.enhCooldownUntil = 0;
            syncMarketLocator();
            return;
        }
 
        // 簽名未變 + 徽章已存在 → 跳過重繪
        const signature = buildDataSignature(data);
        const sameModal = STATE.currentModal === modal;
        if (sameModal && signature === STATE.lastDataSignature) {
            // 跳繪條件:簽名未變 且 徽章逐行完整 且 摘要面板在;任一缺失 → 補繪
            const badgesOk = _badgesIntact(modal, data);
            const panelOk = !!modal.querySelector(".mwi-mm-summary-panel");
            if (badgesOk && panelOk) {
                syncMarketLocator();
                return;
            }
            _log.note("refresh", "簽名同但完整性破缺,補繪 badges=" + badgesOk + (badgesOk ? "" : "(" + _badgesFailReason + ")") + " panel=" + panelOk);
        }
 
        // 切換彈窗時先清舊徽章
        if (STATE.currentModal && STATE.currentModal !== modal) { _log.note("refresh", "面板切換,全量重繪"); clearInlineBadges(STATE.currentModal); }
 
        STATE.currentModal = modal;
        STATE.currentData = data;
        STATE.lastDataSignature = signature;
 
        _log.note("refresh", "重繪(" + ((data.requirements && data.requirements.length) || 0) + "行)");
        let renderFailed = false;
        try {
            renderInlineBadges(modal, data);
        } catch (e) {
            renderFailed = true;
            console.error("[mwi-mm] renderInlineBadges failed:", e, { modal, reqCount: data.requirements?.length, hasInputEls: data.requirements?.some(r => r.inputEl) });
        }
        try {
            renderSummaryPanel(modal, data);
        } catch (e) {
            renderFailed = true;
            console.error("[mwi-mm] renderSummaryPanel failed:", e);
        }
        try {
            // 渲染展開的子配方樹
            const summaryPanel = modal.querySelector(".mwi-mm-summary-panel");
            if (summaryPanel && data._dataLayerUsed) renderChainSubRows(summaryPanel, data);
        } catch (e) {
            console.error("[mwi-mm] renderChainSubRows failed:", e);
        }
 
        // 渲染失敗時清除簽名快取，確保下次重新整理會重試渲染
        if (renderFailed) STATE.lastDataSignature = "";
 
        if (data.totalMissingTypes > 0) setAction(t("action_calculated", data.totalMissingTypes, formatQty(data.totalMissingQty)));
        else setAction(t("action_sufficient"));
        syncMarketLocator();
    }
 
    /** 延遲重新整理（自動去抖） */
    // 去抖封頂(maxWait):持續不斷的 mutation 會一直重置去抖定時器,導致 refreshNow 永不執行(餓死)。
    //   記錄本串去抖首次排程時刻,距今 ≥ REFRESH_MAXWAIT 仍被推遲則立即執行一拍,保證重新整理不被餓死。
    const REFRESH_MAXWAIT = 250;
    let _refreshFirstReqAt = 0;     // 本串去抖首次排程時刻
    let _refreshCoalesced = 0;      // 本串去抖定時器被重置的次數
 
    function _doRefreshNow() {
        STATE.refreshTimer = null;
        const coalesced = _refreshCoalesced;
        _refreshCoalesced = 0;
        _refreshFirstReqAt = 0;
        // 合併次數異常高 → 幾乎可斷定遭遇 mutation 風暴(常見於與外部外掛互相注入),記錄以便定位
        if (coalesced >= 25) _log.note("refresh", "去抖合併 ×" + coalesced + " 觸頂強制執行(疑似 mutation 風暴)");
        try {
            refreshNow();
        } catch (e) {
            console.error("[mwi-mm] refreshNow() uncaught error:", e);
        }
    }
 
    /** 延遲重新整理（自動去抖，帶 maxWait 封頂以防持續 mutation 把重新整理餓死） */
    function scheduleRefresh(delay = 120) {
        // ★ 自愈 — 若主 observer 當前所掛節點已脫離文件，立即重掛(改掛 body 後此分支基本不觸發，保留作保底)。
        if (STATE.gameRootObserved && !STATE.gameRootObserved.isConnected) ensureMainObserverAttached();
        const now = Date.now();
        if (STATE.refreshTimer) {
            clearTimeout(STATE.refreshTimer);
            _refreshCoalesced++;
            // maxWait 封頂:本串去抖已持續 ≥ REFRESH_MAXWAIT 仍未落地 → 立刻執行,打斷餓死。
            if (now - _refreshFirstReqAt >= REFRESH_MAXWAIT) {
                _doRefreshNow();
                return;
            }
        } else {
            _refreshFirstReqAt = now;
        }
        STATE.refreshTimer = setTimeout(_doRefreshNow, delay);
    }
 
    // ── Observer ──────────────────────────────────────────────────
    //   監聽 DOM 變化觸發自動重新整理，以及庫存同步。
 
    /** 確保主 observer 掛在 document.body 上。冪等:已掛返回 false,發生(重)掛返回 true。
     *  監聽 body 而非 GamePage 容器,以覆蓋渲染在 GamePage 之外的市場/模態 portal;body 不會被 React
     *  替換,無需「死節點重掛」自愈。放寬範圍的額外觸發由 isPluginNode 過濾 + 去抖 + 簽名早退吸收。 */
    function ensureMainObserverAttached() {
        if (!STATE.observer) return false;
        if (STATE.gameRootObserved === document.body && document.body.isConnected) return false;
        STATE.observer.disconnect();
        STATE.gameRootObserved = document.body;
        STATE.observer.observe(document.body, { childList: true, subtree: true });
        return true;
    }
 
    /** 設定全域 MutationObserver，過濾外掛自身的 DOM 變更 */
    function setupObservers() {
        if (STATE.observer) STATE.observer.disconnect();
 
        STATE.observer = new MutationObserver((mutations) => {
            try {
            if (isObserverSuppressed()) return;
 
            /** 判斷節點是否屬於本外掛（避免自觸發） */
            const isPluginNode = (node) => {
                if (!(node instanceof Element)) return false;
                const nodeId = typeof node.id === "string" ? node.id : (node.id?.baseVal || "");
                if (nodeId && nodeId.startsWith("mwi-mm-")) return true;
                if (node.classList?.length && [...node.classList].some((cls) => cls.startsWith("mwi-mm-"))) return true;
                if (node.closest?.(".mwi-mm-summary-panel")
                    || node.closest?.(".mwi-mm-toast")) return true;
                return false;
            };
 
            /** 聊天區變更與材料計算無關 —— 不過濾的話,持續聊天會把重新整理驅動成每 250ms 一次的常態重算 */
            const isChatNode = (node) =>
                Boolean(node.closest?.('[class*="Chat_"], [class*="ChatMessage_"], [class*="ChatHistory_"]'));

            const hasExternalMutation = mutations.some((m) => {
                const target = m.target;
                if (!(target instanceof Element)) return false;
                if (isPluginNode(target)) return false;
                if (isChatNode(target)) return false;
                if (m.type === "childList") {
                    const changed = [...m.addedNodes, ...m.removedNodes];
                    if (changed.length && changed.every((x) => isPluginNode(x))) return false;
                }
                return true;
            });
 
            if (hasExternalMutation) scheduleRefresh(90);
            } catch (e) {
                console.error("[mwi-mm] MutationObserver callback error:", e);
                scheduleRefresh(200);
            }
        });
 
        // ★ 初始掛到 document.body 作為保底（此時 GamePage 可能還沒渲染）；
        //   去掉 characterData 監聽 — 純文本變化（如倒計時數字）不需要觸發材料重新整理。
        //   init() 在 waitForGameReady() 之後會呼叫 ensureMainObserverAttached() 把監聽範圍收窄到 GamePage，
        //   該函式後續在重連 / 標籤頁可見時還會自動重掛，避免 React 重掛容器後監聽失效（舊版）。
        STATE.observer.observe(document.body, { childList: true, subtree: true });
 
        // 監聽製作數量輸入框的使用者輸入
        document.addEventListener("input", (event) => {
            const el = event.target;
            if (!(el instanceof Element) || !el.matches('input[class*="Input_input"]')) return;
            const c = el.closest('[class*="SkillActionDetail_maxActionCountInput"]');
            if (!c) return;
            if (isVisible(c)) scheduleRefresh(30);
        }, true);
 
        // 監聽技能面板 / 房屋面板的點選
        document.addEventListener("click", (event) => {
            const el = event.target;
            if (!(el instanceof Element)) return;
            if (el.closest(SEL.detailRoot)
                || el.closest('[class*="SkillAction_skillAction"]')
                || el.closest(SEL.houseRoot)
                || el.closest('[class*="HousePanel_"]')) {
                scheduleRefresh(120);
            }
        }, true);
 
        // ★ 標籤頁重新可見時常伴隨 WS 重連 / React 重掛 → 確保主 observer 仍掛在活動節點上。
        //   ensureMainObserverAttached 僅在節點確實變化時返回 true，穩態下切換標籤頁幾乎零開銷。
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible" && ensureMainObserverAttached()) scheduleRefresh(150);
        });
 
        setupInventorySyncObservers();
    }
 
    // ── 庫存同步 Observer ─────────────────────────────────────────
    let _notifObserver = null;
    let _invPanelObserver = null;
    let _syncObserverRetryTimer = null;
 
    function setupInventorySyncObservers() {
        _tryAttachSyncObservers();
    }
 
    /** 嘗試掛載通知區 / 背包面板的 MutationObserver，失敗時自動重試 */
    function _tryAttachSyncObservers() {
        let attached = 0;
 
        // 通知區域（購買成功等提示）
        if (!_notifObserver) {
            const el = document.querySelector('[class*="GamePage_notifications"]');
            if (el) {
                _notifObserver = new MutationObserver(() => triggerInventorySync(60));
                _notifObserver.observe(el, { childList: true, subtree: true });
                attached++;
            }
        } else { attached++; }
 
        // 背包面板
        if (!_invPanelObserver) {
            const el = document.querySelector('[class*="Inventory_inventory"]');
            if (el) {
                _invPanelObserver = new MutationObserver(() => triggerInventorySync(50));
                _invPanelObserver.observe(el, { childList: true, subtree: true, characterData: true });
                attached++;
            }
        } else { attached++; }
 
        // 兩個 observer 未全部掛載 → 設定重試
        if (attached < 2 && !_syncObserverRetryTimer) {
            let retries = 0;
            _syncObserverRetryTimer = setInterval(() => {
                retries++;
                _tryAttachSyncObservers();
                if ((_notifObserver && _invPanelObserver) || retries > 30) {
                    clearInterval(_syncObserverRetryTimer);
                    _syncObserverRetryTimer = null;
                }
            }, 1000);
        }
    }
 
    /** ★ 斷線重連 / 重登（WS 推送 init_character_data）後，React 會重掛 GamePage、
     *  通知區與背包面板，使所有一次性掛載的監聽器失效。此函式把它們重新掛到新節點並強制重繪一次，
     *  讓被 React 清掉的徽章自動恢復，無需重新整理頁面。函式冪等，可安全重複呼叫。 */
    function _healObserversAfterRemount() {
        // 主 observer（徽章引擎）重掛到當前 GamePage 節點
        ensureMainObserverAttached();
        // 庫存同步 observer 同樣是一次性掛載，節點被替換後會失效 → 重置後重掛
        try { if (_notifObserver) _notifObserver.disconnect(); } catch (e) { /* ignore */ }
        try { if (_invPanelObserver) _invPanelObserver.disconnect(); } catch (e) { /* ignore */ }
        _notifObserver = null;
        _invPanelObserver = null;
        if (_syncObserverRetryTimer) { clearInterval(_syncObserverRetryTimer); _syncObserverRetryTimer = null; }
        _tryAttachSyncObservers();
        // 把被 React 清掉的徽章重新注入
        scheduleRefresh(120);
    }
 
    // ── ★ 重掛看門狗（不依賴 observer / WS / 可見性的最終兜底 + 控制台診斷） ──────────
    //   背景與根因：徽章與「加入購物清單」按鈕是注入在遊戲 React 子樹（SkillActionDetail / HousePanel）內部的，
    //   React 一旦在「資料不變」時重渲染/重掛該子樹（背包更新、動作進度跳動、旁元件重渲染、斷線重連、
    //   或其它外掛觸發的協調崩潰等）就會把它們抹掉。而本外掛的重注入由「遊戲資料簽名」快取把守，
    //   資料沒變時不會重繪 → UI 被抹掉後不恢復。疊加 把主 observer 收窄到會被 React 換掉的 GamePage
    //   容器，observer 一旦盯上死節點便徹底靜默，必須重新整理頁面才恢復。
    //   看門狗用一個低頻輪詢徹底繞開上述所有訊號：每 1s 主動把 observer 重新掛到當前 GamePage 容器，
    //   並在「面板開著、但我們的摘要面板缺失」時強制補註入，同時把這一事件顯式打到控制台（而非靜默）。
    //   開銷極小（穩態下每輪僅幾次只讀 querySelector）。
    let _watchdogTimer = null;
    let _wdTicks = 0;             // 心跳計數(診斷 log:每 60 拍記 1 條,證明看門狗活著)
    let _uiLossEvents = 0;       // 累計「UI 丟失」事件數（用於讓使用者感知頻率）
    let _consecutiveLoss = 0;    // 連續多少個 tick 仍未恢復（用於區分「正常被抹除→補註入」與「補註入失敗」）
    let _wdLastMarketVisible = false;   // 上一拍市場面板是否可見(檢測開/關翻轉用)
 
    /** 把 UI 丟失/補註入失敗顯式記錄到控制台，附帶定位資訊 */
    function _logUILoss(modal, reattached, reason) {
        const lossDesc = reason || "「加入購物清單」摘要面板缺失，";
        const hasBadge = !!modal.querySelector("[data-mm-badge], .mwi-mm-upgrade-inline");
        const observerAlive = !!(STATE.gameRootObserved && STATE.gameRootObserved.isConnected);
        let modalCls = "modal";
        try { modalCls = (String(modal.className || "").match(/(SkillActionDetail|HousePanel)\w*/) || [])[0] || "modal"; } catch (e) { /* ignore */ }
        if (_consecutiveLoss <= 1) {
            _uiLossEvents++;
            console.warn(
                "[mwi-mm] ⚠ 注入 UI 丟失 #" + _uiLossEvents + "：遊戲面板（" + modalCls + "）仍在，但" + lossDesc +
                "判定為遊戲 React 重渲染/重掛或第三方外掛抹除。正在自動補註入。" +
                " [徽章殘留=" + hasBadge + " | observer容器存活=" + observerAlive + " | 本輪重掛observer=" + reattached + "]"
            );
        } else {
            // 已經補註入過、隔了 ≥1 個 tick（約 N 秒）仍缺失 → 重注入本身可能失敗了，升級為 error
            console.error(
                "[mwi-mm] ✗ 補註入後注入 UI 仍缺失：已連續檢測約 " + _consecutiveLoss + "s（" + lossDesc.replace(/，$/, "") + "）。重注入可能失敗，" +
                "請把本條及上方相關報錯（如 renderSummaryPanel/extractRequirements failed）反饋給作者。" +
                " [面板=" + modalCls + " | 徽章殘留=" + hasBadge + " | observer容器存活=" + observerAlive + "]"
            );
        }
    }
 
    function _watchdogTick() {
        _wdTicks++;
        if (_wdTicks % 60 === 0) _log.note("wd", "心跳 ×" + _wdTicks);
        try {
            // 1) 確保主 observer 仍掛在 body 上(冪等)
            const reattached = ensureMainObserverAttached();
 
            // 1.5) 市場彈窗在 GamePage 外的 portal 渲染,主 observer 看不到其開/關,也看不到市場內購買
            //      導致的庫存(WS)變化 → 返回後徽章會停在舊值。檢測市場面板可見性翻轉,開/關即強刷一拍。
            const marketVisible = !!findVisibleMarketplacePanel();
            const marketChanged = marketVisible !== _wdLastMarketVisible;
            _wdLastMarketVisible = marketVisible;
            if (marketChanged) {
                _log.note("wd", "市場面板" + (marketVisible ? "開啟" : "關閉") + ",強制重新整理(庫存/徽章可能已變)");
                STATE.lastDataSignature = ""; _lastHouseSignature = "";
                scheduleRefresh(60);
                return;
            }
 
            // 2) 強化重建冷卻期內，面板本就該是空的（遊戲在重建），交給 refreshNow 的冷卻邏輯，不在此干預
            if (STATE.enhCooldownUntil && Date.now() < STATE.enhCooldownUntil) { _consecutiveLoss = 0; return; }
 
            // 2.5) 若已有一次重新整理在佇列中（observer / 點選 / 上一拍看門狗排的），說明快路徑正在處理，
            //      本拍讓路、不重複動作也不誤報；待其落地後下一拍再據實判斷。
            if (STATE.refreshTimer) return;
 
            // 3) 面板開著但「摘要面板」缺失 → 強制補註入。摘要面板是「我們是否已注入到此面板」的權威標記，
            //    findActiveModal/findActiveHousePanel 僅在確有材料區時才返回非空，故此判定可靠、不會誤報。
            const modal = findActiveHousePanel() || findActiveModal();
            if (!modal) {
                _consecutiveLoss = 0;
                // 頁面有可見詳情卻未被任何通道接住 → 記錄被哪道門拒(同文案自動摺疊 ×N)
                for (const node of document.querySelectorAll(SEL.detailRoot)) {
                    if (!isVisible(node)) continue;
                    let why;
                    if (_inHiddenMainContainer(node)) why = "隱藏容器";
                    else if (!node.querySelector(SEL.requirements)) why = "無材料區";
                    else why = "有材料區卻未返回(異常,請回報)";   // 已無 regularComponent 門禁,正常不應到此
                    _log.note("wd", "存在可見詳情但被拒:" + why);
                    break;
                }
                return;
            }
            const hasPanel = !!modal.querySelector(".mwi-mm-summary-panel");
 
            // React 會複用 SkillActionDetail 容器,換配方後容器仍是同一元素而我們的注入還是舊配方的;
            // 用 Fiber 讀當前面板真實 actionHrid 與已渲染的比對,不一致即判定過期 → 強制重繪(免疫 observer)。
            let recipeStale = false;
            try {
                const liveHrid = (resolveActionContext(modal) || {}).actionHrid || null;
                const renderedHrid = (STATE.currentData && STATE.currentData._recipeHrid) || null;
                if (liveHrid && renderedHrid && liveHrid !== renderedHrid) recipeStale = true;
            } catch (e) { /* Fiber 讀取失敗時不阻斷後續判定 */ }
 
            // 徽章保險:摘要面板在,但徽章數量少於上次提取的應有數量(非金幣、有掛點的行) → 判定被部分抹除,強制補繪
            let badgeLossReason = null;
            if (hasPanel && STATE.currentData && STATE.currentModal === modal && !recipeStale) {
                try {
                    const expected = (STATE.currentData.requirements || []).filter((r) => r.inputEl && !(r.itemId && isCoinItem(r.itemId))).length;
                    if (expected > 0) {
                        const actual = modal.querySelectorAll("[data-mm-badge]").length;
                        if (actual < expected) badgeLossReason = "缺料徽章短缺(應有 " + expected + " 枚,實存 " + actual + " 枚)，";
                    }
                } catch (e) { /* ignore */ }
            }
 
            // UI 完好的充要條件:摘要面板在 且 面板身份一致 且 配方未漂移 且 無徽章缺失;任一不滿足即強制重繪
            if (hasPanel && STATE.currentModal === modal && !recipeStale && !badgeLossReason) { _consecutiveLoss = 0; return; }
 
            // —— 檢測到 UI 丟失/過期 ——
            _consecutiveLoss++;
            _logUILoss(modal, reattached, recipeStale ? "配方漂移(容器複用,徽章過期)" : (badgeLossReason || undefined));
            // 同時清掉技能 & 房屋兩套簽名快取，確保 refreshNow 這次一定重繪，而非命中任一去重/簽名早退
            STATE.lastDataSignature = "";
            _lastHouseSignature = "";
            scheduleRefresh(60);
        } catch (e) {
            console.error("[mwi-mm] watchdog tick error:", e);
        }
    }
    function startRemountWatchdog() {
        if (_watchdogTimer) return;            // 冪等：避免重複 setInterval 洩漏
        _watchdogTimer = setInterval(_watchdogTick, 1000);
        // 長會話保險:後臺標籤頁定時器被節流,掛後臺期間被抹的注入 UI 無人補;
        // 切回可見的瞬間清兩套簽名快取並強制重新整理一拍。
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState !== "visible") return;
            _log.note("vis", "切回可見,清簽名強刷");
            try {
                STATE.lastDataSignature = "";
                _lastHouseSignature = null;
                scheduleRefresh(80);
            } catch (e) { /* ignore */ }
        });
    }
 
 
    // ════════════════════════════════════════════════════════════════════════
    // §12 周邊功能 Periph
    //     _shortcutManager / _marketPrefill / _purchaseNav(採購導航,封存區)
    // ════════════════════════════════════════════════════════════════════════
 
    // ── Next item 快捷鍵管理器 ───────────────────────────
    //   作用域嚴格限定：只有當「物品購買完成且購物車還有下一個待購物品」事件
    //   觸發後（即 _onItemFulfilled(nextItem) 入口被命中且
    //   nextItem 非空），快捷鍵才被「裝填」（armed）；按下快捷鍵即等同於點選
    //   橫幅上的「Next item ▶」按鈕。bar 淡出後仍然有效，直到下列任一情況：
    //     1) 使用者按下快捷鍵完成跳轉；
    //     2) 使用者點選橫幅按鈕完成跳轉；
    //     3) 新一輪購齊事件觸發（重新裝填新目標）；
    //     4) 裝填的目標物品已被外部移除/清空（觸發時校驗，回退安全）；
    //     5) 「全部購齊」事件（無下一項）→ 卸下。
    const _shortcutManager = {
        _armedNextItemId: null,    // 當前可觸發的下一個物品 itemId（normalized）
        _captureMode: false,       // 是否處於錄製快捷鍵狀態(錄製期抑制全域觸發)
        _globalKeyHandler: null,   // 觸發模式下的全域 keydown 監聽器
        _inited: false,
 
        init() {
            if (this._inited) return;
            this._inited = true;
            // 自愈註冊體系 —— 本監聽器是全腳本唯一在 document-start 註冊的
            //   window 事件監聽器;頁面啟動期的文件重寫(document.open 等)會按規範
            //   清空 window/document 全部監聽器,早註冊的死、晚註冊的活(__key 實測:
            //   探針收鍵而管理器收鍵 ✗,與該機制完全吻合)。對策:冪等重掛 ×4 時機
            //   (立即 / DOMContentLoaded / 每次購齊裝填 / 20s 週期),window+document
            //   雙層冗餘,事件打戳去重。語義與舊版 逐位元組等價,只是註冊不死。
            this._ensureListener();
            try { document.addEventListener("DOMContentLoaded", () => this._ensureListener(), { once: true }); } catch (err) { /* ignore */ }
            try { this._repinTimer = setInterval(() => this._ensureListener(), 20000); } catch (err) { /* ignore */ }
        },
 
        /** 冪等重掛(removeEventListener 同引用不存在時為無害空操作) */
        _repinCount: 0,
        _ensureListener() {
            try {
                if (this._captureMode) return;   // 錄製期間不重掛:避免觸發監聽被追加到 onKey 之後,錄完同一事件又命中觸發
                if (!this._globalKeyHandler) this._globalKeyHandler = (e) => this._onGlobalKey(e);
                window.removeEventListener("keydown", this._globalKeyHandler, true);
                window.addEventListener("keydown", this._globalKeyHandler, true);
                if (!this._docKeyHandler) this._docKeyHandler = (e) => this._onGlobalKey(e);
                document.removeEventListener("keydown", this._docKeyHandler, true);
                document.addEventListener("keydown", this._docKeyHandler, true);
                this._repinCount++;
            } catch (err) { /* ignore */ }
        },
 
        /** 裝填快捷鍵目標（購齊事件入口呼叫） */
        arm(itemId) {
            this._ensureListener();   // 裝填即重掛 —— 確保按鍵將至的時刻監聽器必在
            const id = itemId ? normalizeCartItemId(itemId) : "";
            this._armedNextItemId = id || null;
            _log.note("key", "裝填 " + (id || "(空)"));
        },
 
        /** 卸下快捷鍵 */
        disarm() {
            this._armedNextItemId = null;
        },
 
        /** 全域 keydown：觸發已裝填的快捷鍵 */
        _onGlobalKey(e) {
            this._lastKeySeenAt = Date.now();   // 心跳戳,__key 據此證明本監聽器收到了按鍵
            if (e.__mwiMMKeySeen) return;       // 雙層冗餘去重,同一事件只處理一次
            try { e.__mwiMMKeySeen = true; } catch (err) { /* ignore */ }
            if (this._captureMode) return; // 捕獲模式由獨立 handler 處理
            if (!STATE.nextItemShortcut) return;
            if (!this._armedNextItemId) return;
 
            // 焦點在輸入框/編輯器內 → 讓遊戲聊天等正常工作，不搶熱鍵
            const ae = document.activeElement;
            if (ae && (
                ae.tagName === "INPUT" ||
                ae.tagName === "TEXTAREA" ||
                ae.tagName === "SELECT" ||
                ae.isContentEditable
            )) return;
 
            if (!this._matches(e, STATE.nextItemShortcut)) return;
            e.preventDefault();
            e.stopPropagation();
            this._fireNextItem();
        },
 
        /** 等同於點選橫幅上的 "Next item ▶" 按鈕 */
        _fireNextItem() {
            const id = this._armedNextItemId;
            if (!id) return;
 
            // 校驗：裝填的物品仍在購物車且還需購買
            // 舊版此處靜默 disarm —— 裝填目標在「裝填→按鍵」間隙被購齊/移除時,
            //        快捷鍵就此啞火且無任何痕跡(實測 __key 五門全過卻不跳的成因候選)。
            //        現改為:點亮日誌 + 就地重選下一個待購物品自愈改跳。
            const row = STATE.cart.get(id);
            if (!row || row.quantity <= 0) {
                let fallback = null;
                try {
                    fallback = _purchaseNav._getCartItemsForNav().find(x => normalizeCartItemId(x.itemId) !== id) || null;
                } catch (e) { /* ignore */ }
                if (fallback) {
                    const fbId = normalizeCartItemId(fallback.itemId);
                    console.info("[mwi-mm] 快捷鍵:裝填目標已過期(" + id + "),自愈改跳 " + fbId);
                    // fire-once 語義(與正常路徑一致):跳轉後由尾部統一 disarm,下次購齊事件重新裝填
                    try { openMarketplaceForItem(fbId); } catch (e) { console.warn("[mwi-mm] 快捷鍵跳轉失敗:", e); }
                } else {
                    console.info("[mwi-mm] 快捷鍵:裝填目標已過期(" + id + ")且無其他待購物品,解除安裝");
                    this.disarm();
                    return;
                }
            } else {
                // 跳轉到下一個物品市場(失敗不再靜默吞掉)
                try { openMarketplaceForItem(id); } catch (e) { console.warn("[mwi-mm] 快捷鍵跳轉失敗:", e); }
            }
 
            this.disarm();
        },
 
        /** 進入捕獲模式 */
        /** 把快捷鍵格式化為可讀字串 */
        format(s) {
            if (!s || !s.code) return "";
            const parts = [];
            if (s.ctrl) parts.push("Ctrl");
            if (s.shift) parts.push("Shift");
            if (s.alt) parts.push("Alt");
            if (s.meta) parts.push("Meta");
            parts.push(s.display || s.code);
            return parts.join("+");
        },
 
        /** 比較 keydown 事件是否匹配某個快捷鍵定義 */
        _matches(e, s) {
            if (!s) return false;
            return e.code === s.code
                && e.ctrlKey === !!s.ctrl
                && e.shiftKey === !!s.shift
                && e.altKey === !!s.alt
                && e.metaKey === !!s.meta;
        },
 
        /** 統一錄製入口(供新殼呼叫,替代 在 §10A 內重寫的簡化錄製器)。
         *  版丟了 舊版的三件錄製語義,本方法逐一找回:
         *  ① Space/方向鍵的友好顯示名(舊版 " ".toUpperCase() 仍是空格,按鈕與橫幅提示顯示空白);
         *  ② 忽略單獨按下的修飾鍵(舊版裸按 Ctrl 即被錄製);
         *  ③ 錄製期間置 _captureMode 抑制全域觸發(舊版重錄時會邊錄邊跳市場)。
         *  Escape 取消;完成或取消後回撥 onDone(shortcut|null)。 */
        captureOnce(onDone) {
            if (this._captureMode) return;
            this._captureMode = true;
            const finish = (shortcut) => {
                this._captureMode = false;
                window.removeEventListener("keydown", onKey, true);
                window.removeEventListener("pointerdown", onCancel, true);
                window.removeEventListener("blur", onCancel);
                try { if (typeof onDone === "function") onDone(shortcut); } catch (err) { /* ignore */ }
            };
            // 點選別處 / 視窗失焦 = 放棄錄製 —— 保證監聽器絕不因使用者中途離開而永久殘留
            const onCancel = () => finish(null);
            const onKey = (e) => {
                if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); finish(null); return; }
                if (/^(Control|Shift|Alt|Meta|OS)/.test(e.code)) return;   // 等待實義鍵
                e.preventDefault(); e.stopImmediatePropagation();
                let displayName;
                if (e.code === "Space") displayName = "Space";
                else if (e.code.startsWith("Arrow")) displayName = e.code.slice(5);
                else if (e.key && e.key.length === 1 && e.key.trim()) displayName = e.key.toUpperCase();
                else displayName = e.key || e.code;
                const shortcut = {
                    code: e.code, display: displayName,
                    ctrl: !!e.ctrlKey, shift: !!e.shiftKey, alt: !!e.altKey, meta: !!e.metaKey
                };
                STATE.nextItemShortcut = shortcut;
                saveToggles();
                showToast(t("toast_shortcut_set", _shortcutManager.format(shortcut)), "success");
                try { refreshBannerShortcutHint(); } catch (err) { /* ignore */ }   // 同步屏上橫幅的快捷鍵提示
                finish(shortcut);
            };
            // window 捕獲階段,與觸發監聽同層;_captureMode 抑制觸發,確保錄製獨佔
            window.addEventListener("keydown", onKey, true);
            window.addEventListener("pointerdown", onCancel, true);
            window.addEventListener("blur", onCancel);
        }
    };
 
    function refreshBannerShortcutHint() {
        document.querySelectorAll(".mwi-mm-purchase-nav .mwi-mm-nav-shortcut-hint").forEach(hint => {
            const s = STATE.nextItemShortcut;
            if (s) {
                hint.classList.remove("is-unset");
                hint.textContent = "⌨ " + _shortcutManager.format(s);
                hint.title = t("shortcut_hint_set_title");
            } else {
                hint.classList.add("is-unset");
                hint.textContent = "⌨ " + t("shortcut_hint_unset");
                hint.title = t("shortcut_hint_unset_title");
            }
        });
    }
 
    /** 渲染橫幅快捷鍵提示的 HTML 片段 */
    function _buildShortcutHintHtml() {
        const s = STATE.nextItemShortcut;
        if (s) {
            return `<span class="mwi-mm-nav-shortcut-hint" data-act="open-shortcut-settings" title="${escapeHtml(t("shortcut_hint_set_title"))}">⌨ ${escapeHtml(_shortcutManager.format(s))}</span>`;
        } else {
            return `<span class="mwi-mm-nav-shortcut-hint is-unset" data-act="open-shortcut-settings" title="${escapeHtml(t("shortcut_hint_unset_title"))}">⌨ ${escapeHtml(t("shortcut_hint_unset"))}</span>`;
        }
    }
 
    /** 橫幅上點選「快捷鍵提示」時：開啟抽屜 + 展開設定 + 滾到對應行 */
    function _openShortcutSettings() {
        try {
            _newShell.openUI("set");   // 開啟新殼設定 Tab(快捷鍵錄製行在其中)
        } catch (e) { /* ignore */ }
    }
 
    // ── 市場預填數量模組 ──────────────────────────────────
    const _marketPrefill = {
        _observer: null,
        _prefillDone: new WeakSet(),
 
        /** 初始化預填模組 */
        init() {
            this._setupObserver();
            console.log("[mwi-mm] v" + SCRIPT.version + " 市場預填模組已初始化");
        },
 
        /** 監聽 DOM 變化檢測市場購買彈窗的出現 */
        _setupObserver() {
            if (this._observer) this._observer.disconnect();
            this._observer = new MutationObserver((mutations) => {
                if (!STATE.autoPrefillEnabled) return;
                for (const m of mutations) {
                    for (const node of m.addedNodes) {
                        if (!(node instanceof Element)) continue;
                        const modal = node.matches?.(MARKET_SEL.modalContent) ? node : node.querySelector?.(MARKET_SEL.modalContent);
                        if (modal && !this._prefillDone.has(modal)) {
                            setTimeout(() => this._tryPrefill(modal), 200);
                        }
                    }
                }
            });
            this._observer.observe(document.body, { childList: true, subtree: true });
        },
 
        /** 嘗試對購買彈窗執行預填（僅購買型別 + 購物車中有此物品時） */
        _tryPrefill(modal) {
            if (this._prefillDone.has(modal)) return;
            const headerEl = modal.querySelector(MARKET_SEL.header);
            const headerText = (headerEl?.textContent || "").trim();
            const isBuyModal = /立即购买|购买挂牌|购买订单|立即購買|購買掛牌|購買訂單|buy|purchase/i.test(headerText);
            if (!isBuyModal) return;
 
            const useEl = modal.querySelector(MARKET_SEL.itemIcon);
            const href = useEl?.getAttribute("href") || useEl?.getAttribute("xlink:href") || "";
            if (!href.includes("#")) return;
            const bareId = href.split("#").pop();
            if (!bareId) return;
 
            const cartItemId = normalizeCartItemId(bareId);
            const cartRow = STATE.cart.get(cartItemId);
            if (!cartRow || cartRow.quantity <= 0) return;
 
            const neededQty = Math.ceil(cartRow.quantity);
            const qtyInput = modal.querySelector(MARKET_SEL.quantityInput);
            if (!qtyInput) return;
 
            this._setReactInputValue(qtyInput, String(neededQty));
            this._prefillDone.add(modal);
            this._showPrefillHint(modal, cartRow.name || bareId, neededQty);
            console.log(`[mwi-mm] 已預填數量: ${cartRow.name} × ${neededQty}`);
        },
 
        /** 通過原生 setter 設定 React 攜帶的 input 值（觸發 input/change 事件） */
        _setReactInputValue(input, value) {
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
            if (nativeInputValueSetter) nativeInputValueSetter.call(input, value);
            else input.value = value;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
        },
 
        /** 在購買彈窗插入「已預填」提示 */
        _showPrefillHint(modal, itemName, qty) {
            const qtyContainer = modal.querySelector(MARKET_SEL.quantityContainer);
            if (!qtyContainer) return;
            if (qtyContainer.parentElement.querySelector(".mwi-mm-prefill-hint")) return;
            const hint = document.createElement("div");
            hint.className = "mwi-mm-prefill-hint";
            hint.innerHTML = `<span class="mwi-mm-prefill-tag">${t("prefill_tag")}</span> ${escapeHtml(itemName)} × <b>${formatQty(qty)}</b>`;
            const parentContainer = qtyContainer.closest('[class*="MarketplacePanel_inputContainer"]');
            if (parentContainer) parentContainer.insertBefore(hint, qtyContainer);
            else qtyContainer.parentElement.insertBefore(hint, qtyContainer);
        }
    };
 
    // ── 採購導航條模組 ────────────────────────────────────
    const _purchaseNav = {
        _injectedNav: null,
        _lastMarketPanel: null,
        _observer: null,
        _pollTimer: null,
        _debounceTimer: null,
        _inited: false,               // ★ 防止重複初始化
        _visHandler: null,            // ★ 頁面隱藏時暫停輪詢的監聽器參照
        _sessionDone: new Map(),      // ★ 本次市場會話內已購齊的物品(itemId → {itemId,name,iconRef})
        _gameCls: null,               // ★ 執行時採集的遊戲類名(帶 webpack hash，每次構建都變)
 
        /** 記錄已購齊物品：購齊後該行會被移出購物車，這裡留一份快照，
         *  讓它繼續以「✓ 已購齊」的樣子留在導航條原位(不重排、不誤點)。 */
        noteFulfilled(rows) {
            for (const r of rows || []) {
                if (!r || !r.itemId || isCoinItem(r.itemId)) continue;
                this._sessionDone.set(normalizeCartItemId(r.itemId), r);
            }
        },
 
        /** 執行時取 misc 精靈圖路徑（檔名帶 hash，不能硬編碼）。
         *  ★ v2.3 修正：不再採集 Button_button/Button_buy 類名。
         *    原因：注入時若訂單簿尚未渲染，Button_buy__xxx 在文件中還不存在 → 採集到空串 →
         *    按鈕只剩 Button_button 的預設藍(#4357af)，等買過一次觸發重建後才變綠，顏色會跳。
         *    對渲染有強時序依賴的東西不能靠"當時文件裡有沒有"來決定，故按鈕外觀改為完全自持。 */
        _harvest() {
            const u = document.querySelector('svg use[href*="misc_sprite"]');
            this._gameCls = { misc: u ? (u.getAttribute("href") || "").split("#")[0] : "" };
            return this._gameCls;
        },
 
        /** 初始化採購導航模組 */
        init() {
            if (this._inited) return; // ★ 避免重複 setInterval 導致 timer 洩漏
            this._inited = true;
            this._setupObserver();
            this._startPolling();
            // ★ 頁面不可見時暫停 2s 輪詢，可見時恢復（省 CPU，不影響體驗）
            this._visHandler = () => {
                if (document.hidden) this._stopPolling();
                else this._startPolling();
            };
            document.addEventListener("visibilitychange", this._visHandler);
            _marketDataCache.onChange(() => this._scheduleUpdate(80));
            _wsInventory.onChange(() => this._scheduleUpdate(200));
            console.log("[mwi-mm] v" + SCRIPT.version + " 採購導航條模組已初始化（含內聯購齊橫幅）");
        },
 
        /** ★ 啟動輪詢（已在執行則忽略） */
        _startPolling() {
            if (this._pollTimer) return;
            this._pollTimer = setInterval(() => this._poll(), 2000);
        },
 
        /** ★ 暫停輪詢（可由 visibilitychange 觸發） */
        _stopPolling() {
            if (this._pollTimer) {
                clearInterval(this._pollTimer);
                this._pollTimer = null;
            }
        },
 
        /** 監聽 DOM 變化檢測市場面板顯示/隱藏 */
        _setupObserver() {
            if (this._observer) this._observer.disconnect();
            this._observer = new MutationObserver((mutations) => {
                for (const m of mutations) {
                    for (const node of m.addedNodes) {
                        if (!(node instanceof Element)) continue;
                        if (this._isMarketModalNode(node)) {
                            this._scheduleUpdate(30);
                            return;
                        }
                    }
                    for (const node of m.removedNodes) {
                        if (!(node instanceof Element)) continue;
                        if (this._isMarketModalNode(node)) {
                            this._cleanup();
                            return;
                        }
                    }
                    if (m.type === "attributes" && m.target instanceof Element) {
                        if (this._isMarketModalNode(m.target)) {
                            this._scheduleUpdate(30);
                            return;
                        }
                    }
                }
            });
            this._observer.observe(document.body, { childList: true, subtree: false });
            const tryObserveMainPanel = () => {
                const mainPanel = document.querySelector('[class*="MainPanel_mainPanel"]');
                if (mainPanel) {
                    // 只聽 class:行動進度條以 inline-style 寬度高頻動畫,監聽 style 會讓回撥被持續空轉
                    this._observer.observe(mainPanel, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
                    return true;
                }
                return false;
            };
            if (!tryObserveMainPanel()) {
                let retries = 0;
                const retryTimer = setInterval(() => {
                    retries++;
                    if (tryObserveMainPanel() || retries > 20) clearInterval(retryTimer);
                }, 500);
            }
        },
 
        /** 判斷節點是否為市場彈窗 */
        _isMarketModalNode(node) {
            if (!(node instanceof Element)) return false;
            const cls = node.className || "";
            if (typeof cls === "string") {
                return cls.includes("marketplaceModal") || cls.includes("MarketplacePanel_marketplacePanel");
            }
            return false;
        },
 
        /** 延遲更新（去抖） */
        _scheduleUpdate(delay) {
            if (this._debounceTimer) clearTimeout(this._debounceTimer);
            this._debounceTimer = setTimeout(() => {
                this._debounceTimer = null;
                this._poll();
            }, delay);
        },
 
        /** 查詢市場彈窗的父容器
         *  ★ 修復(遊戲更新後導航條不可見)：舊實現用全文件 querySelector。
         *    新版 DOM 中市場彈窗祖先鏈為
         *      MainPanel_marketplaceModalContainer (position:fixed, 全屏 0,0 → 視口寬高)
         *        └ MainPanel_marketplaceModal      (彈窗本體)
         *            └ MainPanel_marketplaceModalContent
         *    子串選擇器 [class*="MainPanel_marketplaceModal"] 三層全中，
         *    querySelector 取文件序第一個 → 拿到整屏 Container，
         *    _syncPosition 於是把 nav 定到 top = rect.bottom = 視口底邊 → 螢幕外不可見
         *    （DOM 存在、無報錯，故此前靜默失敗）。
         *    改為從「當前可見的市場面板」向上 closest：結構上保證是本面板的祖先。
         *    選擇器用 "MainPanel_marketplaceModal__"(帶雙下劃線)精確命中彈窗本體：
         *      本體      MainPanel_marketplaceModal__uObZ3        ← 命中
         *      內容層    MainPanel_marketplaceModalContent__xxx   ← 不含 "Modal__"，不命中
         *      整屏容器  MainPanel_marketplaceModalContainer__xxx ← 同上，不命中
         *    (取內容層會導致導航條比彈窗窄 2px、左移 1px) */
        _findModalContainer() {
            const panel = findVisibleMarketplacePanel();
            if (!panel) return null;
            const el = panel.closest('[class*="MainPanel_marketplaceModal__"]');
            if (el && isVisible(el)) return el;
            return null;
        },
 
        /** 輪詢檢測市場面板狀態並注入/更新導航條 */
        _poll() {
            if (!STATE.purchaseNavEnabled) {
                this._cleanup();
                return;
            }
            const hasActiveItems = [...STATE.cart.values()].some(r => r.quantity > 0 && !isCoinItem(r.itemId));
            if (!hasActiveItems) {
                this._cleanup();
                return;
            }
 
            const marketPanel = findVisibleMarketplacePanel();
            if (!marketPanel) {
                this._cleanup();
                return;
            }
 
            if (this._injectedNav && document.body.contains(this._injectedNav) && this._lastMarketPanel === marketPanel) {
                // ★ v2.3：面板沒變 ≠ 內容沒變。購物車數量改動、新增物品、切換當前瀏覽物品
                //   都需要重畫膠囊；舊版只在面板物件變化時重建，導致導航條內容滯留。
                if (this._navSignature() !== this._lastSig) this._injectNav();
                else this._syncPosition();
                return;
            }
 
            this._lastMarketPanel = marketPanel;
            this._injectNav();
        },
 
        /** 清理導航條 DOM（市場關閉 / 無待購項時） */
        _cleanup() {
            if (this._injectedNav) {
                this._injectedNav.remove();
                this._injectedNav = null;
            }
            this._lastMarketPanel = null;
            this._sessionDone.clear();   // ★ 市場關了 → 已購齊記錄歸零，下次開啟重新開始
            this._animatedDone.clear();
            this._lastSig = "";
        },
 
        /** 同步導航條位置（跟隨市場面板）
         *  ★ 幾何約束：遊戲彈窗是 width:75rem/height:45rem + max-width/height:96% + 居中，
         *    因此彈窗底邊到視口底邊最多隻有視口高的 2%。視窗偏矮或移動端時，
         *    彈窗下方根本放不下導航條(≈44px) → 若仍按 top=rect.bottom 定位，
         *    導航條會被推出視口(本次 bug 的同一種失敗形態，且同樣無聲)。
         *    故此處顯式鉗制：放不下就翻到彈窗內側底部，並留下日誌。 */
        _navFlipLogged: false,
        _syncPosition() {
            if (!this._injectedNav) return;
            const container = this._findModalContainer();
            if (!container) return;
            const rect = container.getBoundingClientRect();
            const nav = this._injectedNav;
            const h = nav.offsetHeight || 44;
            nav.style.left = rect.left + "px";
            nav.style.width = rect.width + "px";
            const below = window.innerHeight - rect.bottom;
            if (below >= h) {
                nav.style.top = rect.bottom + "px";
                nav.dataset.mmNavMode = "outside";
                nav.classList.remove("is-inside");
            } else {
                nav.style.top = Math.max(0, rect.bottom - h) + "px";
                nav.dataset.mmNavMode = "inside";
                nav.classList.add("is-inside");
                if (!this._navFlipLogged) {
                    this._navFlipLogged = true;
                    console.info("[mwi-mm] 彈窗下方空間不足(" + Math.round(below) + "px < " + h + "px)，採購導航條翻至彈窗內側底部");
                }
            }
        },
 
        /** 導航條內容簽名：行(id+數量+狀態) + 當前瀏覽物品。變了才重畫。 */
        _lastSig: "",
        _navSignature() {
            const cur = this._lastMarketPanel ? this._detectCurrentItem(this._lastMarketPanel) : "";
            const rows = this._getNavRows().map(r => normalizeCartItemId(r.itemId) + ":" + r.quantity + ":" + (r.done ? 1 : 0));
            return rows.join("|") + "#" + normalizeCartItemId(cur || "");
        },
 
        /** 組裝導航條要顯示的行：待購項 + 本會話已購齊項(留在原位) */
        _getNavRows() {
            const pending = this._getCartItemsForNav();          // 僅 quantity > 0，語義不變
            const pendingIds = new Set(pending.map(x => normalizeCartItemId(x.itemId)));
            const done = [];
            for (const [id, r] of this._sessionDone) {
                if (pendingIds.has(id)) continue;                // 又被重新加回購物車 → 不算已購齊
                done.push({ itemId: r.itemId, name: r.name, iconRef: r.iconRef, quantity: 0, done: true });
            }
            return [...pending.map(x => ({ ...x, done: false })), ...done];
        },
 
        /** 建立並注入採購導航條 DOM */
        _injectNav() {
            if (!STATE.purchaseNavEnabled) return;
 
            document.querySelectorAll(".mwi-mm-purchase-nav").forEach(el => el.remove());
 
            const cartItems = this._getCartItemsForNav();
            if (cartItems.length === 0) return;                  // 沒有待購項 → 不注入(語義不變)
 
            const container = this._findModalContainer();
            if (!container) return;
 
            const rows = this._getNavRows();
            const G = this._harvest();
            const currentItemId = this._lastMarketPanel ? this._detectCurrentItem(this._lastMarketPanel) : "";
            const nav = document.createElement("div");
            nav.className = "mwi-mm-purchase-nav";
 
            // 下一個待購目標：優先取非當前項，否則取第一項
            const nextItem = cartItems.find(x => !currentItemId || normalizeCartItemId(x.itemId) !== normalizeCartItemId(currentItemId)) || cartItems[0];
 
            let html = `<div class="mwi-mm-nav-lead">${escapeHtml(t("nav_progress", cartItems.length, rows.length))}</div>`;
            html += `<div class="mwi-mm-nav-items">`;
            for (const item of rows) {
                const isCurrent = !item.done && currentItemId && normalizeCartItemId(item.itemId) === normalizeCartItemId(currentItemId);
                const safeHref = escapeHtml(resolveItemIconHref(item));
                const nid = normalizeCartItemId(item.itemId);
                let justDone = false;
                if (item.done && !this._animatedDone.has(nid)) { justDone = true; this._animatedDone.add(nid); }
                const cls = ["mwi-mm-nav-item", isCurrent ? "is-current" : "", item.done ? "is-done" : "", justDone ? "is-just-done" : ""].filter(Boolean).join(" ");
                const qtyText = item.done ? t("nav_done_chip") : t("nav_short", formatQty(item.quantity));
                html += `<div class="${cls}" data-nav-item-id="${escapeHtml(item.itemId)}" title="${escapeHtml(item.name)} · ${escapeHtml(qtyText)}">`;
                html += `<div class="mwi-mm-nav-item-icon">${safeHref ? `<svg viewBox="0 0 32 32"><use href="${safeHref}" xlink:href="${safeHref}"></use></svg>` : `<span class="mwi-mm-nav-item-ph">?</span>`}</div>`;
                html += `<div class="mwi-mm-nav-item-info"><div class="mwi-mm-nav-item-name">${escapeHtml(item.name)}</div>`;
                html += `<div class="mwi-mm-nav-item-qty">${escapeHtml(qtyText)}</div>`;
                html += `</div></div>`;
            }
            html += `</div>`;
 
            // 尾部：快捷鍵提示 + 「採購下一個」(套遊戲原生按鈕類，綠色)
            html += `<div class="mwi-mm-nav-tail">`;
            html += _buildShortcutHintHtml();   // ★ 複用橫幅上那套(含未設定態/點選進設定)
            if (nextItem) {
                const label = escapeHtml(t("nav_next_btn").replace(" ▶", ""));
                const arrow = G.misc
                    ? `<svg viewBox="0 0 32 32"><use href="${escapeHtml(G.misc)}#up_arrow"></use></svg>`
                    : `<span class="mwi-mm-nav-next-arrow">▶</span>`;
                html += `<button class="mwi-mm-nav-next-btn" data-next-item-id="${escapeHtml(nextItem.itemId)}">${label}${arrow}</button>`;
            }
            html += `</div>`;
            nav.innerHTML = html;
 
            nav.addEventListener("click", (e) => {
                const nextEl = e.target.closest("[data-next-item-id]");
                if (nextEl) {
                    const nid = nextEl.getAttribute("data-next-item-id");
                    if (nid) openMarketplaceForItem(nid);
                    return;
                }
                const hintEl = e.target.closest(".mwi-mm-nav-shortcut-hint");
                if (hintEl) { e.preventDefault(); _openShortcutSettings(); return; }
                const itemEl = e.target.closest("[data-nav-item-id]");
                if (!itemEl || itemEl.classList.contains("is-done")) return;   // 已購齊項不可點
                const itemId = itemEl.getAttribute("data-nav-item-id");
                if (!itemId) return;
                openMarketplaceForItem(itemId);
                nav.querySelectorAll(".mwi-mm-nav-item").forEach(el => el.classList.remove("is-current"));
                itemEl.classList.add("is-current");
            });
 
            document.body.appendChild(nav);
            this._injectedNav = nav;
            this._lastSig = this._navSignature();
            this._syncPosition();
        },
 
        /** 獲取購物車中有缺料的物品列表（用於導航條顯示） */
        _getCartItemsForNav() {
            const items = [];
            for (const [id, row] of STATE.cart) {
                if (!row || !row.itemId || isCoinItem(id)) continue;
                if (row.quantity <= 0) continue;
                items.push({ itemId: row.itemId, name: resolveCartDisplayName(row), iconRef: row.iconRef || "", quantity: row.quantity });
            }
            items.sort((a, b) => a.name.localeCompare(b.name, _getLocale()));
            return items;
        },
 
        /** 檢測當前市場頁面顯示的物品 ID */
        _detectCurrentItem(container) {
            const useEls = container.querySelectorAll('svg use[href*="items_sprite"]');
            for (const use of useEls) {
                const href = use.getAttribute("href") || "";
                if (href.includes("#") && !href.includes("coin")) return href.split("#").pop();
            }
            return "";
        },
 
        // ── 購齊事件（v2.3：取消內聯橫幅，改為膠囊原地劃線淡出） ──────────
        _animatedDone: new Set(),     // 已播放過劃線動畫的 itemId，避免每次重建都重播
 
        /** 物品購齊時：裝填/卸下快捷鍵 + 重建導航條（該膠囊原地變「已購齊」並播放動畫） */
        _onItemFulfilled(nextItem) {
            if (!STATE.purchaseNavEnabled) return;
            // ★ 快捷鍵裝填放在最前：即便後續渲染出問題，按鍵也已就位
            if (nextItem && nextItem.itemId) _shortcutManager.arm(nextItem.itemId);
            else _shortcutManager.disarm();
            this._injectNav();
        }
    };
 
 
    // ════════════════════════════════════════════════════════════════════════
    // §13 樣式注入
    //     43KB 單行 CSS —— 新 UI 落地時由分元件 CSS + Shadow DOM 取代
    // ════════════════════════════════════════════════════════════════════════
 
    // ── CSS ───────────────────────────────────────────────────────
 
    /** 注入外掛所有 CSS 樣式 */
    function injectStyles() {
        const style = document.createElement("style");
        style.textContent = `:root{--mm-surface-1:#08080e;--mm-surface-2:#0d0d14;--mm-surface-3:#12121a;--mm-surface-deep:#000005;--mm-surface-mask:#0d0d14;--mm-surface-icon:#1a1a22;--mm-surface-btn:#14141c;--mm-border-1:#1c1c26;--mm-border-2:#1e1e28;--mm-border-3:#1f1f29;--mm-border-4:#26262f;--mm-border-5:#272733;--mm-border-input:#1f1f2c;--mm-border-hover:#3a3a4a;--mm-border-star:#26262f;--mm-text-primary:#fff;--mm-text-body:rgba(255,255,255,.88);--mm-text-hover:#fff;--mm-text-muted:rgba(255,255,255,.72);--mm-text-muted-2:rgba(255,255,255,.72);--mm-text-muted-3:rgba(255,255,255,.65);--mm-text-weak:rgba(255,255,255,.55);--mm-text-weak-2:rgba(255,255,255,.48);--mm-text-dim:rgba(255,255,255,.36);--mm-text-dim-2:rgba(255,255,255,.32);--mm-text-faint:rgba(255,255,255,.24);--mm-text-faint-2:rgba(255,255,255,.26);--mm-accent-gold:#f0b429;--mm-accent-gold-bright:#fcd34d;--mm-accent-gold-warm:#f0b429;--mm-accent-star:#f0b429;--mm-accent-market:#f0b429;--mm-green:#34d399;--mm-green-soft:#86efac;--mm-green-btn:#a5d6a7;--mm-green-pick:#95d5b2;--mm-green-check:#22c55e;--mm-red-soft:#fca5a5;--mm-red-text:#fb7185;--mm-red-clear:#f3a3ad;--mm-red-btn:#e59b9b;--mm-blue:#93c5fd;--mm-blue-soft:#b9ccff;--mm-blue-soft-2:#b9d4ff;--mm-blue-bright:#60a5fa;--mm-blue-hover:#7cacf8;--mm-blue-deep:#3b82f6;--mm-blue-focus:#f0b429;--mm-blue-focus-2:#f0b429;--mm-blue-link:#60a5fa;--mm-blue-text:#fff;--mm-toast-err-text:#fecaca;--mm-toast-ok-text:#d1fae5;--mm-toast-text:rgba(255,255,255,.9);--mm-market-btn-bg:#0d2418;--mm-market-btn-hover:#143220;--mm-market-btn-border:#1e5a32;--mm-market-btn-border-hover:#277841;--mm-remove-btn-bg:#2a1317;--mm-remove-btn-hover:#3b1b1e;--mm-remove-btn-border:#6e2a30;--mm-remove-btn-border-hover:#933840;--mm-pick-btn-border:#2d6a4f;--mm-clear-btn-border:#8f3a44;--mm-w-02:rgba(255,255,255,.02);--mm-w-04:rgba(255,255,255,.04);--mm-w-06:rgba(255,255,255,.06);--mm-w-08:rgba(255,255,255,.08);--mm-w-10:rgba(255,255,255,.1);--mm-w-12:rgba(255,255,255,.12);--mm-w-15:rgba(255,255,255,.15);--mm-w-18:rgba(255,255,255,.18);--mm-w-22:rgba(255,255,255,.22);--mm-k-20:rgba(0,0,0,.2);--mm-k-30:rgba(0,0,0,.3);--mm-k-35:rgba(0,0,0,.35);--mm-k-45:rgba(0,0,0,.45);--mm-k-56:rgba(0,0,0,.56);--mm-k-60:rgba(0,0,0,.6);}[data-mm-badge]::after{content:attr(data-mm-badge);margin-left:6px;font-size:12px;font-weight:600;padding:1px 6px;border-radius:3px;display:inline-block;line-height:1.5;vertical-align:middle;white-space:nowrap}[data-mm-badge-type="missing"]::after{color:#e88e98;background:rgba(180,50,70,.18)}[data-mm-badge-type="ok"]::after{color:rgba(110,200,150,.8);background:rgba(40,120,80,.15)}[data-mm-badge-type="surplus"]::after{color:rgba(147,197,253,.75);background:rgba(59,130,246,.12)}.mwi-mm-upgrade-badge{margin-left:8px;font-size:12px;font-weight:600;padding:1px 6px;border-radius:3px;display:inline-block;line-height:1.5}.mwi-mm-upgrade-badge.is-missing{color:#e88e98;background:rgba(180,50,70,.18)}.mwi-mm-upgrade-badge.is-ok{color:rgba(110,200,150,.8);background:rgba(40,120,80,.15)}.mwi-mm-upgrade-inline{margin-top:4px;display:inline-block;font-size:12px;font-weight:600;padding:1px 6px;border-radius:3px;line-height:1.5;white-space:nowrap}.mwi-mm-upgrade-inline.is-missing{color:#e88e98;background:rgba(180,50,70,.18);border:none}.mwi-mm-upgrade-inline.is-ok{color:rgba(110,200,150,.8);background:rgba(40,120,80,.15);border:none}.mwi-mm-upgrade-inline.is-surplus{color:rgba(147,197,253,.75);background:rgba(59,130,246,.12);border:none}.mwi-mm-summary-panel{margin:6px 0 2px;padding:10px 2px 0;border-radius:0;background:transparent!important;border:none!important;border-top:1px solid rgba(255,255,255,.06)!important;color:inherit!important;font-size:13px;box-shadow:none}.mwi-mm-summary-head{display:flex;justify-content:center;align-items:center;margin-bottom:6px}.mwi-mm-summary-head .stat{color:rgba(255,255,255,.55)!important;font-size:12px;font-weight:500}.mwi-mm-manual-count-row{display:flex;align-items:center;gap:8px;margin-bottom:8px;padding:6px 4px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:6px}.mwi-mm-manual-label{color:rgba(255,255,255,.7)!important;font-size:12px;font-weight:500;white-space:nowrap;flex-shrink:0}.mwi-mm-manual-input{width:90px;padding:3px 6px;border:1px solid rgba(255,255,255,.15);border-radius:4px;background:rgba(0,0,0,.3);color:#f8c86b;font-size:13px;font-weight:600;outline:none;transition:border-color .2s;-moz-appearance:textfield}.mwi-mm-manual-input::-webkit-inner-spin-button,.mwi-mm-manual-input::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}.mwi-mm-manual-input:focus{border-color:rgba(99,140,255,.6)}.mwi-mm-summary-buttons{margin-top:4px;display:flex;gap:8px}.mwi-mm-summary-buttons button{flex:1;cursor:pointer}.mwi-mm-chain-btn{position:absolute;right:-2px;top:-2px;width:16px;height:16px;border:1px solid rgba(99,140,255,.4);background:rgba(99,140,255,.12);color:#93c5fd;border-radius:3px;font-size:8px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;z-index:5;transition:all .15s}.mwi-mm-chain-btn:hover{background:rgba(99,140,255,.25);border-color:rgba(99,140,255,.6);color:#fff}.mwi-mm-chain-tree{margin:6px 0;padding:4px 0;border-top:1px dashed rgba(255,255,255,.06);border-bottom:1px dashed rgba(255,255,255,.06);font-size:12.5px;max-height:280px;overflow-y:auto;text-align:left}.mwi-mm-chain-title{font-size:12.5px;font-weight:600;color:#93c5fd;padding:2px 4px 4px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;background:#1b1d24;z-index:1}.mwi-mm-chain-toggle{border:1px solid rgba(99,140,255,.3);background:rgba(99,140,255,.1);color:#93c5fd;border-radius:4px;padding:1px 6px;font-size:11px;cursor:pointer;display:flex;align-items:center;gap:3px;transition:all .15s;line-height:1.4}.mwi-mm-chain-toggle:hover{background:rgba(99,140,255,.22);border-color:rgba(99,140,255,.5)}.mwi-mm-chain-body{width:100%;border-collapse:collapse;font-size:12.5px}.mwi-mm-chain-step-head td{padding:5px 4px 2px;font-weight:600;color:#c8cfde;font-size:12.5px}.mwi-mm-chain-row td{padding:2px 4px}.mwi-mm-chain-row td.mwi-mm-chain-name{padding-left:18px;color:#e4e6ee}.mwi-mm-chain-row td.mwi-mm-chain-qty{color:#f8c86b;font-weight:600;text-align:right;white-space:nowrap;width:50px;font-variant-numeric:tabular-nums}.mwi-mm-chain-row td.mwi-mm-chain-stock{text-align:right;white-space:nowrap;width:52px;font-size:11px;font-variant-numeric:tabular-nums}.mwi-mm-chain-row.is-missing td.mwi-mm-chain-stock{color:#e88e98}.mwi-mm-chain-row.is-ok td.mwi-mm-chain-stock{color:rgba(110,200,150,.7)}.mwi-mm-chain-row.is-surplus td.mwi-mm-chain-stock{color:rgba(147,197,253,.7)}.mwi-mm-chain-upgrade{font-size:10px;color:#fbbf24;background:rgba(251,191,36,.12);padding:1px 4px;border-radius:2px;margin-left:4px}.mwi-mm-item-icon{width:28px;height:28px}.mwi-mm-icon-fallback{color:var(--mm-text-dim-2);font-weight:700;font-size:13px}.mwi-mm-market-target{outline:2px solid rgba(245,158,11,.9);outline-offset:1px;box-shadow:0 0 0 2px rgba(245,158,11,.28);border-radius:8px;animation:mwi-mm-pulse 1.4s ease-in-out infinite}@keyframes mwi-mm-pulse{0%{box-shadow:0 0 0 1px rgba(245,158,11,.15)}50%{box-shadow:0 0 0 3px rgba(245,158,11,.45)}100%{box-shadow:0 0 0 1px rgba(245,158,11,.15)}}.mwi-mm-toast{position:fixed;top:12px;right:12px;z-index:2147483300;padding:10px 14px;border-radius:8px;border:1px solid rgba(71,85,105,.8);color:var(--mm-toast-text);background:rgba(15,23,42,.95);font-size:14px;transition:all .25s;box-shadow:0 10px 20px var(--mm-k-35)}.mwi-mm-toast-success{border-color:rgba(16,185,129,.85);color:var(--mm-toast-ok-text)}.mwi-mm-toast-error{border-color:rgba(239,68,68,.85);color:var(--mm-toast-err-text)}
.mwi-mm-prefill-hint{display:flex;align-items:center;gap:5px;padding:2px 0;margin-bottom:2px;font-size:12px;color:#8a9aaa;line-height:1.4}.mwi-mm-prefill-hint b{color:var(--mm-accent-gold);font-weight:600}.mwi-mm-prefill-tag{flex-shrink:0;padding:0px 5px;border-radius:3px;background:rgba(52,211,153,.15);color:var(--mm-green);font-size:10px;font-weight:600}
.mwi-mm-purchase-nav{position:fixed;z-index:802;box-sizing:border-box;display:flex;align-items:center;gap:var(--spacing-md);padding:var(--spacing-sm) var(--spacing-md);flex-wrap:wrap;font-family:Roboto,Helvetica,Arial,sans-serif;color:var(--color-text-dark-mode);background:var(--color-midnight-900);border:1px solid var(--color-neutral-200);border-top:1px solid var(--color-midnight-400);border-radius:0 0 var(--radius-sm) var(--radius-sm);box-shadow:0 0 .25rem .25rem hsla(0,0%,81.6%,.2823529412)}.mwi-mm-purchase-nav.is-inside{border-radius:var(--radius-sm) var(--radius-sm) 0 0;border-bottom:none;box-shadow:0 -4px 12px var(--mm-k-45)}.mwi-mm-nav-lead{flex:0 0 auto;padding-right:var(--spacing-md);border-right:1px solid var(--color-midnight-400);font-size:var(--font-size-sm);color:var(--color-space-300);white-space:nowrap}.mwi-mm-nav-tail{flex:0 0 auto;display:flex;align-items:center;gap:var(--spacing-sm);margin-left:auto}
.mwi-mm-nav-items{flex:1 1 auto;min-width:0;display:flex;gap:var(--spacing-xs);overflow-x:auto;padding:2px 0;scrollbar-width:thin;scrollbar-color:var(--color-space-300) transparent}.mwi-mm-nav-items::-webkit-scrollbar{height:4px}.mwi-mm-nav-items::-webkit-scrollbar-thumb{background:var(--color-space-300);border-radius:var(--radius-sm)}.mwi-mm-nav-item{flex-shrink:0;display:flex;align-items:center;gap:6px;padding:4px 10px 4px 6px;border-radius:var(--radius-sm);border:1px solid var(--color-midnight-400);background:var(--color-midnight-700);cursor:pointer;transition:background .15s,border-color .15s}.mwi-mm-nav-item:hover{background:var(--color-midnight-500);border-color:var(--color-space-600)}.mwi-mm-nav-item.is-current{background:var(--color-space-800);border-color:var(--color-space-400)}.mwi-mm-nav-item.is-current .mwi-mm-nav-item-name{color:var(--color-neutral-0)}.mwi-mm-nav-item.is-done{background:var(--color-midnight-800);border-color:var(--color-jade-600);opacity:.7;cursor:default}.mwi-mm-nav-item.is-done:hover{background:var(--color-midnight-800);border-color:var(--color-jade-600)}.mwi-mm-nav-item.is-done .mwi-mm-nav-item-name{color:var(--color-jade-200);position:relative}.mwi-mm-nav-item.is-done .mwi-mm-nav-item-name::after{content:"";position:absolute;left:0;top:50%;width:100%;height:1px;background:currentColor}.mwi-mm-nav-item.is-just-done .mwi-mm-nav-item-name::after{animation:mwi-mm-nav-strike .45s ease-out}.mwi-mm-nav-item.is-just-done{animation:mwi-mm-nav-fade .7s ease-out}@keyframes mwi-mm-nav-strike{from{width:0}to{width:100%}}@keyframes mwi-mm-nav-fade{0%{opacity:1;border-color:var(--color-market-buy);background:var(--color-jade-600-opacity-60)}100%{opacity:.7}}.mwi-mm-nav-item.is-done .mwi-mm-nav-item-qty{color:var(--color-market-buy)}.mwi-mm-nav-item.is-done .mwi-mm-nav-item-icon svg{filter:grayscale(.6)}.mwi-mm-nav-item-icon{width:var(--icon-size-small);height:var(--icon-size-small);flex-shrink:0;display:flex;align-items:center;justify-content:center}.mwi-mm-nav-item-icon svg{width:var(--icon-size-small);height:var(--icon-size-small)}.mwi-mm-nav-item-ph{font-size:11px;color:var(--color-neutral-600)}.mwi-mm-nav-item-info{min-width:0;display:flex;flex-direction:column;line-height:1.25}.mwi-mm-nav-item-name{font-size:var(--font-size-sm);color:var(--color-neutral-100);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:88px}.mwi-mm-nav-item-qty{font-size:var(--font-size-xs);color:var(--color-orange-500);font-variant-numeric:tabular-nums}
/* 「採購下一個」按鈕：顏色/hover 全由遊戲 Button_button+Button_buy 提供，此處只約束尺寸 */
.mwi-mm-nav-next-btn{flex-shrink:0;display:flex;align-items:center;justify-content:center;gap:6px;height:var(--button-height-normal);padding:0 var(--spacing-lg);border:none;border-radius:var(--radius-sm);background:var(--color-space-600);color:var(--color-neutral-0);cursor:pointer;user-select:none;white-space:nowrap;line-height:1;font-family:Roboto,Helvetica,Arial,sans-serif;font-size:var(--font-size-base);font-weight:var(--font-weight-semibold);transition:background .15s}
/* 橫幅上的快捷鍵提示 */
.mwi-mm-nav-next-btn:hover{background:var(--color-space-500)}.mwi-mm-nav-next-btn:active{background:var(--color-space-700)}.mwi-mm-nav-next-btn svg{width:var(--icon-size-tiny);height:var(--icon-size-tiny);flex-shrink:0;fill:currentColor}.mwi-mm-nav-next-arrow{font-size:10px;line-height:1}
.mwi-mm-nav-shortcut-hint{display:inline-flex;align-items:center;font-size:11px;font-family:ui-monospace,Menlo,Consolas,monospace;letter-spacing:.3px;color:var(--mm-text-weak);background:var(--mm-w-04);border:1px solid var(--mm-w-08);border-radius:4px;padding:1px 6px;margin:0 6px;cursor:pointer;user-select:none;transition:all .15s;white-space:nowrap}
.mwi-mm-nav-shortcut-hint:hover{color:var(--mm-text-hover);background:var(--mm-w-08);border-color:var(--mm-w-18)}
.mwi-mm-nav-shortcut-hint.is-unset{color:var(--mm-text-faint-2);font-family:inherit;font-style:italic}
.mwi-mm-nav-shortcut-hint.is-unset:hover{color:var(--mm-blue);border-color:rgba(96,165,250,.3)}`;
        document.head.appendChild(style);
    }
 
 
    // ════════════════════════════════════════════════════════════════════════
    // §14 啟動
    //     waitForBody / init —— 所有啟動副作用的唯一入口
    // ════════════════════════════════════════════════════════════════════════
 
    // ── 啟動 ─────────────────────────────────────────────────────
 
    /** 等待 document.body 可用 */
    // ── 接線:舊 UI 以訂閱方式接收資料變更通知 ─────────────────────
    //    核心區(§03/§05/§06/§07)共 33 處渲染直調已替換為 Store.notify(主題);
    //    下列訂閱與原直調 1:1 對應;notify 為同步執行,時序與原行為一致。
    //    箭頭包裝 = 延遲取引用,不依賴各渲染函式的定義形式與位置。
    //    舊浮窗已物理刪除,舊渲染訂閱隨之移除;新殼(§10A)在掛載時自行訂閱。
 
    function waitForBody() {
        return new Promise((resolve) => {
            if (document.body) { resolve(); return; }
            const timer = setInterval(() => { if (document.body) { clearInterval(timer); resolve(); } }, 50);
        });
    }
 
    /** 外掛主入口：初始化所有子系統並等待遊戲就緒 */
    async function init() {
        await waitForBody();
 
        // setupWSInterceptor() 已提前到 IIFE 頂層執行，此處不再呼叫
 
        _wsInventory.onChange((change) => {
            if (change?.source === "patch" && change.deltas instanceof Map) {
                // 精確 WS delta 必須立即消費；不能去抖合併，否則「先消耗、後購買」又會變成淨庫存差。
                if (_syncDebounceTimer) {
                    clearTimeout(_syncDebounceTimer);
                    _syncDebounceTimer = null;
                }
                syncCartWithInventory(change);
            } else {
                triggerInventorySync(15);
            }
            scheduleRefresh(150);
            // 庫存變化 → 重新整理計劃頁進度條（僅在計劃頁可見時實際重繪，無副作用）
            Store.notify("plans");
        });
 
        injectStyles();
        _initSpriteBaseProbe(); // ★ 儘早啟動 sprite 路徑探測
 
        loadCart();
        loadPlans();
        loadToggles();
        setupObservers();
 
 
        await waitForGameReady();
        try { _themeProbe.init(); } catch (err) { console.warn("[mwi-mm] theme init:", err); }   // 內建暗色令牌
        try { _newShell.init(); } catch (err) { console.warn("[mwi-mm] shell init:", err); }     // /3: 新殼(雙形態)
 
 
        // ★ 遊戲 DOM 就緒後，把主 observer 從 document.body 收窄到 GamePage 容器，
        //   避免被聊天/通知等高頻無關 mutation 打擾，降低主執行緒開銷。
        try {
            // observer 直接監聽 document.body(見 ensureMainObserverAttached 註釋)。
            //   市場彈窗等 portal UI 渲染在 GamePage 之外,收窄會漏掉其開/關 → 徽章凍結,故全程監聽 body。
            ensureMainObserverAttached();
            console.log("[mwi-mm] observer 已掛載至 document.body（覆蓋 GamePage 外的市場/模態 portal）");
        } catch (e) { console.warn("[mwi-mm] observer 掛載失敗：", e); }
 
        // 周邊子系統逐個隔離啟動:單個拋錯不阻斷後續(看門狗是注入 UI 的最終兜底,必須啟動)。
        for (const [name, start] of [
            ["市場預填", () => _marketPrefill.init()],
            ["採購導航", () => _purchaseNav.init()],
            ["快捷鍵", () => _shortcutManager.init()],
            ["看門狗", () => startRemountWatchdog()],
        ]) {
            try { start(); _log.note("init", name + " ✓"); } catch (err) { console.error("[mwi-mm] 子系統「" + name + "」啟動失敗(其餘繼續):", err); }
        }
 
        const dataReady = await waitForClientData();
        if (dataReady) {
            _dataLayer.init();
        } else {
            console.warn("[mwi-mm] 遊戲資料未就緒（localStorage/WS/Mooket 均不可用），使用 DOM 回退");
        }
 
        const wsLabel = _wsInventory.ready ? t("ws_exact") : t("ws_waiting");
        const dlLabel = _dataLayer.ready ? t("dl_ok") : t("dl_fallback");
        const srcLabel = _capturedClientData ? (_capturedClientData._src || t("cache")) : t("dl_fallback");
        const plansLabel = STATE.craftingPlans.size > 0 ? t("plans_n", STATE.craftingPlans.size) : t("no_plans");
        setAction(t("action_startup", SCRIPT.version, wsLabel, dlLabel, plansLabel, srcLabel));
        scheduleRefresh(80);
 
        // ★ 公共 API 就緒訊號（晚到的 'ready' 監聽器也會立即觸發）
        try { _apiInternal.markReady(); } catch (e) { console.error("[mwi-mm] markReady failed:", e); }
        _log.note("init", "init 完成");
    }
 
    init().catch((err) => {
        console.error("[mwi-mm] init failed", err);
    });
})();