// mwiTools 每日資產盈虧：紀錄、比較、平均、物品/掛單增量合併、代幣估價（node --test 'tests/*.test.mjs'）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFunctionsFromScript } from './UserScriptFunctionExtractor.mjs';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const assetHistory = loadFunctionsFromScript(
    join(repositoryRoot, 'mwiTools.js'),
    [
        'padTwoDigits', 'getAssetHistoryDayKey', 'getAssetHistoryDayGap', 'getCharacterItemKey', 'mergeCharacterItems', 'mergeMarketListings',
        'getWeightedMarketPrice', 'getMarketFairPrice', 'getShopItemCosts', 'getShopCurrencyValue', 'computeOptionalAssetValues', 'buildAssetSnapshot',
        'recordAssetSnapshot', 'getAssetDailyChange', 'getAssetSevenDayAverage', 'buildAssetHistoryRows', 'formatSignedAssetChange',
        'formatAssetChangePercent', 'buildAssetDailyChangeSentence', 'formatAssetHistoryDate', 'buildAssetHistoryHtml'
    ],
    'const ASSET_HISTORY_DISPLAY_DAYS = 14;'
);
const daysOf = totalsByDay => Object.fromEntries(Object.entries(totalsByDay).map(([dayKey, total]) => [dayKey, { total }]));
const plainFormat = value => String(Math.round(value));

describe('日期', () => {
    test('本機日期 YYYY-MM-DD 與相隔天數（跨月）', () => {
        assert.equal(assetHistory.getAssetHistoryDayKey(new Date(2026, 9, 1, 23, 59)), '2026-10-01');
        assert.equal(assetHistory.getAssetHistoryDayGap('2026-09-30', '2026-10-01'), 1);
        assert.equal(assetHistory.getAssetHistoryDayGap('2026-09-24', '2026-10-01'), 7);
    });
});

describe('紀錄與比較', () => {
    test('同一天只留最後一筆，不改動原紀錄，不同角色分開', () => {
        const empty = { version: 1, roles: {} };
        const first = assetHistory.recordAssetSnapshot(empty, 'char1', '2026-10-01', { total: 100 });
        const second = assetHistory.recordAssetSnapshot(first, 'char1', '2026-10-01', { total: 150 });
        const otherCharacter = assetHistory.recordAssetSnapshot(second, 'char2', '2026-10-01', { total: 5 });
        assert.equal(second.roles.char1.days['2026-10-01'].total, 150);
        assert.equal(first.roles.char1.days['2026-10-01'].total, 100);
        assert.equal(otherCharacter.roles.char1.days['2026-10-01'].total, 150);
        assert.equal(otherCharacter.roles.char2.days['2026-10-01'].total, 5);
    });

    test('今日盈虧：跟前一個有紀錄的日子比（中間跳過的天數也算出來）', () => {
        const days = daysOf({ '2026-09-27': 1000, '2026-09-30': 1200, '2026-10-01': 1500 });
        assert.deepEqual({ ...assetHistory.getAssetDailyChange(days, '2026-10-01') }, { previousDayKey: '2026-09-30', gapDays: 1, change: 300, previousTotal: 1200 });
        assert.deepEqual({ ...assetHistory.getAssetDailyChange(days, '2026-09-30') }, { previousDayKey: '2026-09-27', gapDays: 3, change: 200, previousTotal: 1000 });
        assert.equal(assetHistory.getAssetDailyChange(days, '2026-09-27'), null);
        assert.equal(assetHistory.getAssetDailyChange(days, '2026-10-02'), null);
    });

    test('近 7 日平均：對約 7 天前那筆，不足 7 天用最早一筆', () => {
        const longHistory = daysOf({ '2026-09-20': 0, '2026-09-24': 400, '2026-10-01': 1100 });
        assert.equal(assetHistory.getAssetSevenDayAverage(longHistory, '2026-10-01'), 100);
        const shortHistory = daysOf({ '2026-09-29': 1000, '2026-10-01': 1400 });
        assert.equal(assetHistory.getAssetSevenDayAverage(shortHistory, '2026-10-01'), 200);
        assert.equal(assetHistory.getAssetSevenDayAverage(daysOf({ '2026-10-01': 5 }), '2026-10-01'), null);
    });

    test('表格列：新到舊、帶跟前一筆的差、最多 N 列', () => {
        const rows = assetHistory.buildAssetHistoryRows(daysOf({ '2026-09-29': 100, '2026-09-30': 80, '2026-10-01': 130 }), 2);
        assert.deepEqual(rows.map(row => ({ ...row })), [
            { dayKey: '2026-10-01', total: 130, change: 50 },
            { dayKey: '2026-09-30', total: 80, change: -20 }
        ]);
    });

    test('今日一句話：金額（小數兩位）+ 身家百分比，跟上游分享訊息同格式', () => {
        // 正式環境傳 numberFormatter(數字, 小數位數)，這裡模擬 M 單位、檢查有要求兩位小數
        const millionFormat = (value, digits) => `${(value / 1e6).toFixed(digits)}M`;
        const loss = { previousDayKey: '2026-09-30', gapDays: 1, change: -194470000, previousTotal: 5947095000 };
        assert.equal(assetHistory.buildAssetDailyChangeSentence(loss, millionFormat, true), '今天 -194.47M，身家 -3.27%');
        assert.equal(assetHistory.buildAssetDailyChangeSentence(loss, millionFormat, false), 'Today -194.47M, net worth -3.27%');
        const gain = { previousDayKey: '2026-09-27', gapDays: 3, change: 200, previousTotal: 1000 };
        assert.equal(assetHistory.buildAssetDailyChangeSentence(gain, plainFormat, true), '近 3 天 +200，身家 +20.00%');
        // 基準是 0（例如剛開始玩）就不顯示百分比，避免除以 0
        assert.equal(assetHistory.buildAssetDailyChangeSentence({ gapDays: 1, change: 50, previousTotal: 0 }, plainFormat, true), '今天 +50');
    });

    test('畫面 HTML：今日一句話、比較基準、第一天提示', () => {
        const days = daysOf({ '2026-09-30': 1000, '2026-10-01': 900 });
        const html = assetHistory.buildAssetHistoryHtml(days, '2026-10-01', true, plainFormat, true);
        assert.match(html, /今天 -100，身家 -10\.00%/);
        assert.match(html, /比較基準：09\/30（昨天）/);
        assert.match(html, /display: block/);
        const firstDayHtml = assetHistory.buildAssetHistoryHtml(daysOf({ '2026-10-01': 900 }), '2026-10-01', false, plainFormat, true);
        assert.match(firstDayHtml, /明天開始顯示/);
        assert.match(firstDayHtml, /display: none/);
    });
});

