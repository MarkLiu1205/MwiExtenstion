// 收益面板「模擬卷軸收益」測試：node --test tests/
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadProfitScript } from './ProfitScriptLoader.mjs';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const gameDataDirectory = join(repositoryRoot, 'simulator/src/combatsimulator/data');
const readGameData = fileName => JSON.parse(readFileSync(join(gameDataDirectory, fileName), 'utf8'));

const actionDetailMap = readGameData('actionDetailMap.json');
const itemDetailMap = readGameData('itemDetailMap.json');
const openableLootDropMap = readGameData('openableLootDropMap.json');

const skillingActionTypes = ['milking', 'foraging', 'woodcutting', 'cheesesmithing', 'crafting', 'tailoring', 'cooking', 'brewing'].map(name => `/action_types/${name}`);
const toUsableMap = actionTypes => Object.fromEntries(actionTypes.map(actionType => [actionType, true]));

// 遊戲實際數值由伺服器 init_client_data 下發，這裡用固定假值驗證計算邏輯
const personalBuffTypeDetailMap = {
    '/personal_buff_types/gourmet': {
        hrid: '/personal_buff_types/gourmet',
        buff: { typeHrid: '/buff_types/gourmet', flatBoost: 0.1 },
        usableInActionTypeMap: toUsableMap(['/action_types/cooking', '/action_types/brewing'])
    },
    '/personal_buff_types/efficiency': {
        hrid: '/personal_buff_types/efficiency',
        buff: { typeHrid: '/buff_types/efficiency', flatBoost: 0.12 },
        usableInActionTypeMap: toUsableMap(skillingActionTypes)
    },
    '/personal_buff_types/action_speed': {
        hrid: '/personal_buff_types/action_speed',
        buff: { typeHrid: '/buff_types/action_speed', flatBoost: 0.15 },
        usableInActionTypeMap: toUsableMap(skillingActionTypes)
    },
    '/personal_buff_types/rare_find': {
        hrid: '/personal_buff_types/rare_find',
        buff: { typeHrid: '/buff_types/rare_find', flatBoost: 0.5 },
        usableInActionTypeMap: toUsableMap(skillingActionTypes)
    }
};

function createMarketJson() {
    const market = {};
    for (const item of Object.values(itemDetailMap)) {
        if (item.isTradable) market[item.name] = { ask: item.sellPrice * 2 + 10, bid: item.sellPrice * 2 };
    }
    return { market };
}

const profitScript = loadProfitScript(join(repositoryRoot, 'profit.js'));
const { globals, buffs, ProfitCaculation, mergeSimulatedScrollBuffs, toggleScrollKey, validateProfitSettings, generateScrollBuffButtons } = profitScript;
const marketJson = createMarketJson();
const cowMilking = actionDetailMap['/actions/milking/cow'];
const donutCooking = actionDetailMap['/actions/cooking/donut'];

function setPersonalBuffs(personalActionTypeBuffsMap) {
    globals.initCharacterData_personalActionTypeBuffsMap = personalActionTypeBuffsMap;
    buffs.updateBuffCache('personal', personalActionTypeBuffsMap);
}

beforeEach(() => {
    globals.initClientData_actionDetailMap = actionDetailMap;
    globals.initClientData_itemDetailMap = itemDetailMap;
    globals.initClientData_openableLootDropMap = openableLootDropMap;
    globals.initClientData_personalBuffTypeDetailMap = personalBuffTypeDetailMap;
    // 等級剛好等於需求等級：等級效率為 0，方便算倍率
    globals.initCharacterData_characterSkills = [{ skillHrid: '/skills/milking', level: 1 }, { skillHrid: '/skills/cooking', level: 1 }];
    globals.initCharacterData_actionTypeDrinkSlotsMap = Object.fromEntries(skillingActionTypes.map(actionType => [actionType, []]));
    globals.initCharacterData_noncombatStats = {};
    setPersonalBuffs({});
    globals.profitSettings = validateProfitSettings({});
});

