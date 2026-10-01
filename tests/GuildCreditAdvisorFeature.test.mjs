// 公會信用點兌換推薦（GuildCreditAdvisorFeature）：排行、批數、賣出換購、代幣價值、選單排序、面板放置與 HTML、讀遊戲情境的純邏輯（node --test 'tests/*.test.mjs'）
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadMwiToolsScript } from './MwiToolsScriptLoader.mjs';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const itemDetailMap = JSON.parse(readFileSync(join(repositoryRoot, 'simulator/src/combatsimulator/data/itemDetailMap.json'), 'utf8'));
const clientDataMessage = {
    type: 'init_client_data',
    itemDetailMap,
    actionDetailMap: {},
    openableLootDropMap: {},
    levelExperienceTable: [],
    abilityDetailMap: {},
    actionCategoryDetailMap: {},
};

function loadFeature(options) {
    const hooks = loadMwiToolsScript(['GuildCreditAdvisorFeature', 'settingsMap', 'SCRIPT_COLOR_MAIN'], options);
    hooks.feedMessage(clientDataMessage);
    return hooks;
}

const chineseHooks = loadFeature({ localStorageValues: { i18nextLng: 'zh-TW' } });
const englishHooks = loadFeature({ localStorageValues: { i18nextLng: 'en' } });
const { GuildCreditAdvisorFeature } = chineseHooks;
const englishFeature = englishHooks.GuildCreditAdvisorFeature;
// 沙盒裡建立的物件原型跟測試這邊不同，比對前先轉成一般 JSON（Infinity 會變 null）
const toPlain = (value) => JSON.parse(JSON.stringify(value));
const panelPrefix = 'mwitools-local-guild-credit-advisor';
const countMatches = (text, pattern) => (text.match(pattern) || []).length;
const inventoryItem = (itemHrid, count, enhancementLevel = 0, itemLocationHrid = '/item_locations/inventory') => ({
    hash: `123::${itemLocationHrid}::${itemHrid}::${enhancementLevel}`,
    itemHrid,
    itemLocationHrid,
    enhancementLevel,
    count,
});

