// mwiTools 新功能審查後的修正：動作產出併入庫存、強化估價並行不互相干擾、牛鈴袋不一次開完、
// 已取消掛單不重複計入、算分失敗不寫假紀錄（node --test 'tests/*.test.mjs'）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadMwiToolsScript, getMwiToolsScriptPath } from './MwiToolsScriptLoader.mjs';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const readGameData = fileName => JSON.parse(readFileSync(join(repositoryRoot, 'simulator/src/combatsimulator/data', fileName), 'utf8'));
const itemDetailMap = readGameData('itemDetailMap.json');
const openableLootDropMap = readGameData('openableLootDropMap.json');

const ACTIVE = '/market_listing_status/active';
const CANCELLED = '/market_listing_status/cancelled';

function createClientData() {
    return {
        type: 'init_client_data',
        itemDetailMap,
        actionDetailMap: readGameData('actionDetailMap.json'),
        levelExperienceTable: readGameData('levelExperienceTable.json'),
        actionCategoryDetailMap: {},
        abilityDetailMap: readGameData('abilityDetailMap.json'),
        openableLootDropMap,
    };
}

function inventoryItem(itemHrid, count) {
    return { hash: `1::/item_locations/inventory::${itemHrid}::0`, itemLocationHrid: '/item_locations/inventory', itemHrid, enhancementLevel: 0, count };
}

function createCharacterData(overrides = {}) {
    return {
        type: 'init_character_data',
        character: { id: 1, name: 'Me' },
        characterSkills: [],
        characterItems: [],
        characterHouseRoomMap: {},
        actionTypeDrinkSlotsMap: {},
        characterAbilities: [],
        myMarketListings: [],
        combatUnit: { combatAbilities: [] },
        characterActions: [],
        ...overrides,
    };
}

// 腳本啟動與登入流程會印很多 log / 找不到 DOM 的錯誤，測試時先關掉
function quietly(callback) {
    const { log, error, debug } = console;
    console.log = console.error = console.debug = () => {};
    try {
        return callback();
    } finally {
        Object.assign(console, { log, error, debug });
    }
}

describe('action_completed 的物品變動', () => {
    test('產出 / 消耗（絕對數量）併入庫存，數量 0 代表用完', () => {
        const hooks = quietly(() => loadMwiToolsScript(['getInventoryCountByHrid']));
        quietly(() => {
            hooks.feedMessage(createClientData());
            hooks.feedMessage(createCharacterData({ characterItems: [inventoryItem('/items/milk', 50), inventoryItem('/items/cheese', 8)] }));
        });
        assert.equal(hooks.getInventoryCountByHrid('/items/milk'), 50);

        quietly(() =>
            hooks.feedMessage({
                type: 'action_completed',
                endCharacterAction: { id: 9, actionHrid: '/actions/milking/cow', isDone: false, currentCount: 1 },
                endCharacterItems: [inventoryItem('/items/milk', 5000), inventoryItem('/items/cheese', 0)],
            })
        );
        assert.equal(hooks.getInventoryCountByHrid('/items/milk'), 5000);
        assert.equal(hooks.getInventoryCountByHrid('/items/cheese'), 0);
    });
});

describe('強化物品估價', () => {
    // 強化模擬換成依物品等級與目標等級算的假結果（真的模擬太慢），只驗證並行時參數不會互相蓋掉
    function loadWithStubbedEnhancelate() {
        const source = readFileSync(getMwiToolsScriptPath(), 'utf8');
        const signature = 'function Enhancelate(input_data, protect_at) {';
        assert.ok(source.includes(signature), '找不到 Enhancelate，測試要跟著更新');
        const stubbed = source.replace(
            signature,
            signature +
                ' { const stubItemLevel = initData_itemDetailMap[input_data.item_hrid].itemLevel;' +
                ' return { actions: stubItemLevel * input_data.stop_at * 3, protect_count: (input_data.stop_at - protect_at) * 0.5, totalActionTimeSec: 1, totalActionTimeStr: "x" }; }'
        );
        const stubbedPath = join(mkdtempSync(join(tmpdir(), 'mwitools-')), 'mwiTools.stubbed.js');
        writeFileSync(stubbedPath, stubbed);
        const previousPath = process.env.MWI_TOOLS_SCRIPT_PATH;
        process.env.MWI_TOOLS_SCRIPT_PATH = stubbedPath;
        try {
            const hooks = quietly(() => loadMwiToolsScript(['getEnhancedItemCost', 'enhancedItemCostCache', 'MARKET_JSON_LOCAL_BACKUP']));
            quietly(() => hooks.feedMessage(createClientData()));
            hooks.localStorage.setItem('MWITools_marketAPI_json', hooks.MARKET_JSON_LOCAL_BACKUP);
            hooks.localStorage.setItem('MWITools_marketAPI_timestamp', String(Date.now()));
            return hooks;
        } finally {
            if (previousPath === undefined) delete process.env.MWI_TOOLS_SCRIPT_PATH;
            else process.env.MWI_TOOLS_SCRIPT_PATH = previousPath;
        }
    }

    test('兩件物品同時估價，結果跟分開估一樣（不共用全域 input_data）', async () => {
        const hooks = loadWithStubbedEnhancelate();
        const holySword = ['/items/holy_sword', 10];
        const cheeseSword = ['/items/cheese_sword', 5];

        hooks.enhancedItemCostCache.clear();
        const sequentialHoly = await hooks.getEnhancedItemCost(...holySword);
        const sequentialCheese = await hooks.getEnhancedItemCost(...cheeseSword);
        assert.ok(sequentialHoly > 0 && sequentialCheese > 0);
        assert.notEqual(sequentialHoly, sequentialCheese);

        hooks.enhancedItemCostCache.clear();
        const [concurrentHoly, concurrentCheese] = await Promise.all([hooks.getEnhancedItemCost(...holySword), hooks.getEnhancedItemCost(...cheeseSword)]);
        assert.equal(concurrentHoly, sequentialHoly);
        assert.equal(concurrentCheese, sequentialCheese);
    });

    test('同一件物品同時估價只算一次（共用同一個進行中的結果）', async () => {
        const hooks = loadWithStubbedEnhancelate();
        hooks.enhancedItemCostCache.clear();
        const first = hooks.getEnhancedItemCost('/items/holy_sword', 10);
        const second = hooks.getEnhancedItemCost('/items/holy_sword', 10);
        assert.equal(hooks.enhancedItemCostCache.size, 1);
        assert.equal(await first, await second);
    });
});