describe('mergeSimulatedScrollBuffs', () => {
    test('沒勾卷軸：回傳原本的加成（複製，不是同一個陣列）', () => {
        const personalBuffList = [{ typeHrid: '/buff_types/wisdom', flatBoost: 0.1 }];
        const merged = mergeSimulatedScrollBuffs(personalBuffList, '/action_types/milking', [], itemDetailMap, personalBuffTypeDetailMap);
        // 沙盒陣列屬於另一個 realm，先展開成本地陣列再比對內容
        assert.deepEqual([...merged], personalBuffList);
        assert.notEqual(merged, personalBuffList);
    });

    test('勾效率卷軸：加上效率加成，且不改動傳入的陣列', () => {
        const personalBuffList = [];
        const merged = mergeSimulatedScrollBuffs(personalBuffList, '/action_types/milking', ['efficiency'], itemDetailMap, personalBuffTypeDetailMap);
        assert.equal(merged.length, 1);
        assert.equal(merged[0].typeHrid, '/buff_types/efficiency');
        assert.equal(personalBuffList.length, 0);
    });

    test('美食卷軸只對烹飪/沖泡有效', () => {
        assert.equal(mergeSimulatedScrollBuffs([], '/action_types/milking', ['gourmet'], itemDetailMap, personalBuffTypeDetailMap).length, 0);
        assert.equal(mergeSimulatedScrollBuffs([], '/action_types/cooking', ['gourmet'], itemDetailMap, personalBuffTypeDetailMap).length, 1);
    });

    test('同類加成已在生效中：不重複疊加', () => {
        const activeBuffList = [{ typeHrid: '/buff_types/efficiency', flatBoost: 0.12 }];
        const merged = mergeSimulatedScrollBuffs(activeBuffList, '/action_types/milking', ['efficiency'], itemDetailMap, personalBuffTypeDetailMap);
        assert.equal(merged.length, 1);
    });

    test('可複選：四種卷軸一起勾', () => {
        const merged = mergeSimulatedScrollBuffs(null, '/action_types/cooking', ['gourmet', 'efficiency', 'action_speed', 'rare_find'], itemDetailMap, personalBuffTypeDetailMap);
        assert.deepEqual([...merged.map(buff => buff.typeHrid).sort()], ['/buff_types/action_speed', '/buff_types/efficiency', '/buff_types/gourmet', '/buff_types/rare_find']);
    });

    test('缺遊戲資料或未知卷軸：不加任何東西也不報錯', () => {
        assert.equal(mergeSimulatedScrollBuffs([], '/action_types/milking', ['efficiency'], itemDetailMap, undefined).length, 0);
        assert.equal(mergeSimulatedScrollBuffs([], '/action_types/milking', ['efficiency'], {}, personalBuffTypeDetailMap).length, 0);
        assert.equal(mergeSimulatedScrollBuffs([], '/action_types/milking', ['not_a_scroll'], itemDetailMap, personalBuffTypeDetailMap).length, 0);
    });
});

describe('設定', () => {
    test('toggleScrollKey：勾 / 取消勾，可複選', () => {
        let enabledScrollKeys = toggleScrollKey(undefined, 'efficiency');
        assert.deepEqual([...enabledScrollKeys], ['efficiency']);
        enabledScrollKeys = toggleScrollKey(enabledScrollKeys, 'rare_find');
        assert.deepEqual([...enabledScrollKeys], ['efficiency', 'rare_find']);
        enabledScrollKeys = toggleScrollKey(enabledScrollKeys, 'efficiency');
        assert.deepEqual([...enabledScrollKeys], ['rare_find']);
    });

    test('validateProfitSettings：預設全不勾、過濾未知值與重複值', () => {
        assert.deepEqual([...validateProfitSettings({}).enabledScrolls], []);
        assert.deepEqual([...validateProfitSettings({ enabledScrolls: 'efficiency' }).enabledScrolls], []);
        const settings = validateProfitSettings({ enabledScrolls: ['rare_find', 'hack', 'efficiency', 'efficiency'] });
        assert.deepEqual([...settings.enabledScrolls], ['efficiency', 'rare_find']);
    });

    test('按鈕：四個卷軸，aria-pressed 反映勾選狀態，滑鼠提示顯示加成', () => {
        globals.profitSettings = validateProfitSettings({ enabledScrolls: ['action_speed'] });
        const html = generateScrollBuffButtons();
        assert.equal((html.match(/class="scroll-buff-option"/g) || []).length, 4);
        assert.match(html, /data-scroll="action_speed" aria-pressed="true" title="\+15%"/);
        assert.match(html, /data-scroll="efficiency" aria-pressed="false" title="\+12%"/);
    });
});