async function waitFor(check, attempts = 50) {
    for (let attempt = 0; attempt < attempts && !check(); attempt++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    return Boolean(check());
}

// 小型假資料：紅色信用點的兌換材料（itemCount → creditCount）與市價（a 出售價 / b 收購價）
const redCredit = '/items/red_guild_credit';
const fixtureConversions = [
    { itemHrid: '/items/beta_ore', itemCount: 1, creditCount: 10 },
    { itemHrid: '/items/delta_ore', itemCount: 1, creditCount: 5 },
    { itemHrid: '/items/gamma_ore', itemCount: 1, creditCount: 1 },
    { itemHrid: '/items/alpha_ore', itemCount: 2, creditCount: 1 },
    { itemHrid: '/items/epsilon_ore', itemCount: 1, creditCount: 1 },
    { itemHrid: '/items/guild_token', itemCount: 1, creditCount: 10 },
];
const fixtureIndex = new Map([[redCredit, fixtureConversions]]);
const fixtureMarket = {
    timestamp: 1760432846,
    marketData: {
        '/items/alpha_ore': { 0: { a: 15, b: 14 }, 2: { a: -1, b: 100 } }, // 2 個 → 1 點：每點 30，一批 30
        '/items/gamma_ore': { 0: { a: 30, b: 32 } }, // 1 → 1：每點 30，一批 30（同分比 hrid）
        '/items/beta_ore': { 0: { a: 300, b: 280 } }, // 1 → 10：每點 30，一批 300（同分排後面）
        '/items/delta_ore': { 0: { a: 1000, b: 900 }, 3: { a: -1, b: 2000 } }, // 1 → 5：每點 200
        '/items/epsilon_ore': { 0: { a: -1, b: 50 } }, // 沒有出售價 → 不能買
        '/items/guild_token': { 0: { a: 5, b: 5 } }, // 就算有價格也不列入（不能交易）
        '/items/pebble': { 0: { a: 25, b: 20 } },
        '/items/bag_of_10_cowbells': { 0: { a: 120, b: 100 } },
    },
};

describe('設定與偏好', () => {
    test('設定項目存在、預設開啟、描述是繁體中文', () => {
        const setting = chineseHooks.settingsMap.guildCreditConversionsSort;
        assert.equal(setting.id, 'guildCreditConversionsSort');
        assert.equal(setting.isTrue, true);
        assert.match(setting.desc, /公會信用點兌換/);
        assert.doesNotMatch(setting.desc, /[会兑换显荐价设]/);
        assert.match(englishHooks.settingsMap.guildCreditConversionsSort.desc, /^Guild credit exchange/);
    });

    test('推薦數量：1–8 的整數，超出範圍夾回，不是數字用預設 3', () => {
        const normalize = GuildCreditAdvisorFeature._normalizeRecommendationCount;
        assert.equal(normalize(5), 5);
        assert.equal(normalize('7'), 7);
        assert.equal(normalize(2.9), 2);
        assert.equal(normalize(0), 1);
        assert.equal(normalize(12), 8);
        assert.equal(normalize('abc'), 3);
        assert.equal(normalize(''), 3);
        assert.equal(normalize(null), 3);
        assert.equal(normalize(undefined), 3);
    });

    test('從 GM 讀推薦數量（壞資料用預設），存回 JSON 字串', () => {
        const storageKey = 'MWITools_guildCreditAdvisor_v1';
        const originalCount = GuildCreditAdvisorFeature._recommendationCount;
        chineseHooks.gmStore.set(storageKey, '{"recommendationCount":5}');
        GuildCreditAdvisorFeature._loadPreferences();
        assert.equal(GuildCreditAdvisorFeature._recommendationCount, 5);
        chineseHooks.gmStore.set(storageKey, '{oops');
        GuildCreditAdvisorFeature._loadPreferences();
        assert.equal(GuildCreditAdvisorFeature._recommendationCount, 3);
        chineseHooks.gmStore.set(storageKey, '{"recommendationCount":99}');
        GuildCreditAdvisorFeature._loadPreferences();
        assert.equal(GuildCreditAdvisorFeature._recommendationCount, 8);
        GuildCreditAdvisorFeature._savePreferences();
        assert.equal(chineseHooks.gmStore.get(storageKey), '{"recommendationCount":8}');
        GuildCreditAdvisorFeature._recommendationCount = originalCount;
        chineseHooks.gmStore.delete(storageKey);
    });
});

describe('文字與格式', () => {
    test('物品名稱：中文時信用點與公會代幣用繁體官方名稱，其他走本地名稱表；英文用遊戲英文名', () => {
        assert.equal(GuildCreditAdvisorFeature._getItemName(redCredit), '紅色公會信用點');
        assert.equal(GuildCreditAdvisorFeature._getItemName('/items/gold_guild_credit'), '金色公會信用點');
        assert.equal(GuildCreditAdvisorFeature._getItemName('/items/guild_token'), '公會代幣');
        assert.equal(GuildCreditAdvisorFeature._getItemName('/items/gator_vest'), '鱷魚馬甲');
        assert.equal(englishFeature._getItemName(redCredit), 'Red Guild Credit');
        assert.equal(englishFeature._getItemName('/items/gator_vest'), 'Gator Vest');
    });

    test('金額：縮寫兩位小數、小於 1 用兩位小數、非有限數是「—」；數量取整', () => {
        assert.equal(GuildCreditAdvisorFeature._formatCoins(3600), '3.6k');
        assert.equal(GuildCreditAdvisorFeature._formatCoins(616666.67), '616.67k');
        assert.equal(GuildCreditAdvisorFeature._formatCoins(616666.67, 1), '616.7k');
        assert.equal(GuildCreditAdvisorFeature._formatCoins(88), '88');
        assert.equal(GuildCreditAdvisorFeature._formatCoins(0.5), '0.50');
        assert.equal(GuildCreditAdvisorFeature._formatCoins(Infinity), '—');
        assert.equal(GuildCreditAdvisorFeature._formatCount(Infinity), '—');
        assert.equal(GuildCreditAdvisorFeature._formatCount(12.4), '12');
        assert.equal(GuildCreditAdvisorFeature._formatEnglishCount(1, 'item', 'items'), '1 item');
        assert.equal(GuildCreditAdvisorFeature._formatEnglishCount(5, 'item', 'items'), '5 items');
    });

    test('市場時間：秒 → 本機 MM/DD HH:mm；沒有時間是「—」', () => {
        const date = new Date(1760432846 * 1000);
        const pad = (value) => String(value).padStart(2, '0');
        const expected = `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
        assert.equal(GuildCreditAdvisorFeature._formatMarketTime(1760432846), expected);
        assert.equal(GuildCreditAdvisorFeature._formatMarketTime(0), '—');
        assert.equal(GuildCreditAdvisorFeature._formatMarketTime(undefined), '—');
    });

    test('數字解析照遊戲 parseCompactNumber：k/m/b/t、千分位、四捨五入、逗號小數語系', () => {
        const parse = GuildCreditAdvisorFeature._parseCompactNumber;
        assert.equal(parse('1.5k'), 1500);
        assert.equal(parse('2M'), 2000000);
        assert.equal(parse('1kk'), 1000000);
        assert.equal(parse('.5k'), 500);
        assert.equal(parse('1,234'), 1234);
        assert.equal(parse(' 3 '), 3);
        assert.equal(parse('2.5'), 3);
        assert.ok(Number.isNaN(parse('abc')));
        assert.ok(Number.isNaN(parse('')));
        assert.ok(Number.isNaN(parse(null)));
        assert.equal(parse('1.234,5', ','), 1235);
        assert.equal(parse('1,5k', ','), 1500);
    });

    test('信用點主題色；不認得的用腳本主色（不會讀到 Object 原型上的屬性）', () => {
        assert.equal(GuildCreditAdvisorFeature._getCreditAccentColor(redCredit), '#e65d68');
        assert.equal(GuildCreditAdvisorFeature._getCreditAccentColor('/items/gold_guild_credit'), '#d8a33c');
        assert.equal(GuildCreditAdvisorFeature._getCreditAccentColor('/items/constructor_credit'), chineseHooks.SCRIPT_COLOR_MAIN);
        assert.equal(GuildCreditAdvisorFeature._getCreditAccentColor(null), chineseHooks.SCRIPT_COLOR_MAIN);
    });
});

describe('遊戲資料：兌換索引', () => {
    test('依信用點分組（一個物品可換多種信用點、含公會代幣），略過數量不合法的資料', () => {
        const detailMap = {
            '/items/alpha_ore': { hrid: '/items/alpha_ore', guildCreditConversions: [{ creditItemHrid: redCredit, itemCount: 2, creditCount: 1 }] },
            '/items/hood': {
                hrid: '/items/hood',
                guildCreditConversions: [
                    { creditItemHrid: redCredit, itemCount: 1, creditCount: 4000 },
                    { creditItemHrid: '/items/gold_guild_credit', itemCount: 1, creditCount: 80 },
                ],
            },
            '/items/broken': {
                hrid: '/items/broken',
                guildCreditConversions: [
                    { creditItemHrid: redCredit, itemCount: 0, creditCount: 5 },
                    { creditItemHrid: redCredit, itemCount: 'x', creditCount: 5 },
                    { creditItemHrid: redCredit, itemCount: 1, creditCount: Infinity },
                    { creditItemHrid: '', itemCount: 1, creditCount: 1 },
                    null,
                ],
            },
            '/items/guild_token': { hrid: '/items/guild_token', guildCreditConversions: [{ creditItemHrid: redCredit, itemCount: 1, creditCount: 1 }] },
            '/items/plain': { hrid: '/items/plain' },
        };
        const conversionIndex = GuildCreditAdvisorFeature._buildConversionIndex(detailMap);
        assert.deepEqual(toPlain([...conversionIndex.keys()].sort()), ['/items/gold_guild_credit', redCredit]);
        assert.deepEqual(toPlain(conversionIndex.get(redCredit)), [
            { itemHrid: '/items/alpha_ore', itemCount: 2, creditCount: 1 },
            { itemHrid: '/items/hood', itemCount: 1, creditCount: 4000 },
            { itemHrid: '/items/guild_token', itemCount: 1, creditCount: 1 },
        ]);
        assert.deepEqual(toPlain(GuildCreditAdvisorFeature._findConversion(conversionIndex, '/items/hood', '/items/gold_guild_credit')), {
            itemHrid: '/items/hood',
            itemCount: 1,
            creditCount: 80,
        });
        assert.equal(GuildCreditAdvisorFeature._findConversion(conversionIndex, '/items/plain', redCredit), null);
        assert.equal(GuildCreditAdvisorFeature._buildConversionIndex(null).size, 0);
    });

    test('真實遊戲資料：8 種信用點都有，公會代幣能換每一種，依 itemDetailMap 物件快取', () => {
        const conversionIndex = GuildCreditAdvisorFeature._getConversionIndex();
        assert.equal(conversionIndex.size, 8);
        for (const conversions of conversionIndex.values()) {
            assert.ok(conversions.some((conversion) => conversion.itemHrid === '/items/guild_token'));
        }
        assert.equal(GuildCreditAdvisorFeature._getConversionIndex(), conversionIndex);
        assert.deepEqual(toPlain(GuildCreditAdvisorFeature._findConversion(conversionIndex, '/items/guild_token', '/items/gold_guild_credit')), {
            itemHrid: '/items/guild_token',
            itemCount: 60,
            creditCount: 1,
        });
    });
});

describe('估價與排行', () => {
    test('排行：每點成本升冪；同分比一批成本再比 hrid；排除沒出售價與公會代幣', () => {
        const ranked = GuildCreditAdvisorFeature._rankOptions(fixtureConversions, fixtureMarket);
        assert.deepEqual(
            toPlain(ranked.map((option) => option.itemHrid)),
            ['/items/alpha_ore', '/items/gamma_ore', '/items/beta_ore', '/items/delta_ore']
        );
        assert.deepEqual(toPlain(ranked[0]), {
            itemHrid: '/items/alpha_ore',
            itemCount: 2,
            creditCount: 1,
            askPrice: 15,
            batchCost: 30,
            costPerCredit: 30,
            isAvailable: true,
        });
        assert.equal(ranked[3].costPerCredit, 200);
    });

    test('單一選項：強化等級用自己的出售價；沒有價格時每點成本是 Infinity', () => {
        const delta = fixtureConversions[1];
        assert.equal(GuildCreditAdvisorFeature._evaluateOption(delta, fixtureMarket, 0).costPerCredit, 200);
        const enhanced = GuildCreditAdvisorFeature._evaluateOption(delta, fixtureMarket, 3);
        assert.equal(enhanced.isAvailable, false);
        assert.equal(enhanced.costPerCredit, Infinity);
        assert.equal(GuildCreditAdvisorFeature._evaluateOption(fixtureConversions[5], fixtureMarket, 0).isAvailable, false);
    });

    test('批數跟遊戲預覽一致：已確認、items 草稿、credits 草稿、超過上限夾回、壞草稿用已確認的批數', () => {
        const resolve = GuildCreditAdvisorFeature._resolveBatchCount;
        const conversion = { itemHrid: '/items/alpha_ore', itemCount: 3, creditCount: 2 };
        const committed = { batchCount: 2, editingField: null, draft: '' };
        assert.equal(resolve(committed, conversion, 10), 2);
        assert.equal(resolve({ ...committed, editingField: 'items', draft: '6' }, conversion, 10), 2);
        assert.equal(resolve({ ...committed, editingField: 'items', draft: '8' }, conversion, 10), 3);
        assert.equal(resolve({ ...committed, editingField: 'items', draft: '1k' }, conversion, 10), 3);
        assert.equal(resolve({ ...committed, editingField: 'credits', draft: '2' }, conversion, 10), 1);
        assert.equal(resolve({ ...committed, editingField: 'credits', draft: '5' }, conversion, 10), 3);
        assert.equal(resolve({ ...committed, editingField: 'items', draft: 'abc' }, conversion, 10), 2);
        assert.equal(resolve({ ...committed, editingField: 'items', draft: '' }, conversion, 10), 2);
        assert.equal(resolve({ ...committed, editingField: 'items', draft: '0' }, conversion, 10), 1);
        // 持有數不足一批：上限算 0，草稿夾到 1（跟遊戲 Math.max(上限, 1) 一樣）
        assert.equal(resolve({ ...committed, editingField: 'items', draft: '9' }, conversion, 0), 1);
        assert.equal(resolve({ ...committed, editingField: 'items', draft: '1,5k', decimalSeparator: ',' }, conversion, 3000), 500);
        assert.equal(resolve({ batchCount: 0, editingField: null }, conversion, 10), 1);
        assert.equal(resolve(null, conversion, 10), 1);
    });

    test('賣出換購：未選、公會代幣、沒有市價、已最佳', () => {
        const best = GuildCreditAdvisorFeature._rankOptions(fixtureConversions, fixtureMarket)[0];
        const evaluate = GuildCreditAdvisorFeature._evaluateReplacement;
        assert.equal(evaluate(null, best, fixtureMarket).status, 'no_selection');
        assert.equal(evaluate({ itemHrid: '/items/guild_token', isGuildToken: true, itemCount: 1, creditCount: 10, batchCount: 1 }, best, fixtureMarket).status, 'guild_token');
        assert.equal(evaluate({ itemHrid: '/items/beta_ore', itemCount: 1, creditCount: 10, batchCount: 1 }, null, fixtureMarket).status, 'no_market');
        assert.deepEqual(toPlain(evaluate({ itemHrid: '/items/alpha_ore', enhancementLevel: 0, itemCount: 2, creditCount: 1, batchCount: 3 }, best, fixtureMarket)), {
            status: 'already_optimal',
            directCredits: 3,
            difference: 0,
        });
    });

    test('賣出換購：同 hrid 但 +N 不算已最佳，用 +N 收購價算', () => {
        const best = GuildCreditAdvisorFeature._rankOptions(fixtureConversions, fixtureMarket)[0];
        const result = GuildCreditAdvisorFeature._evaluateReplacement(
            { itemHrid: '/items/alpha_ore', enhancementLevel: 2, itemCount: 2, creditCount: 1, batchCount: 1 },
            best,
            fixtureMarket
        );
        // 賣 2 個 × 100 × 0.96 = 192 → 買 12 個（每個 15）→ 6 批 → 6 點；直接兌換 1 點
        assert.equal(result.status, 'ok');
        assert.equal(result.netSaleValue, 192);
        assert.equal(result.purchasedItems, 12);
        assert.equal(result.replacementCredits, 6);
        assert.equal(result.difference, 5);
    });

    test('賣出換購：沒有收購價、稅後買不起一批', () => {
        const best = GuildCreditAdvisorFeature._rankOptions(fixtureConversions, fixtureMarket)[0];
        const noBid = GuildCreditAdvisorFeature._evaluateReplacement({ itemHrid: '/items/zeta_ore', itemCount: 1, creditCount: 1, batchCount: 2 }, best, fixtureMarket);
        assert.deepEqual(toPlain(noBid), { status: 'no_sell_quote', directCredits: 2, saleQuantity: 2 });
        // 20 × 0.96 = 19.2 → 只買得到 1 個，一批要 2 個
        const unaffordable = GuildCreditAdvisorFeature._evaluateReplacement({ itemHrid: '/items/pebble', itemCount: 1, creditCount: 1, batchCount: 1 }, best, fixtureMarket);
        assert.equal(unaffordable.status, 'unaffordable');
        assert.ok(Math.abs(unaffordable.netSaleValue - 19.2) < 1e-9);
    });

    test('賣出換購：可多換、會少換、相同；牛鈴袋稅率 18%', () => {
        const best = GuildCreditAdvisorFeature._rankOptions(fixtureConversions, fixtureMarket)[0];
        const evaluate = GuildCreditAdvisorFeature._evaluateReplacement;
        // delta 2 批：900 × 2 × 0.96 = 1728 → 115 個 → 57 批 = 57 點；直接 10 點
        const gain = evaluate({ itemHrid: '/items/delta_ore', itemCount: 1, creditCount: 5, batchCount: 2 }, best, fixtureMarket);
        assert.deepEqual([gain.status, gain.saleQuantity, gain.purchasedItems, gain.replacementCredits, gain.directCredits, gain.difference], ['ok', 2, 114, 57, 10, 47]);
        assert.equal(gain.purchaseCost, 114 * 15);
        // beta 1 批：280 × 0.96 = 268.8 → 17 個 → 8 批 = 8 點；直接 10 點
        const loss = evaluate({ itemHrid: '/items/beta_ore', itemCount: 1, creditCount: 10, batchCount: 1 }, best, fixtureMarket);
        assert.equal(loss.difference, -2);
        // gamma 1 批：32 × 0.96 = 30.72 → 2 個 → 1 批 = 1 點；直接 1 點
        const same = evaluate({ itemHrid: '/items/gamma_ore', itemCount: 1, creditCount: 1, batchCount: 1 }, best, fixtureMarket);
        assert.equal(same.difference, 0);
        const cowbells = evaluate({ itemHrid: '/items/bag_of_10_cowbells', itemCount: 1, creditCount: 1, batchCount: 1 }, best, fixtureMarket);
        assert.equal(cowbells.taxRate, 0.18);
        assert.ok(Math.abs(cowbells.netSaleValue - 82) < 1e-9);
        assert.equal(cowbells.replacementCredits, 2);
    });

    test('庫存可兌換：只算庫存裡等級 0、同物品多筆加總、夠一批才列入，依排行順序取前 N 名', () => {
        const ranked = GuildCreditAdvisorFeature._rankOptions(fixtureConversions, fixtureMarket);
        const characterItems = [
            inventoryItem('/items/alpha_ore', 5),
            { ...inventoryItem('/items/alpha_ore', 1), hash: 'second-stack' },
            inventoryItem('/items/gamma_ore', 1),
            inventoryItem('/items/beta_ore', 0),
            inventoryItem('/items/delta_ore', 3, 2),
            inventoryItem('/items/delta_ore', 1, 0, '/item_locations/body'),
        ];
        const owned = GuildCreditAdvisorFeature._collectOwnedOptions(ranked, characterItems, 3);
        assert.deepEqual(
            toPlain(owned.map((option) => [option.itemHrid, option.ownedCount, option.availableBatches])),
            [
                ['/items/alpha_ore', 6, 3],
                ['/items/gamma_ore', 1, 1],
            ]
        );
        assert.equal(GuildCreditAdvisorFeature._collectOwnedOptions(ranked, characterItems, 1).length, 1);
        assert.equal(GuildCreditAdvisorFeature._collectOwnedOptions(ranked, null, 3).length, 0);
    });

    test('公會代幣價值：最低每點成本 × 點數 ÷ 代幣數，依價值降冪；沒價格或不能用代幣換的略過', () => {
        const tokenIndex = new Map([
            [redCredit, [fixtureConversions[3], { itemHrid: '/items/guild_token', itemCount: 1, creditCount: 1 }]],
            ['/items/gold_guild_credit', [fixtureConversions[1], { itemHrid: '/items/guild_token', itemCount: 60, creditCount: 1 }]],
            ['/items/green_guild_credit', [fixtureConversions[2], { itemHrid: '/items/guild_token', itemCount: 1, creditCount: 10 }]],
            ['/items/blue_guild_credit', [fixtureConversions[4], { itemHrid: '/items/guild_token', itemCount: 1, creditCount: 10 }]],
            ['/items/white_guild_credit', [fixtureConversions[3]]],
        ]);
        const tokenValues = GuildCreditAdvisorFeature._computeGuildTokenValues(tokenIndex, fixtureMarket);
        assert.deepEqual(
            toPlain(tokenValues.map((entry) => entry.creditItemHrid)),
            ['/items/green_guild_credit', redCredit, '/items/gold_guild_credit']
        );
        assert.equal(tokenValues[0].valuePerToken, 300);
        assert.equal(tokenValues[1].valuePerToken, 30);
        assert.ok(Math.abs(tokenValues[2].valuePerToken - 200 / 60) < 1e-9);
        assert.equal(tokenValues[2].bestItemHrid, '/items/delta_ore');
    });
});

describe('選物品選單排序與角標', () => {
    test('依自己強化等級的出售價排序；最低者標最佳；沒價格的照原順序排最後；+N 角標下移', () => {
        const menuMarket = {
            marketData: {
                '/items/gamma_ore': { 0: { a: 30, b: 28 } },
                '/items/alpha_ore': { 0: { a: 10, b: 9 } },
                '/items/beta_ore': { 0: { a: 400, b: 380 } },
                '/items/delta_ore': { 0: { a: 900, b: 800 }, 3: { a: 5000, b: 4000 } },
                '/items/epsilon_ore': { 0: { a: -1, b: 1 } },
            },
        };
        const entries = [
            { itemHrid: '/items/gamma_ore', enhancementLevel: 0 },
            null,
            { itemHrid: '/items/delta_ore', enhancementLevel: 3 },
            { itemHrid: '/items/guild_token', enhancementLevel: 0 },
            { itemHrid: '/items/alpha_ore', enhancementLevel: 0 },
            { itemHrid: '/items/epsilon_ore', enhancementLevel: 0 },
            { itemHrid: '/items/beta_ore', enhancementLevel: 0 },
            { itemHrid: '/items/unrelated', enhancementLevel: 0 },
        ];
        const decorations = GuildCreditAdvisorFeature._buildMenuDecorations(entries, redCredit, fixtureIndex, menuMarket);
        assert.deepEqual(
            toPlain(decorations.map((decoration) => [decoration.order, decoration.badgeText, decoration.isBest, decoration.isShifted])),
            [
                [2, '30', false, false],
                [100001, '', false, false],
                [4, '1k', false, true],
                [100003, '', false, false],
                [1, '20', true, false],
                [100005, '', false, false],
                [3, '40', false, false],
                [100007, '', false, false],
            ]
        );
    });

    test('同為最低成本時都標最佳，排序維持原順序', () => {
        const decorations = GuildCreditAdvisorFeature._buildMenuDecorations(
            [
                { itemHrid: '/items/gamma_ore', enhancementLevel: 0 },
                { itemHrid: '/items/alpha_ore', enhancementLevel: 0 },
            ],
            redCredit,
            fixtureIndex,
            fixtureMarket
        );
        assert.deepEqual(
            toPlain(decorations.map((decoration) => [decoration.order, decoration.isBest])),
            [
                [1, true],
                [2, true],
            ]
        );
    });
});

describe('面板放置', () => {
    test('右邊放得下放右邊，再來左邊，都不行就嵌進對話框', () => {
        const choose = GuildCreditAdvisorFeature._choosePlacement;
        assert.deepEqual(toPlain(choose({ left: 500, right: 950, top: 100 }, 360, 1400, 12, 12)), { placement: 'right', left: 962 });
        assert.deepEqual(toPlain(choose({ left: 500, right: 950, top: 100 }, 360, 1300, 12, 12)), { placement: 'left', left: 128 });
        assert.deepEqual(toPlain(choose({ left: 40, right: 440, top: 100 }, 360, 480, 12, 12)), { placement: 'inline', left: 0 });
    });

    test('側邊放置的頂端：對齊對話框但不超出畫面上下邊界', () => {
        const clamp = GuildCreditAdvisorFeature._clampPanelTop;
        assert.equal(clamp(100, 300, 900, 12), 100);
        assert.equal(clamp(5, 300, 900, 12), 12);
        assert.equal(clamp(700, 300, 900, 12), 588);
        assert.equal(clamp(100, 1000, 900, 12), 12);
    });
});

describe('面板 HTML', () => {
    const spriteBase = '/static/media/items_sprite.test.svg';
    const baseContext = (overrides = {}) => ({
        creditItemHrid: redCredit,
        selectedItem: null,
        exchangeState: { batchCount: 1, editingField: null, draft: '' },
        characterItems: [],
        spriteBase,
        ...overrides,
    });
    const readyMarket = { marketJson: fixtureMarket, isLoading: false, hasError: false, isUsingBackup: false };

    test('載入中、無法取得、沒有可買材料', () => {
        const loadingHtml = GuildCreditAdvisorFeature._buildPanelHtml(
            GuildCreditAdvisorFeature._buildAdvisorModel(baseContext(), { marketJson: null, hasError: false }, fixtureIndex, 3)
        );
        assert.match(loadingHtml, /正在載入市場價格…/);
        assert.match(loadingHtml, /公會信用點兌換推薦/);
        assert.match(loadingHtml, /紅色公會信用點/);
        const errorHtml = GuildCreditAdvisorFeature._buildPanelHtml(
            GuildCreditAdvisorFeature._buildAdvisorModel(baseContext(), { marketJson: null, hasError: true }, fixtureIndex, 3)
        );
        assert.match(errorHtml, /無法取得市場價格/);
        const emptyModel = GuildCreditAdvisorFeature._buildAdvisorModel(baseContext(), { marketJson: { marketData: {} } }, fixtureIndex, 3);
        assert.equal(emptyModel.status, 'empty');
        assert.match(GuildCreditAdvisorFeature._buildPanelHtml(emptyModel), /沒有可在市場買到的兌換材料/);
    });

    test('排行：前 N 名、第 1 名加亮、圖示用畫面上的 sprite、下拉選單選中目前數量、提示選物品', () => {
        const model = GuildCreditAdvisorFeature._buildAdvisorModel(baseContext(), readyMarket, fixtureIndex, 3);
        assert.equal(model.status, 'ready');
        assert.equal(model.rankedCount, 4);
        assert.equal(model.accentColor, '#e65d68');
        const html = GuildCreditAdvisorFeature._buildPanelHtml(model);
        assert.equal(countMatches(html, new RegExp(`class="${panelPrefix}-row[ "]`, 'g')), 3);
        assert.equal(countMatches(html, new RegExp(`${panelPrefix}-best`, 'g')), 1);
        assert.match(html, /<use href="\/static\/media\/items_sprite\.test\.svg#alpha_ore"/);
        assert.match(html, /2 個 → 1 點/);
        assert.match(html, /30<small>\/點<\/small>/);
        assert.match(html, /<option value="3" selected>3<\/option>/);
        assert.match(html, /選擇兌換物品後，可比較「賣出再改買」的收益。/);
        assert.match(html, /依市場出售價估算每點成本（未計掛單深度）；賣出以收購價扣 4% 稅/);
        assert.match(html, /市場資料：\d\d\/\d\d \d\d:\d\d/);
        assert.doesNotMatch(html, /可能過期/);
        assert.match(GuildCreditAdvisorFeature._buildPanelHtml({ ...model, isUsingBackupMarket: true }), /（市場資料可能過期）/);
    });

    test('選中前 N 名內的物品：該列加「目前」，結論是已最佳', () => {
        const context = baseContext({ selectedItem: { itemHrid: '/items/alpha_ore', enhancementLevel: 0, count: 4, hash: 'h' } });
        const model = GuildCreditAdvisorFeature._buildAdvisorModel(context, readyMarket, fixtureIndex, 3);
        assert.equal(model.selected.isInTop, true);
        const html = GuildCreditAdvisorFeature._buildPanelHtml(model);
        assert.equal(countMatches(html, new RegExp(`${panelPrefix}-tag">目前<`, 'g')), 1);
        assert.doesNotMatch(html, /目前方案</);
        assert.match(html, /目前方案已是每點成本最低/);
    });

    test('選中前 N 名外的強化物品：另列「目前方案」（虛線、+N、沒出售價顯示 —），結論用 +N 收購價', () => {
        const context = baseContext({ selectedItem: { itemHrid: '/items/delta_ore', enhancementLevel: 3, count: 1, hash: 'h' } });
        const model = GuildCreditAdvisorFeature._buildAdvisorModel(context, readyMarket, fixtureIndex, 3);
        assert.equal(model.selected.isInTop, false);
        assert.equal(model.replacement.status, 'ok');
        // 2000 × 0.96 = 1920 → 128 個 alpha → 64 批 = 64 點；直接 5 點
        assert.equal(model.replacement.difference, 59);
        const html = GuildCreditAdvisorFeature._buildPanelHtml(model);
        assert.match(html, />目前方案</);
        assert.match(html, new RegExp(`${panelPrefix}-current-row`));
        assert.match(html, />\+3</);
        assert.match(html, /title="沒有市場出售價">—</);
        assert.match(html, /賣出目前物品並改買alpha ore，可多兌換 59 點/);
        assert.match(html, /賣出 1 個（收購價 2k，扣 4% 稅）稅後可得 1.92k，可購買 128 個材料換 64 點；直接兌換得 5 點。/);
    });

    test('批數用輸入中的草稿；直接兌換較划算時的文字', () => {
        const context = baseContext({
            selectedItem: { itemHrid: '/items/beta_ore', enhancementLevel: 0, count: 5, hash: 'h' },
            exchangeState: { batchCount: 1, editingField: 'credits', draft: '30' },
        });
        const model = GuildCreditAdvisorFeature._buildAdvisorModel(context, readyMarket, fixtureIndex, 3);
        assert.equal(model.selected.batchCount, 3);
        // 280 × 3 × 0.96 = 806.4 → 53 個 → 26 批 = 26 點；直接 30 點
        assert.equal(model.replacement.difference, -4);
        assert.match(GuildCreditAdvisorFeature._buildPanelHtml(model), /直接兌換較划算；改買alpha ore會少 4 點/);
    });

    test('選中公會代幣：結論改成代幣價值；庫存前 N 名與代幣行（持有數）', () => {
        const context = baseContext({
            selectedItem: { itemHrid: '/items/guild_token', enhancementLevel: 0, count: 25, hash: 'h' },
            characterItems: [inventoryItem('/items/guild_token', 25), inventoryItem('/items/gamma_ore', 7), inventoryItem('/items/alpha_ore', 1)],
        });
        const model = GuildCreditAdvisorFeature._buildAdvisorModel(context, readyMarket, fixtureIndex, 3);
        assert.equal(model.replacement.status, 'guild_token');
        assert.equal(model.selected.isGuildToken, true);
        assert.deepEqual(
            toPlain(model.ownedOptions.map((option) => option.itemHrid)),
            ['/items/gamma_ore']
        );
        assert.deepEqual(toPlain(model.guildToken), {
            creditItemHrid: redCredit,
            tokenCount: 1,
            creditCount: 10,
            bestItemHrid: '/items/alpha_ore',
            bestCostPerCredit: 30,
            valuePerToken: 300,
            ownedCount: 25,
            bestCreditItemHrid: redCredit,
            bestValuePerToken: 300,
        });
        const html = GuildCreditAdvisorFeature._buildPanelHtml(model);
        assert.match(html, /公會代幣不能在市場買賣<\/strong><br>1 個可換 10 點；依目前最低每點成本，每個約值 300。/);
        assert.match(html, /庫存可兌換前 3 名/);
        assert.match(html, /持有 7 · 可兌換 7 批/);
        assert.match(html, /公會代幣：1 個 → 10 點，每個約值 300；這是代幣最划算的用途（持有 25 個）/);
    });

    test('名稱一律跳脫 HTML', () => {
        const trickyIndex = new Map([[redCredit, [{ itemHrid: '/items/x<b>"y', itemCount: 1, creditCount: 1 }]]]);
        const trickyMarket = { marketData: { '/items/x<b>"y': { 0: { a: 5, b: 4 } } } };
        const html = GuildCreditAdvisorFeature._buildPanelHtml(
            GuildCreditAdvisorFeature._buildAdvisorModel(baseContext({ spriteBase: '/s.svg?a="1"' }), { marketJson: trickyMarket }, trickyIndex, 3)
        );
        assert.doesNotMatch(html, /<b>/);
        assert.match(html, /x&lt;b&gt;&quot;y/);
        assert.match(html, /href="\/s\.svg\?a=&quot;1&quot;#x&lt;b&gt;&quot;y"/);
    });

    test('沒有 sprite 位址時圖示用「?」', () => {
        const html = GuildCreditAdvisorFeature._buildPanelHtml(GuildCreditAdvisorFeature._buildAdvisorModel(baseContext({ spriteBase: '' }), readyMarket, fixtureIndex, 1));
        assert.match(html, new RegExp(`<span class="${panelPrefix}-icon" aria-hidden="true">\\?</span>`));
        assert.doesNotMatch(html, /<svg/);
    });

    test('英文介面', () => {
        const context = baseContext({ selectedItem: { itemHrid: '/items/delta_ore', enhancementLevel: 0, count: 2, hash: 'h' } });
        const html = englishFeature._buildPanelHtml(englishFeature._buildAdvisorModel(context, readyMarket, fixtureIndex, 3));
        assert.match(html, /Guild Credit Exchange/);
        assert.match(html, /Red Guild Credit/);
        assert.match(html, /2 items → 1 credit</);
        assert.match(html, /Selected option/);
        assert.match(html, /Sell the selected items and buy alpha ore to get \d+ more credits/);
        assert.match(html, /Market data: /);
        assert.doesNotMatch(html, /[\u4e00-\u9fff]/);
    });
});

