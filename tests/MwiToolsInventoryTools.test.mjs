// mwiTools 倉庫小工具：寶箱期望價值、一次開完的數量、從 React 找物品元件（node --test 'tests/*.test.mjs'）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFunctionsFromScript } from './UserScriptFunctionExtractor.mjs';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const readGameData = fileName => JSON.parse(readFileSync(join(repositoryRoot, 'simulator/src/combatsimulator/data', fileName), 'utf8'));
const itemDetailMap = readGameData('itemDetailMap.json');
const openableLootDropMap = readGameData('openableLootDropMap.json');
const inventoryTools = loadFunctionsFromScript(join(repositoryRoot, 'mwiTools.js'), [
    'getLootDropSaleValue', 'calculateLootChestValue', 'getLootOpenAllCount', 'findInventoryItemComponent'
]);

// 每個可交易物品：賣單 110、買單 100
function createFlatMarket() {
    const marketData = {};
    for (const [itemHrid, item] of Object.entries(itemDetailMap)) {
        if (item.isTradable) marketData[itemHrid] = { 0: { a: 110, b: 100 } };
    }
    return { marketData };
}

describe('寶箱期望價值', () => {
    const marketAPIJson = createFlatMarket();

    test('小工匠匣：期望數量 × 買單價 × (1 - 4% 稅)，金幣不扣稅', () => {
        const chestHrid = '/items/small_artisans_crate';
        let expected = 0;
        for (const drop of openableLootDropMap[chestHrid]) {
            const expectedCount = drop.dropRate * (drop.minCount + drop.maxCount) / 2;
            const unitValue = drop.itemHrid === '/items/coin' ? 1 : itemDetailMap[drop.itemHrid]?.isTradable ? 100 * 0.96 : null;
            if (unitValue !== null) expected += expectedCount * unitValue;
        }
        const value = inventoryTools.calculateLootChestValue(chestHrid, itemDetailMap, openableLootDropMap, marketAPIJson, false);
        assert.equal(value.keyCost, 0);
        assert.ok(expected > 0);
        assert.ok(Math.abs(value.grossValue - expected) < 1e-6);
    });

    test('賣單估價比買單估價高', () => {
        const chestHrid = '/items/small_artisans_crate';
        const atBid = inventoryTools.calculateLootChestValue(chestHrid, itemDetailMap, openableLootDropMap, marketAPIJson, false);
        const atAsk = inventoryTools.calculateLootChestValue(chestHrid, itemDetailMap, openableLootDropMap, marketAPIJson, true);
        assert.ok(atAsk.netValue > atBid.netValue);
    });

    test('要鑰匙的寶箱：淨值扣掉鑰匙賣單價', () => {
        const keyedChestHrid = Object.keys(openableLootDropMap).find(itemHrid => itemDetailMap[itemHrid]?.openKeyItemHrid && itemDetailMap[itemDetailMap[itemHrid].openKeyItemHrid]?.isTradable);
        assert.ok(keyedChestHrid, '遊戲資料裡應該有要鑰匙的寶箱');
        const value = inventoryTools.calculateLootChestValue(keyedChestHrid, itemDetailMap, openableLootDropMap, marketAPIJson, false);
        assert.equal(value.keyCost, 110);
        assert.ok(Math.abs(value.netValue - (value.grossValue - 110)) < 1e-9);
    });

    test('不是寶箱：價值 0', () => {
        const value = inventoryTools.calculateLootChestValue('/items/milk', itemDetailMap, openableLootDropMap, marketAPIJson, false);
        assert.deepEqual({ ...value }, { grossValue: 0, keyCost: 0, netValue: 0 });
    });
});

describe('右鍵一次開完', () => {
    test('數量：堆疊數；要鑰匙時取鑰匙數較小者', () => {
        assert.equal(inventoryTools.getLootOpenAllCount(25, false, 0), 25);
        assert.equal(inventoryTools.getLootOpenAllCount(25, true, 7), 7);
        assert.equal(inventoryTools.getLootOpenAllCount(3, true, 7), 3);
        assert.equal(inventoryTools.getLootOpenAllCount(undefined, false, 0), 0);
    });

    test('從物品格的 React fiber 找到帶 itemHrid 與 hash 的 Item 元件', () => {
        const instance = { props: { itemHrid: '/items/small_artisans_crate', hash: 'c::inv::crate::0', count: 3 } };
        const itemElement = { '__reactFiber$test': { stateNode: null, memoizedProps: { className: 'x' }, return: { stateNode: instance, return: null } } };
        assert.equal(inventoryTools.findInventoryItemComponent(itemElement).instance, instance);
        assert.equal(inventoryTools.findInventoryItemComponent({}), null);
        assert.equal(inventoryTools.findInventoryItemComponent(null), null);
    });
});