describe('ProfitCaculation 套用模擬卷軸', () => {
    test('沒傳卷軸（掉落紀錄預期收益用）：跟原本一樣', () => {
        const baseline = ProfitCaculation(cowMilking, marketJson);
        const withEmptyScrolls = ProfitCaculation(cowMilking, marketJson, []);
        assert.equal(withEmptyScrolls.actionPerHour, baseline.actionPerHour);
        assert.equal(withEmptyScrolls.profitPerHour, baseline.profitPerHour);
    });

    test('效率卷軸：每小時動作數 x1.12', () => {
        const baseline = ProfitCaculation(cowMilking, marketJson);
        const withEfficiency = ProfitCaculation(cowMilking, marketJson, ['efficiency']);
        assert.ok(Math.abs(withEfficiency.actionPerHour / baseline.actionPerHour - 1.12) < 1e-9);
        assert.ok(withEfficiency.profitPerHour > baseline.profitPerHour);
        assert.equal(withEfficiency.personalBuff.efficiency, 12);
    });

    test('行動速度卷軸：動作時間 / 1.15', () => {
        const baseline = ProfitCaculation(cowMilking, marketJson);
        const withActionSpeed = ProfitCaculation(cowMilking, marketJson, ['action_speed']);
        assert.ok(Math.abs(withActionSpeed.actionPerHour / baseline.actionPerHour - 1.15) < 1e-9);
    });

    test('實際開著的行動速度卷軸也要算進動作時間', () => {
        const baseline = ProfitCaculation(cowMilking, marketJson);
        setPersonalBuffs({ '/action_types/milking': [{ typeHrid: '/buff_types/action_speed', flatBoost: 0.15 }] });
        const withRealActionSpeed = ProfitCaculation(cowMilking, marketJson);
        assert.ok(Math.abs(withRealActionSpeed.actionPerHour / baseline.actionPerHour - 1.15) < 1e-9);
    });

    test('稀有發現卷軸：稀有掉落數量 x1.5，一般掉落不變', () => {
        const baseline = ProfitCaculation(cowMilking, marketJson);
        const withRareFind = ProfitCaculation(cowMilking, marketJson, ['rare_find']);
        const findCount = (result, itemHrid) => result.outputItems.find(item => item.itemHrid === itemHrid).count;
        assert.ok(Math.abs(findCount(withRareFind, '/items/small_meteorite_cache') / findCount(baseline, '/items/small_meteorite_cache') - 1.5) < 1e-9);
        assert.equal(findCount(withRareFind, '/items/milk'), findCount(baseline, '/items/milk'));
    });

    test('美食卷軸：烹飪產出 x1.1，擠奶不受影響', () => {
        const donutBaseline = ProfitCaculation(donutCooking, marketJson);
        const donutWithGourmet = ProfitCaculation(donutCooking, marketJson, ['gourmet']);
        assert.ok(Math.abs(donutWithGourmet.outputItems[0].count / donutBaseline.outputItems[0].count - 1.1) < 1e-9);
        const cowBaseline = ProfitCaculation(cowMilking, marketJson);
        const cowWithGourmet = ProfitCaculation(cowMilking, marketJson, ['gourmet']);
        assert.equal(cowWithGourmet.profitPerHour, cowBaseline.profitPerHour);
    });

    test('效率卷軸已實際開著：勾選不重複疊加', () => {
        setPersonalBuffs({ '/action_types/milking': [{ typeHrid: '/buff_types/efficiency', flatBoost: 0.12 }] });
        const activeOnly = ProfitCaculation(cowMilking, marketJson);
        const activeAndSimulated = ProfitCaculation(cowMilking, marketJson, ['efficiency']);
        assert.equal(activeAndSimulated.actionPerHour, activeOnly.actionPerHour);
    });

    test('複選：效率 + 行動速度 動作數 x1.12 x1.15', () => {
        const baseline = ProfitCaculation(cowMilking, marketJson);
        const combined = ProfitCaculation(cowMilking, marketJson, ['efficiency', 'action_speed']);
        assert.ok(Math.abs(combined.actionPerHour / baseline.actionPerHour - 1.12 * 1.15) < 1e-9);
    });
});