describe('讀遊戲情境', () => {
    test('物品雜湊「角色::地點::物品::等級」', () => {
        assert.deepEqual(toPlain(GuildCreditAdvisorFeature._parseItemHash('123::/item_locations/inventory::/items/gator_vest::2')), {
            itemLocationHrid: '/item_locations/inventory',
            itemHrid: '/items/gator_vest',
            enhancementLevel: 2,
        });
        assert.equal(GuildCreditAdvisorFeature._parseItemHash('bad'), null);
        assert.equal(GuildCreditAdvisorFeature._parseItemHash('1::loc::/items/x::-1'), null);
        assert.equal(GuildCreditAdvisorFeature._parseItemHash('1::loc::notItem::0'), null);
        assert.equal(GuildCreditAdvisorFeature._parseItemHash(null), null);
    });

    test('物品格：先讀 Item 元件 props，沒有 fiber 就讀 <use href="…#物品"> 與 +N 文字', () => {
        const withFiber = {
            '__reactFiber$test': {
                memoizedProps: { className: 'Item_itemContainer__x7kH1' },
                return: { memoizedProps: { itemHrid: '/items/gator_vest', enhancementLevel: 2, count: 3, hash: 'h1' }, return: null },
            },
            querySelector: () => null,
        };
        assert.deepEqual(toPlain(GuildCreditAdvisorFeature._readItemFromElement(withFiber)), { itemHrid: '/items/gator_vest', enhancementLevel: 2, count: 3, hash: 'h1' });
        const useElement = { getAttribute: (name) => (name === 'href' ? '/static/media/items_sprite.abc.svg#tome_of_healing' : null) };
        const levelElement = { textContent: '+3' };
        const domOnly = { querySelector: (selector) => (selector === 'use' ? useElement : selector.includes('Item_enhancementLevel') ? levelElement : null) };
        assert.deepEqual(toPlain(GuildCreditAdvisorFeature._readItemFromElement(domOnly)), { itemHrid: '/items/tome_of_healing', enhancementLevel: 3, count: 0, hash: null });
        assert.equal(GuildCreditAdvisorFeature._readItemFromElement({ querySelector: () => null }), null);
        assert.equal(GuildCreditAdvisorFeature._readItemFromElement(null), null);
    });

    function createGuildPanelModal(state, characterItemMap) {
        const guildPanel = { state, props: { characterItemMap, t: (key) => key }, getConvertibleItems: () => [] };
        const spriteUse = { getAttribute: (name) => (name === 'href' ? '/static/media/items_sprite.f58c9476.svg#red_guild_credit' : null) };
        const modalElement = {
            '__reactFiber$test': {
                stateNode: null,
                memoizedProps: { className: 'GuildPanel_exchangeModalContent__aQqyL' },
                return: { stateNode: { props: {} }, return: { stateNode: guildPanel, return: null } },
            },
            querySelector: (selector) => (selector.includes('items_sprite') ? spriteUse : null),
        };
        return { guildPanel, modalElement };
    }

    test('從 GuildPanel 的 state 讀信用點、選中物品（含持有數）、批數草稿與 sprite 位址', () => {
        const selectedHash = '123::/item_locations/inventory::/items/tome_of_healing::0';
        const characterItemMap = new Map([
            [selectedHash, inventoryItem('/items/tome_of_healing', 2)],
            ['other', inventoryItem('/items/gator_vest', 3)],
        ]);
        const state = { exchangeCreditTypeHrid: redCredit, exchangeItemHash: selectedHash, exchangeBatchCount: 2, exchangeEditingField: 'items', exchangeDraft: '1' };
        const { guildPanel, modalElement } = createGuildPanelModal(state, characterItemMap);
        const context = GuildCreditAdvisorFeature._readExchangeContext(modalElement);
        assert.equal(context.guildPanel, guildPanel);
        assert.equal(context.creditItemHrid, redCredit);
        assert.deepEqual(toPlain(context.selectedItem), { itemHrid: '/items/tome_of_healing', enhancementLevel: 0, count: 2, hash: selectedHash });
        assert.deepEqual([context.exchangeState.batchCount, context.exchangeState.editingField, context.exchangeState.draft], [2, 'items', '1']);
        assert.equal(context.characterItems.length, 2);
        assert.equal(context.spriteBase, '/static/media/items_sprite.f58c9476.svg');
        // 情境鍵：草稿改了就不同
        const key = GuildCreditAdvisorFeature._buildContextKey(context);
        assert.notEqual(GuildCreditAdvisorFeature._buildContextKey({ ...context, exchangeState: { ...context.exchangeState, draft: '2' } }), key);
        assert.equal(GuildCreditAdvisorFeature._buildContextKey({ ...context }), key);
    });

    test('Map 裡已經沒有選中的物品：跟遊戲一樣當作沒選；沒有 Map（遊戲改版）就拆雜湊', () => {
        const selectedHash = '123::/item_locations/inventory::/items/gator_vest::0';
        const state = { exchangeCreditTypeHrid: redCredit, exchangeItemHash: selectedHash, exchangeBatchCount: 1, exchangeEditingField: null, exchangeDraft: '' };
        const missing = createGuildPanelModal(state, new Map());
        assert.equal(GuildCreditAdvisorFeature._readExchangeContext(missing.modalElement).selectedItem, null);
        const withoutMap = createGuildPanelModal(state, undefined);
        assert.deepEqual(toPlain(GuildCreditAdvisorFeature._readExchangeContext(withoutMap.modalElement).selectedItem), {
            itemHrid: '/items/gator_vest',
            enhancementLevel: 0,
            count: 0,
            hash: selectedHash,
        });
        const closed = createGuildPanelModal({ ...state, exchangeCreditTypeHrid: null }, new Map());
        assert.equal(GuildCreditAdvisorFeature._readExchangeContext(closed.modalElement).creditItemHrid, null);
    });

    test('拿不到 React 資料時從畫面讀：箭頭右邊的信用點、選擇器裡的物品、第一個輸入框當 items 草稿', () => {
        const iconOf = (key) => ({ getAttribute: (name) => (name === 'href' ? `/static/media/items_sprite.abc.svg#${key}` : null) });
        const creditElement = { querySelector: (selector) => (selector === 'use' ? iconOf('red_guild_credit') : null) };
        const selectedElement = { querySelector: (selector) => (selector === 'use' ? iconOf('tome_of_healing') : null) };
        const modalElement = {
            querySelector: (selector) => {
                if (selector.includes('GuildPanel_exchangeRow')) return creditElement;
                if (selector.includes('ItemSelector_itemSelector')) return selectedElement;
                if (selector.includes('GuildPanel_inputContainer')) return { value: '2' };
                if (selector.includes('items_sprite')) return iconOf('red_guild_credit');
                return null;
            },
        };
        const context = GuildCreditAdvisorFeature._readExchangeContext(modalElement);
        assert.equal(context.guildPanel, null);
        assert.equal(context.creditItemHrid, redCredit);
        assert.equal(context.selectedItem.itemHrid, '/items/tome_of_healing');
        assert.deepEqual([context.exchangeState.editingField, context.exchangeState.draft], ['items', '2']);
        assert.equal(context.spriteBase, '/static/media/items_sprite.abc.svg');
    });

    test('只裝飾兌換視窗的選單：比對 ItemSelector 的 getItemSelectionsFunc', () => {
        const guildPanel = { getConvertibleItems: () => [] };
        const menuWith = (getItemSelectionsFunc) => ({
            '__reactFiber$test': { memoizedProps: { className: 'ItemSelector_menu__12sEM' }, return: { memoizedProps: {}, return: { memoizedProps: { getItemSelectionsFunc }, return: null } } },
        });
        assert.equal(GuildCreditAdvisorFeature._isExchangeMenu(menuWith(guildPanel.getConvertibleItems), guildPanel), true);
        assert.equal(GuildCreditAdvisorFeature._isExchangeMenu(menuWith(() => []), guildPanel), false);
        assert.equal(GuildCreditAdvisorFeature._isExchangeMenu({ '__reactFiber$test': { memoizedProps: {}, return: null } }, guildPanel), false);
        // 拿不到 fiber 或 GuildPanel：兌換視窗的遮罩擋住其他選單，視為兌換選單
        assert.equal(GuildCreditAdvisorFeature._isExchangeMenu({}, guildPanel), true);
        assert.equal(GuildCreditAdvisorFeature._isExchangeMenu(menuWith(() => []), null), true);
    });
});

