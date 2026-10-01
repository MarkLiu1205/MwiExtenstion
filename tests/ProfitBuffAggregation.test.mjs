// 收益計算的加成合併：照遊戲 calculateBuffsForAction / getTimeCost 等公式（node --test 'tests/*.test.mjs'）
// 遊戲做法：8 個來源（mooPass / community / house / guild / achievement / consumable / equipment / personal）
// 依動作類型串成一份清單後依類型加總；任務徽章加成只加在進行中的隨機動作任務上
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadProfitScript } from './ProfitScriptLoader.mjs';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const readGameData = fileName => JSON.parse(readFileSync(join(repositoryRoot, 'simulator/src/combatsimulator/data', fileName), 'utf8'));
const itemDetailMap = readGameData('itemDetailMap.json');
const actionDetailMap = readGameData('actionDetailMap.json');
const openableLootDropMap = readGameData('openableLootDropMap.json');

// PROFIT_SCRIPT_PATH 可指定要測的檔案（例如拿修正前的版本確認測試抓得到問題）
const profitScript = loadProfitScript(process.env.PROFIT_SCRIPT_PATH || join(repositoryRoot, 'profit.js'));
const { globals, ProfitCaculation, handleMessage, validateProfitSettings, renderBuffSourceRows } = profitScript;

const MILKING = '/action_types/milking';
const COOKING = '/action_types/cooking';
const cowMilking = actionDetailMap['/actions/milking/cow']; // 需求 1 級、6 秒
const verdantCowMilking = actionDetailMap['/actions/milking/verdant_cow']; // 需求 10 級、8 秒
const donutCooking = actionDetailMap['/actions/cooking/donut']; // 需求 1 級、6 秒

const marketJson = (() => {
    const market = {};
    for (const item of Object.values(itemDetailMap)) {
        if (item.isTradable) market[item.name] = { ask: item.sellPrice * 2 + 10, bid: item.sellPrice * 2 };
    }
    return { market };
})();

const buff = (typeHrid, flatBoost, ratioBoost = 0) => ({ typeHrid: `/buff_types/${typeHrid}`, flatBoost, ratioBoost });
const feed = message => handleMessage(JSON.stringify(message));

// 登入訊息：預設沒有任何加成、技能等級 = 需求等級（等級效率 0），方便驗證倍率
function initCharacterData(overrides = {}) {
    return {
        type: 'init_character_data',
        characterSkills: [
            { skillHrid: '/skills/milking', level: 1 },
            { skillHrid: '/skills/cooking', level: 1 },
        ],
        actionTypeDrinkSlotsMap: { [MILKING]: [], [COOKING]: [] },
        characterHouseRoomMap: {},
        characterItems: [],
        communityActionTypeBuffsMap: {},
        consumableActionTypeBuffsMap: {},
        houseActionTypeBuffsMap: {},
        equipmentActionTypeBuffsMap: {},
        achievementActionTypeBuffsMap: {},
        personalActionTypeBuffsMap: {},
        mooPassActionTypeBuffsMap: {},
        noncombatStats: {},
        combatUnit: { combatDetails: { combatStats: { drinkSlots: 2 } } },
        characterQuests: [],
        equipmentTaskActionBuffs: [],
        ...overrides,
    };
}