describe('可交易的開箱物（牛鈴袋）', () => {
    function loadWithClientData() {
        const hooks = quietly(() => loadMwiToolsScript(['handleInventoryLootContextMenu', 'buildLootChestTooltipHtml', 'settingsMap']));
        quietly(() => hooks.feedMessage(createClientData()));
        hooks.settingsMap.inventoryLootOpenAll.isTrue = true;
        hooks.settingsMap.lootChestEstimate.isTrue = true;
        return hooks;
    }

    // 倉庫格子：closest 只認得物品格與倉庫容器，fiber 上掛著帶 openLootHandler 的 Item 元件
    function createContextMenuEvent(itemHrid, count) {
        const openCalls = [];
        const instance = {
            props: { itemHrid, hash: `1::inv::${itemHrid}::0`, count, openLootKeyCount: 0, openLootHandler: (hash, openCount) => openCalls.push(openCount) },
            canOpen: () => true,
        };
        const itemElement = {
            '__reactFiber$test': { stateNode: instance, return: null },
            closest: selector => (selector.includes('Inventory_items') ? {} : null),
        };
        const target = { closest: selector => (selector.includes('Item_itemContainer') ? itemElement : null) };
        const event = {
            button: 2,
            target,
            defaultPrevented: false,
            preventDefault() {
                this.defaultPrevented = true;
            },
            stopImmediatePropagation() {},
        };
        return { event, openCalls };
    }

    test('右鍵：一般寶箱一次開完；牛鈴袋交回遊戲（只開 1 個），不攔截', () => {
        const hooks = loadWithClientData();
        const crate = createContextMenuEvent('/items/small_artisans_crate', 25);
        hooks.handleInventoryLootContextMenu(crate.event);
        assert.deepEqual(crate.openCalls, [25]);
        assert.equal(crate.event.defaultPrevented, true);

        const cowbellBag = createContextMenuEvent('/items/bag_of_10_cowbells', 25);
        hooks.handleInventoryLootContextMenu(cowbellBag.event);
        assert.deepEqual(cowbellBag.openCalls, []);
        assert.equal(cowbellBag.event.defaultPrevented, false);
    });

    test('懸浮窗：牛鈴袋不顯示「開箱期望」（產物牛鈴不可交易，估出來是 0）', () => {
        const hooks = loadWithClientData();
        const marketData = {};
        for (const [itemHrid, item] of Object.entries(itemDetailMap)) {
            if (item.isTradable) marketData[itemHrid] = { 0: { a: 110, b: 100 } };
        }
        assert.equal(hooks.buildLootChestTooltipHtml('/items/bag_of_10_cowbells', 3, { marketData }), '');
        assert.notEqual(hooks.buildLootChestTooltipHtml('/items/small_artisans_crate', 3, { marketData }), '');
    });
});

describe('市場掛單估值', () => {
    test('已取消的賣單：剩餘數量已退回背包不再計入，只算未領取的金幣', async () => {
        const hooks = quietly(() => loadMwiToolsScript(['computeLiquidAssetValues']));
        const listing = (id, status, filledQuantity, unclaimedCoinCount) => ({
            id,
            status,
            isSell: true,
            itemHrid: '/items/milk',
            enhancementLevel: 0,
            orderQuantity: 10,
            filledQuantity,
            unclaimedCoinCount,
            unclaimedItemCount: 0,
            price: 100,
        });
        quietly(() => {
            hooks.feedMessage(createClientData());
            hooks.feedMessage(createCharacterData({ myMarketListings: [listing(1, ACTIVE, 0, 0), listing(2, CANCELLED, 4, 400)] }));
        });
        const values = await hooks.computeLiquidAssetValues({ marketData: { '/items/milk': { 0: { a: 110, b: 100 } } } });
        // 進行中：10 × 價格 × (1 - 4%)；已取消：只有 400 未領取金幣
        assert.ok(Math.abs(values.listingsBid - (10 * 100 * 0.96 + 400)) < 1e-6);
        assert.ok(Math.abs(values.listingsAsk - (10 * 110 * 0.96 + 400)) < 1e-6);
    });
});