describe('收到訊息與畫面更新', () => {
    test('items_updated / init_character_data 讓庫存版本加一；init_client_data 讓遊戲資料版本加一；其他訊息不變', () => {
        const inventoryVersion = GuildCreditAdvisorFeature._inventoryVersion;
        const clientDataVersion = GuildCreditAdvisorFeature._clientDataVersion;
        chineseHooks.feedMessage({ type: 'items_updated', endCharacterItems: [inventoryItem('/items/gator_vest', 3)] });
        assert.equal(GuildCreditAdvisorFeature._inventoryVersion, inventoryVersion + 1);
        GuildCreditAdvisorFeature.handleMessage({ type: 'init_character_data' });
        assert.equal(GuildCreditAdvisorFeature._inventoryVersion, inventoryVersion + 2);
        GuildCreditAdvisorFeature.handleMessage({ type: 'init_client_data' });
        assert.equal(GuildCreditAdvisorFeature._clientDataVersion, clientDataVersion + 1);
        chineseHooks.feedMessage({ type: 'chat_message_received' });
        assert.equal(GuildCreditAdvisorFeature._inventoryVersion, inventoryVersion + 2);
    });

    test('設定關閉：收到訊息、畫面變動都什麼都不做', () => {
        const setting = chineseHooks.settingsMap.guildCreditConversionsSort;
        const inventoryVersion = GuildCreditAdvisorFeature._inventoryVersion;
        setting.isTrue = false;
        try {
            chineseHooks.feedMessage({ type: 'items_updated', endCharacterItems: [] });
            GuildCreditAdvisorFeature.handleDomChange();
            assert.equal(GuildCreditAdvisorFeature._inventoryVersion, inventoryVersion);
            assert.equal(GuildCreditAdvisorFeature._panelElement, null);
        } finally {
            setting.isTrue = true;
        }
    });

    test('沒有兌換視窗時畫面更新不建立面板', () => {
        GuildCreditAdvisorFeature.handleDomChange();
        assert.equal(GuildCreditAdvisorFeature._panelElement, null);
    });
});