describe('物品與掛單增量', () => {
    test('物品：同 hash 取代、數量 0 移除、新物品加入', () => {
        const items = [
            { hash: 'c::inv::/items/milk::0', itemHrid: '/items/milk', count: 10 },
            { hash: 'c::inv::/items/egg::0', itemHrid: '/items/egg', count: 5 }
        ];
        const merged = assetHistory.mergeCharacterItems(items, [
            { hash: 'c::inv::/items/milk::0', itemHrid: '/items/milk', count: 7 },
            { hash: 'c::inv::/items/egg::0', itemHrid: '/items/egg', count: 0 },
            { hash: 'c::inv::/items/cheese::0', itemHrid: '/items/cheese', count: 2 }
        ]);
        assert.deepEqual(merged.map(item => `${item.itemHrid}:${item.count}`).sort(), ['/items/cheese:2', '/items/milk:7']);
        assert.equal(items[0].count, 10);
    });

    test('掛單：進行中或有未領取保留，其餘移除', () => {
        const listings = [{ id: 1, status: '/market_listing_status/active' }, { id: 2, status: '/market_listing_status/active' }];
        const merged = assetHistory.mergeMarketListings(listings, [
            { id: 1, status: '/market_listing_status/filled', unclaimedCoinCount: 500, unclaimedItemCount: 0 },
            { id: 2, status: '/market_listing_status/cancelled', unclaimedCoinCount: 0, unclaimedItemCount: 0 },
            { id: 3, status: '/market_listing_status/active' }
        ]);
        assert.deepEqual(merged.map(listing => listing.id).sort(), [1, 3]);
    });
});

describe('總資產與代幣', () => {
    const marketAPIJson = {
        marketData: {
            '/items/chimerical_essence': { 0: { a: 110, b: 90 } },
            '/items/griffin_leather': { 0: { a: 2000000, b: 1800000 } },
            '/items/bag_of_10_cowbells': { 0: { a: 300000, b: 280000 } }
        }
    };
    const shopItemDetailMap = {
        '/shop_items/essence': { itemHrid: '/items/chimerical_essence', costs: [{ itemHrid: '/items/chimerical_token', count: 1 }] },
        '/shop_items/leather': { itemHrid: '/items/griffin_leather', costs: [{ itemHrid: '/items/chimerical_token', count: 10000 }] },
        '/shop_items/mixed': { itemHrid: '/items/griffin_leather', costs: [{ itemHrid: '/items/chimerical_token', count: 1 }, { itemHrid: '/items/coin', count: 1 }] }
    };
    const taskShopItemDetailMap = { '/task_shop_items/essence': { itemHrid: '/items/chimerical_essence', cost: { itemHrid: '/items/task_token', count: 2 } } };

    test('代幣單價：只看單一代幣標價的品項，取最划算的', () => {
        assert.equal(assetHistory.getShopCurrencyValue('/items/chimerical_token', [shopItemDetailMap], marketAPIJson), 190);
        assert.equal(assetHistory.getShopCurrencyValue('/items/task_token', [shopItemDetailMap, taskShopItemDetailMap], marketAPIJson), 50);
        assert.equal(assetHistory.getShopCurrencyValue('/items/pirate_token', [shopItemDetailMap], marketAPIJson), 0);
    });

    test('牛鈴與代幣只算背包裡的', () => {
        const characterItems = [
            { itemHrid: '/items/cowbell', itemLocationHrid: '/item_locations/inventory', count: 20 },
            { itemHrid: '/items/chimerical_token', itemLocationHrid: '/item_locations/inventory', count: 100 },
            { itemHrid: '/items/milk', itemLocationHrid: '/item_locations/inventory', count: 999 }
        ];
        const optionalValues = assetHistory.computeOptionalAssetValues(characterItems, { '/items/chimerical_token': 190 }, 29000);
        assert.deepEqual({ ...optionalValues }, { cowbells: 580000, tokens: 19000 });
    });

    test('總資產 = 流動（高低平均）+ 牛鈴/代幣 + 房子 + 技能書', () => {
        const snapshot = assetHistory.buildAssetSnapshot(
            { equippedAsk: 100, equippedBid: 80, inventoryAsk: 50, inventoryBid: 30, listingsAsk: 20, listingsBid: 20 },
            { cowbells: 5, tokens: 7 },
            { houses: 1000, abilities: 500 },
            '2026-10-01T00:00:00.000Z'
        );
        assert.equal(snapshot.total, 90 + 45 + 20 + 7 + 1000 + 500);
        assert.equal(snapshot.inventory, 45);
    });
});