const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message ?? ''} 預期 ${expected}，實際 ${actual}`);
const milkCount = result => result.outputItems.find(item => item.itemHrid === '/items/milk').count;
const essenceCount = result => result.outputItems.find(item => item.itemHrid === '/items/milking_essence').count;
const drinkEntries = result => result.inputItems.filter(item => item.countPerHour !== undefined && item.count !== undefined && !item.itemHrid);

beforeEach(() => {
    globals.initClientData_actionDetailMap = actionDetailMap;
    globals.initClientData_itemDetailMap = itemDetailMap;
    globals.initClientData_openableLootDropMap = openableLootDropMap;
    globals.initClientData_personalBuffTypeDetailMap = {};
    globals.profitSettings = validateProfitSettings({});
    feed(initCharacterData());
});

describe('公會加成（以前完全沒算）', () => {
    test('效率與行動速度：6 秒的動作、公會 +5% / +5% → 3600 / (6/1.05) × 1.05 = 661.5 次/小時', () => {
        assert.equal(ProfitCaculation(cowMilking, marketJson).actionPerHour, 600);
        feed(initCharacterData({ guildActionTypeBuffsMap: { [MILKING]: [buff('efficiency', 0.05), buff('action_speed', 0.05)] } }));
        close(ProfitCaculation(cowMilking, marketJson).actionPerHour, 661.5);
    });

    test('guild_buffs_updated 會更新；退出公會（沒有這個欄位）時清成空的', () => {
        feed({ type: 'guild_buffs_updated', guildActionTypeBuffsMap: { [MILKING]: [buff('efficiency', 0.1)] } });
        close(ProfitCaculation(cowMilking, marketJson).actionPerHour, 660);
        feed({ type: 'guild_buffs_updated' });
        assert.equal(ProfitCaculation(cowMilking, marketJson).actionPerHour, 600);
    });

    test('精華發現 / 經驗：公會的 essence_find、wisdom 也算進去', () => {
        const baseline = ProfitCaculation(cowMilking, marketJson);
        feed({ type: 'guild_buffs_updated', guildActionTypeBuffsMap: { [MILKING]: [buff('essence_find', 0.3), buff('wisdom', 0.1)] } });
        const withGuild = ProfitCaculation(cowMilking, marketJson);
        close(essenceCount(withGuild) / essenceCount(baseline), 1.3);
        close(withGuild.expPerAction / baseline.expPerAction, 1.1, '經驗');
    });
});

describe('產量加成', () => {
    test('採集：裝備的採集首飾（gathering）也乘進 dropTable（以前漏掉）', () => {
        const baseline = ProfitCaculation(cowMilking, marketJson);
        feed({ type: 'equipment_buffs_updated', equipmentActionTypeBuffsMap: { [MILKING]: [buff('gathering', 0.02)] }, equipmentTaskActionBuffs: [] });
        close(milkCount(ProfitCaculation(cowMilking, marketJson)) / milkCount(baseline), 1.02);
    });

    test('美食只乘生產的 outputItems；採集量只乘採集的 dropTable（兩者分開）', () => {
        feed(initCharacterData({
            communityActionTypeBuffsMap: { [MILKING]: [buff('gourmet', 0.5)], [COOKING]: [buff('gathering', 0.5)] },
        }));
        // 錯放的加成類型不應該有作用
        assert.equal(milkCount(ProfitCaculation(cowMilking, marketJson)), 2);
        assert.equal(ProfitCaculation(donutCooking, marketJson).outputItems[0].count, 1);

        feed(initCharacterData({
            communityActionTypeBuffsMap: { [MILKING]: [buff('gathering', 0.2)], [COOKING]: [buff('gourmet', 0.12)] },
        }));
        close(milkCount(ProfitCaculation(cowMilking, marketJson)), 2 * 1.2);
        close(ProfitCaculation(donutCooking, marketJson).outputItems[0].count, 1.12);
    });
});

describe('成就加成', () => {
    test('achievements_updated（只帶成就清單）不會把成就加成清掉；achievement_buffs_updated 才會更新', () => {
        feed(initCharacterData({ achievementActionTypeBuffsMap: { [MILKING]: [buff('efficiency', 0.02)] } }));
        close(ProfitCaculation(cowMilking, marketJson).actionPerHour, 612);
        feed({ type: 'achievements_updated', achievements: [] });
        close(ProfitCaculation(cowMilking, marketJson).actionPerHour, 612);
        feed({ type: 'achievement_buffs_updated', achievementActionTypeBuffsMap: {} });
        assert.equal(ProfitCaculation(cowMilking, marketJson).actionPerHour, 600);
    });
});

describe('等級效率', () => {
    test('工匠茶 +5 需求等級、等級剛好等於需求：效率是 0，不是 −5%；也不能開始做', () => {
        feed(initCharacterData({ consumableActionTypeBuffsMap: { [COOKING]: [buff('artisan', 0.1), buff('action_level', 5)] } }));
        const result = ProfitCaculation(donutCooking, marketJson);
        assert.equal(result.levelEffBuff, 0);
        assert.equal(result.actionPerHour, 600);
        assert.equal(result.levelEnough, false);
    });

    test('技能茶 +3 級、工匠茶 +5：(等級 + 3) − (需求 + 5)，每級 1%；小數等級不取整', () => {
        feed(initCharacterData({
            characterSkills: [{ skillHrid: '/skills/milking', level: 1 }, { skillHrid: '/skills/cooking', level: 20 }],
            consumableActionTypeBuffsMap: { [COOKING]: [buff('cooking_level', 3.3), buff('action_level', 5)] },
        }));
        const result = ProfitCaculation(donutCooking, marketJson);
        close(result.levelEffBuff, 20 + 3.3 - (1 + 5));
        assert.equal(result.levelEnough, true);
    });

    test('等級比例加成（ratioBoost）：(1 + ratio) × 等級', () => {
        feed(initCharacterData({
            characterSkills: [{ skillHrid: '/skills/milking', level: 50 }, { skillHrid: '/skills/cooking', level: 1 }],
            equipmentActionTypeBuffsMap: { [MILKING]: [buff('milking_level', 0, 0.1)] },
        }));
        close(ProfitCaculation(cowMilking, marketJson).levelEffBuff, 50 * 1.1 - 1);
    });

    test('沒有加成時：等級高於需求每級 1%，低於需求為 0', () => {
        feed(initCharacterData({ characterSkills: [{ skillHrid: '/skills/milking', level: 9 }, { skillHrid: '/skills/cooking', level: 1 }] }));
        close(ProfitCaculation(cowMilking, marketJson).levelEffBuff, 8);
        const belowRequirement = ProfitCaculation(verdantCowMilking, marketJson);
        assert.equal(belowRequirement.levelEffBuff, 0);
        assert.equal(belowRequirement.levelEnough, false);
    });
});

describe('任務加速', () => {
    const milkingTask = (status, id = 1) => ({
        id,
        category: '/quest_category/random_task',
        type: '/quest_type/action',
        status,
        actionHrid: '/actions/milking/cow',
    });

    test('只對進行中的隨機動作任務的動作生效，而且跟一般行動速度相乘', () => {
        feed(initCharacterData({
            equipmentTaskActionBuffs: [buff('task_action_speed', 0.1)],
            equipmentActionTypeBuffsMap: { [MILKING]: [buff('action_speed', 0.1)] },
            characterQuests: [milkingTask('/quest_status/in_progress')],
        }));
        // 6 / 1.1 / 1.1（相乘）而不是 6 / 1.2（相加）
        close(ProfitCaculation(cowMilking, marketJson).actionPerHour, 3600 / (6 / 1.1 / 1.1));
        // 沒有任務的動作只吃一般速度
        close(ProfitCaculation(verdantCowMilking, marketJson).actionPerHour, 3600 / (8 / 1.1));
    });

    test('任務領取後（action_completed / quests_updated 帶 claimed）不再加速', () => {
        feed(initCharacterData({
            equipmentTaskActionBuffs: [buff('task_action_speed', 0.1)],
            characterQuests: [milkingTask('/quest_status/in_progress')],
        }));
        close(ProfitCaculation(cowMilking, marketJson).actionPerHour, 660);
        feed({ type: 'action_completed', endCharacterQuests: [milkingTask('/quest_status/claimed')] });
        assert.equal(ProfitCaculation(cowMilking, marketJson).actionPerHour, 600);
        feed({ type: 'quests_updated', endCharacterQuests: [milkingTask('/quest_status/in_progress', 2)] });
        close(ProfitCaculation(cowMilking, marketJson).actionPerHour, 660);
    });

    test('equipment_buffs_updated 會更新任務徽章的加成', () => {
        feed(initCharacterData({ characterQuests: [milkingTask('/quest_status/in_progress')] }));
        assert.equal(ProfitCaculation(cowMilking, marketJson).actionPerHour, 600);
        feed({ type: 'equipment_buffs_updated', equipmentActionTypeBuffsMap: {}, equipmentTaskActionBuffs: [buff('task_action_speed', 0.2)] });
        close(ProfitCaculation(cowMilking, marketJson).actionPerHour, 720);
    });
});

describe('飲料成本', () => {
    const teaSlots = (...itemHrids) => itemHrids.map(itemHrid => ({ itemHrid }));

    test('只算可用槽數（1 + 袋子的 drinkSlots）內的茶', () => {
        feed(initCharacterData({
            actionTypeDrinkSlotsMap: { [MILKING]: teaSlots('/items/gathering_tea', '/items/efficiency_tea', '/items/wisdom_tea'), [COOKING]: [] },
            combatUnit: { combatDetails: { combatStats: { drinkSlots: 1 } } },
        }));
        assert.equal(drinkEntries(ProfitCaculation(cowMilking, marketJson)).length, 2);
    });

    test('換茶（action_type_consumable_slots_updated）會更新成本', () => {
        feed(initCharacterData({ actionTypeDrinkSlotsMap: { [MILKING]: teaSlots('/items/gathering_tea'), [COOKING]: [] } }));
        const before = ProfitCaculation(cowMilking, marketJson);
        assert.equal(drinkEntries(before).length, 1);
        feed({ type: 'action_type_consumable_slots_updated', actionTypeDrinkSlotsMap: { [MILKING]: teaSlots('/items/gathering_tea', '/items/wisdom_tea'), [COOKING]: [] } });
        const after = ProfitCaculation(cowMilking, marketJson);
        assert.equal(drinkEntries(after).length, 2);
        assert.ok(after.expendPerHour > before.expendPerHour);
    });

    test('換袋子（character_stats_updated）：飲料濃度改變每小時杯數，槽數改變計入的茶', () => {
        feed(initCharacterData({
            actionTypeDrinkSlotsMap: { [MILKING]: teaSlots('/items/gathering_tea', '/items/wisdom_tea'), [COOKING]: [] },
            combatUnit: { combatDetails: { combatStats: { drinkSlots: 0 } } },
        }));
        const before = drinkEntries(ProfitCaculation(cowMilking, marketJson));
        assert.equal(before.length, 1);
        close(before[0].countPerHour, 12);
        feed({ type: 'character_stats_updated', noncombatStats: { drinkConcentration: 0.1 }, combatUnit: { combatDetails: { combatStats: { drinkSlots: 1 } } } });
        const after = drinkEntries(ProfitCaculation(cowMilking, marketJson));
        assert.equal(after.length, 2);
        close(after[0].countPerHour, 13.2);
    });
});

describe('加工換算對照', () => {
    test('只收真正的加工（原料 → 加工品），不含迷宮、寶石研磨等分類', () => {
        assert.equal(globals.processingMap['/items/milk']?.hrid, '/actions/cheesesmithing/cheese');
        assert.equal(globals.processingMap['/items/log']?.hrid, '/actions/crafting/lumber');
        assert.equal(globals.processingMap['/items/cotton']?.hrid, '/actions/tailoring/cotton_fabric');
        // 迷宮（起司 → 信標）、特殊（琥珀 → 琥珀粉）不是加工茶的換算
        assert.equal(globals.processingMap['/items/cheese'], undefined);
        assert.equal(globals.processingMap['/items/amber'], undefined);
    });
});

describe('加成來源表', () => {
    test('有公會列與合計列；合計的效率含等級效率；生產的數量欄顯示美食', () => {
        feed(initCharacterData({
            characterSkills: [{ skillHrid: '/skills/milking', level: 1 }, { skillHrid: '/skills/cooking', level: 11 }],
            guildActionTypeBuffsMap: { [COOKING]: [buff('efficiency', 0.05)] },
            consumableActionTypeBuffsMap: { [COOKING]: [buff('gourmet', 0.12)] },
        }));
        const html = renderBuffSourceRows(ProfitCaculation(donutCooking, marketJson));
        assert.match(html, /公會|Guild/);
        assert.match(html, /合計|Total/);
        // 合計效率 = 公會 5% + 等級 10%
        assert.match(html, /\+15%/);
        assert.match(html, /\+12%/);
    });

    test('格子的 data-tooltip 經過 JSON 序列化（Buff 只留提示框讀的欄位）再讀回來，畫出的表跟原本一樣', () => {
        feed(initCharacterData({
            guildActionTypeBuffsMap: { [MILKING]: [buff('efficiency', 0.05), buff('rare_find', 0.15)] },
            consumableActionTypeBuffsMap: { [MILKING]: [buff('gathering', 0.15), buff('milking_level', 3), buff('wisdom', 0.12)] },
            equipmentTaskActionBuffs: [buff('task_action_speed', 0.1)],
            characterQuests: [{ id: 1, category: '/quest_category/random_task', type: '/quest_type/action', status: '/quest_status/in_progress', actionHrid: '/actions/milking/cow' }],
        }));
        const result = ProfitCaculation(cowMilking, marketJson);
        const roundTripped = JSON.parse(JSON.stringify(result));
        assert.equal(renderBuffSourceRows(roundTripped), renderBuffSourceRows(result));
        assert.equal(roundTripped.totalBuff.skillLevelFlat, undefined);
        assert.equal(roundTripped.totalBuff.artisan, 0);
    });
});

describe('面板重繪時機', () => {
    test('換茶、換袋子、任務變動不同步重繪，標記後交給每秒刷新一起處理', () => {
        globals.hasMarketItemUpdate = false;
        feed({ type: 'action_type_consumable_slots_updated', actionTypeDrinkSlotsMap: { [MILKING]: [{ itemHrid: '/items/gathering_tea' }] } });
        assert.equal(globals.hasMarketItemUpdate, true);

        globals.hasMarketItemUpdate = false;
        feed({ type: 'character_stats_updated', noncombatStats: { drinkConcentration: 0 }, combatUnit: { combatDetails: { combatStats: { drinkSlots: 2 } } } });
        assert.equal(globals.hasMarketItemUpdate, false, '濃度與槽數都沒變，不必重繪');
        feed({ type: 'character_stats_updated', noncombatStats: { drinkConcentration: 0.1 }, combatUnit: { combatDetails: { combatStats: { drinkSlots: 2 } } } });
        assert.equal(globals.hasMarketItemUpdate, true);
    });
});