describe('真實遊戲資料 + 腳本內建市場備份（不連網）', () => {
    before(async () => {
        GuildCreditAdvisorFeature._ensureMarketJson();
        assert.ok(await waitFor(() => GuildCreditAdvisorFeature._marketJson), '應該載入腳本內建的市場備份');
    });

    test('市價載入後 1 小時內不重抓；用的是備份所以註腳要提醒可能過期', () => {
        const loadedAt = GuildCreditAdvisorFeature._marketJsonLoadedAt;
        assert.equal(GuildCreditAdvisorFeature._isMarketUsingBackup, true);
        assert.equal(GuildCreditAdvisorFeature._hasMarketError, false);
        GuildCreditAdvisorFeature._ensureMarketJson();
        assert.equal(GuildCreditAdvisorFeature._isMarketLoading, false);
        assert.equal(GuildCreditAdvisorFeature._marketJsonLoadedAt, loadedAt);
    });

    test('紅色信用點排行：鱷魚馬甲 3.6k、治療之書 3.8k、基礎攻擊護符 4.2k', () => {
        const ranked = GuildCreditAdvisorFeature._rankOptions(GuildCreditAdvisorFeature._getConversionIndex().get(redCredit), GuildCreditAdvisorFeature._marketJson);
        assert.deepEqual(
            toPlain(ranked.slice(0, 3).map((option) => [option.itemHrid, option.costPerCredit])),
            [
                ['/items/gator_vest', 3600],
                ['/items/tome_of_healing', 3800],
                ['/items/basic_attack_charm', 4200],
            ]
        );
    });

    test('公會代幣換金色信用點最划算（每個 10k），其次銀色 6.45k、紫色 6k', () => {
        const tokenValues = GuildCreditAdvisorFeature._computeGuildTokenValues(GuildCreditAdvisorFeature._getConversionIndex(), GuildCreditAdvisorFeature._marketJson);
        assert.equal(tokenValues.length, 8);
        assert.deepEqual(
            toPlain(tokenValues.slice(0, 3).map((entry) => [entry.creditItemHrid, entry.valuePerToken])),
            [
                ['/items/gold_guild_credit', 10000],
                ['/items/silver_guild_credit', 6450],
                ['/items/purple_guild_credit', 6000],
            ]
        );
    });

    test('賣 1 個基礎攻擊護符改買鱷魚馬甲：820k × 0.96 = 787.2k → 43 件 → 215 點，比直接兌換多 15 點', () => {
        const context = {
            creditItemHrid: redCredit,
            selectedItem: { itemHrid: '/items/basic_attack_charm', enhancementLevel: 0, count: 1, hash: 'h' },
            exchangeState: { batchCount: 1, editingField: null, draft: '' },
            characterItems: [inventoryItem('/items/basic_attack_charm', 1), inventoryItem('/items/gator_vest', 3), inventoryItem('/items/guild_token', 25)],
            spriteBase: '/static/media/items_sprite.f58c9476.svg',
        };
        const model = GuildCreditAdvisorFeature._buildAdvisorModel(
            context,
            GuildCreditAdvisorFeature._getMarketState(),
            GuildCreditAdvisorFeature._getConversionIndex(),
            3
        );
        assert.equal(model.selected.isInTop, true);
        assert.deepEqual(
            [model.replacement.status, model.replacement.purchasedItems, model.replacement.replacementCredits, model.replacement.difference],
            ['ok', 43, 215, 15]
        );
        assert.deepEqual(
            toPlain(model.ownedOptions.map((option) => option.itemHrid)),
            ['/items/gator_vest', '/items/basic_attack_charm']
        );
        const html = GuildCreditAdvisorFeature._buildPanelHtml(model);
        assert.match(html, /賣出目前物品並改買鱷魚馬甲，可多兌換 15 點/);
        assert.match(html, /公會代幣：1 個 → 1 點，每個約值 3.6k；換成金色公會信用點最划算，每個約值 10k（持有 25 個）/);
        assert.match(html, /（市場資料可能過期）/);
    });
});
