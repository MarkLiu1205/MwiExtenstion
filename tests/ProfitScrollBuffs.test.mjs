// 收益面板「模擬卷軸收益」測試：node --test 'tests/*.test.mjs'
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
const gatheringActionTypes = ['milking', 'foraging', 'woodcutting'].map(name => `/action_types/${name}`);
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
    },
    '/personal_buff_types/wisdom': {
        hrid: '/personal_buff_types/wisdom',
        buff: { typeHrid: '/buff_types/wisdom', flatBoost: 0.2 },
        usableInActionTypeMap: toUsableMap(skillingActionTypes)
    },
    '/personal_buff_types/gathering': {
        hrid: '/personal_buff_types/gathering',
        buff: { typeHrid: '/buff_types/gathering', flatBoost: 0.1 },
        usableInActionTypeMap: toUsableMap(gatheringActionTypes)
    },
    '/personal_buff_types/processing': {
        hrid: '/personal_buff_types/processing',
        buff: { typeHrid: '/buff_types/processing', flatBoost: 0.1 },
        usableInActionTypeMap: toUsableMap(gatheringActionTypes)
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
const { calculateWisdomScrollExp, findSkillActionDetailInstance, collectCurrentActionBuffs, formatWisdomScrollExpHint, getWisdomScrollExpHint, findActionHridByName } = profitScript;
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

    test('可複選：六種全勾，只留該技能用得到的', () => {
        const allScrollKeys = ['gourmet', 'efficiency', 'action_speed', 'rare_find', 'gathering', 'processing'];
        const cookingMerged = mergeSimulatedScrollBuffs(null, '/action_types/cooking', allScrollKeys, itemDetailMap, personalBuffTypeDetailMap);
        assert.deepEqual([...cookingMerged.map(buff => buff.typeHrid).sort()], ['/buff_types/action_speed', '/buff_types/efficiency', '/buff_types/gourmet', '/buff_types/rare_find']);
        const milkingMerged = mergeSimulatedScrollBuffs(null, '/action_types/milking', allScrollKeys, itemDetailMap, personalBuffTypeDetailMap);
        assert.deepEqual([...milkingMerged.map(buff => buff.typeHrid).sort()], ['/buff_types/action_speed', '/buff_types/efficiency', '/buff_types/gathering', '/buff_types/processing', '/buff_types/rare_find']);
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
        // 經驗卷軸不是面板開關，存到設定裡也要濾掉
        const settings = validateProfitSettings({ enabledScrolls: ['rare_find', 'hack', 'wisdom', 'efficiency', 'efficiency'] });
        assert.deepEqual([...settings.enabledScrolls], ['efficiency', 'rare_find']);
    });

    test('按鈕：六個卷軸，aria-pressed 反映勾選狀態，滑鼠提示顯示加成與適用技能', () => {
        globals.profitSettings = validateProfitSettings({ enabledScrolls: ['action_speed'] });
        const html = generateScrollBuffButtons();
        const scrollKeysInOrder = [...html.matchAll(/data-scroll="([a-z_]+)"/g)].map(match => match[1]);
        assert.deepEqual(scrollKeysInOrder, ['efficiency', 'action_speed', 'rare_find', 'gathering', 'processing', 'gourmet']);
        assert.match(html, /data-scroll="action_speed" aria-pressed="true" title="\+15%｜milking, foraging/);
        assert.match(html, /data-scroll="efficiency" aria-pressed="false" title="\+12%/);
        assert.match(html, /data-scroll="gathering" aria-pressed="false" title="\+10%｜milking, foraging, woodcutting"/);
        // 勾選的才顯示 ✓
        assert.equal((html.match(/visibility: visible;">✓/g) || []).length, 1);
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

    test('採集卷軸：擠奶掉落數量 x1.1', () => {
        const baseline = ProfitCaculation(cowMilking, marketJson);
        const withGathering = ProfitCaculation(cowMilking, marketJson, ['gathering']);
        const milkCount = result => result.outputItems.find(item => item.itemHrid === '/items/milk').count;
        assert.ok(Math.abs(milkCount(withGathering) / milkCount(baseline) - 1.1) < 1e-9);
    });

    test('加工卷軸：擠奶時部分牛奶直接變起司', () => {
        const baseline = ProfitCaculation(cowMilking, marketJson);
        const withProcessing = ProfitCaculation(cowMilking, marketJson, ['processing']);
        const cheeseName = itemDetailMap['/items/cheese'].name;
        assert.equal(baseline.outputItems.some(item => item.name === cheeseName), false);
        const cheese = withProcessing.outputItems.find(item => item.name === cheeseName);
        // 10% x 掉落率 1 = 0.1 個起司，每個起司用掉 2 牛奶
        assert.ok(Math.abs(cheese.count - 0.1) < 1e-9);
        const milkCount = result => result.outputItems.find(item => item.itemHrid === '/items/milk').count;
        assert.ok(Math.abs(milkCount(baseline) - milkCount(withProcessing) - 0.2) < 1e-9);
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

describe('遊戲動作視窗：產出經驗後面補開經驗卷軸的經驗', () => {
    const wisdomScrollDetail = personalBuffTypeDetailMap['/personal_buff_types/wisdom'];
    const teaWisdomBuff = { typeHrid: '/buff_types/wisdom', flatBoost: 0.12 };
    // 模擬 React：expGain 元素 → 上層 fiber → SkillActionDetail 元件實例
    function createExpGainElement(instance) {
        return { '__reactFiber$test': { stateNode: null, return: { stateNode: null, return: { stateNode: instance, return: null } } } };
    }

    test('calculateWisdomScrollExp：目前加成 + 卷軸 20%，四捨五入到小數一位', () => {
        const baseExpGain = cowMilking.experienceGain.value;
        const expected = Math.round((1 + 0.12 + 0.2) * baseExpGain * 10) / 10;
        assert.equal(calculateWisdomScrollExp(cowMilking, [teaWisdomBuff], [], wisdomScrollDetail), expected);
    });

    test('calculateWisdomScrollExp：卷軸已生效 / 不適用 / 缺資料 / 沒經驗 → null', () => {
        assert.equal(calculateWisdomScrollExp(cowMilking, [], [{ typeHrid: '/buff_types/wisdom', flatBoost: 0.2 }], wisdomScrollDetail), null);
        const onlyCooking = { ...wisdomScrollDetail, usableInActionTypeMap: { '/action_types/cooking': true } };
        assert.equal(calculateWisdomScrollExp(cowMilking, [], [], onlyCooking), null);
        assert.equal(calculateWisdomScrollExp(cowMilking, [], [], null), null);
        assert.equal(calculateWisdomScrollExp({ ...cowMilking, experienceGain: { value: 0 } }, [], [], wisdomScrollDetail), null);
    });

    test('findSkillActionDetailInstance：沿 React fiber 往上找到帶 actionDetail 的元件', () => {
        const instance = { props: { actionDetail: cowMilking } };
        assert.equal(findSkillActionDetailInstance(createExpGainElement(instance)), instance);
        assert.equal(findSkillActionDetailInstance({}), null);
        assert.equal(findSkillActionDetailInstance(null), null);
    });

    test('提示：用遊戲元件的 getBuffs 算（跟畫面經驗一致）', () => {
        const instance = { props: { actionDetail: cowMilking }, getBuffs: () => [teaWisdomBuff] };
        const expected = calculateWisdomScrollExp(cowMilking, [teaWisdomBuff], [], wisdomScrollDetail);
        const hint = getWisdomScrollExpHint(createExpGainElement(instance));
        assert.deepEqual({ ...hint }, { text: formatWisdomScrollExpHint(expected), isWarning: false });
        assert.match(hint.text, /^w\/ Wisdom Scroll: [\d.]+$/);
    });

    test('提示：getBuffs 壞掉時改用腳本自己記錄的加成', () => {
        globals.initCharacterData_consumableActionTypeBuffsMap = { '/action_types/milking': [teaWisdomBuff] };
        assert.deepEqual([...collectCurrentActionBuffs('/action_types/milking')], [teaWisdomBuff]);
        const instance = { props: { actionDetail: cowMilking }, getBuffs: () => { throw new Error('game changed'); } };
        const expected = calculateWisdomScrollExp(cowMilking, [teaWisdomBuff], [], wisdomScrollDetail);
        assert.equal(getWisdomScrollExpHint(createExpGainElement(instance)).text, formatWisdomScrollExpHint(expected));
        globals.initCharacterData_consumableActionTypeBuffsMap = {};
    });

    test('提示：React 找不到時，用視窗標題名稱反查動作', () => {
        assert.equal(findActionHridByName('Cow'), '/actions/milking/cow');
        assert.equal(findActionHridByName(' 奶牛 '), '/actions/milking/cow');
        // 遊戲官方中文是簡體，腳本自己的動作名稱是繁體，兩種都要認得
        assert.equal(findActionHridByName('翠绿奶牛'), '/actions/milking/verdant_cow');
        assert.equal(findActionHridByName('翠綠奶牛'), '/actions/milking/verdant_cow');
        assert.equal(findActionHridByName('不存在的動作'), null);
        const nameElement = { getAttribute: () => null, textContent: 'Cow' };
        const popupElement = { querySelector: () => nameElement };
        const expGainElement = { closest: () => popupElement };
        const hint = getWisdomScrollExpHint(expGainElement);
        assert.equal(hint.isWarning, false);
        assert.equal(hint.text, formatWisdomScrollExpHint(calculateWisdomScrollExp(cowMilking, [], [], wisdomScrollDetail)));
    });

    test('提示：經驗卷軸已開著 → 不顯示', () => {
        setPersonalBuffs({ '/action_types/milking': [{ typeHrid: '/buff_types/wisdom', flatBoost: 0.2 }] });
        const instance = { props: { actionDetail: cowMilking }, getBuffs: () => [] };
        assert.equal(getWisdomScrollExpHint(createExpGainElement(instance)), null);
    });

    test('提示：讀不到動作或卷軸資料 → 顯示灰色原因（不是整個消失）', () => {
        const actionMissing = getWisdomScrollExpHint({});
        assert.equal(actionMissing.isWarning, true);
        assert.match(actionMissing.text, /action not found/);
        globals.initClientData_personalBuffTypeDetailMap = {};
        const instance = { props: { actionDetail: cowMilking }, getBuffs: () => [] };
        const scrollMissing = getWisdomScrollExpHint(createExpGainElement(instance));
        assert.equal(scrollMissing.isWarning, true);
        assert.match(scrollMissing.text, /scroll data missing/);
    });
});
