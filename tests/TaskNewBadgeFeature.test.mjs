// 新領取任務（TaskNewBadgeFeature）：首次基準、登入 / 增量判斷新任務、進任務頁標「新」並確認已讀、領取後忘掉、儲存上限（node --test 'tests/*.test.mjs'）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadMwiToolsScript } from './MwiToolsScriptLoader.mjs';

const storageKey = 'MWITools_taskNewState_v1';
const characterKey = 'www.milkywayidle.com:7';
const randomTask = (id, fields = {}) => ({
    id,
    category: '/quest_category/random_task',
    type: '/quest_type/action',
    actionHrid: '/actions/milking/cow',
    monsterHrid: '',
    status: '/quest_status/in_progress',
    goalCount: 10,
    currentCount: 0,
    itemRewardsJSON: '[]',
    ...fields,
});
const characterData = (quests) => ({
    type: 'init_character_data',
    character: { id: 7, name: 'Tester' },
    characterSkills: [],
    characterItems: [],
    characterHouseRoomMap: {},
    actionTypeDrinkSlotsMap: {},
    characterAbilities: [],
    myMarketListings: [],
    combatUnit: { combatAbilities: [] },
    characterActions: [],
    characterQuests: quests,
});

// 送訊息時暫時關掉 mwiTools 自己的 console.log（init 會印整包資料），並收集本功能的錯誤
function feedQuietly(hooks, message) {
    const originalLog = console.log;
    const originalError = console.error;
    const featureErrors = [];
    console.log = () => {};
    console.error = (...parts) => {
        const text = parts.map((part) => String(part?.stack || part)).join(' ');
        if (/Task(Insights|NewBadge|AutoReturn)Feature/.test(text)) featureErrors.push(text);
    };
    try {
        hooks.feedMessage(message);
    } finally {
        console.log = originalLog;
        console.error = originalError;
    }
    assert.deepEqual(featureErrors, [], '本功能處理訊息時不應該出錯');
}

function createHooks(options = {}) {
    const originalError = console.error;
    console.error = () => {};
    let hooks = null;
    try {
        hooks = loadMwiToolsScript(['TaskNewBadgeFeature', 'TaskInsightsFeature', 'settingsMap'], options);
    } finally {
        console.error = originalError;
    }
    // 本功能不需要遊戲靜態資料，給一份空的，免得 mwiTools 自己算資產時抱怨缺資料
    feedQuietly(hooks, { type: 'init_client_data', itemDetailMap: {}, actionDetailMap: {}, actionCategoryDetailMap: {}, openableLootDropMap: {}, combatMonsterDetailMap: {} });
    return hooks;
}

const readStoredEntry = (hooks) => JSON.parse(hooks.gmStore.get(storageKey)).characters[characterKey];
const sortedIds = (values) => [...values].map(String).sort();
const idSet = (...ids) => new Set(ids.map(String));

describe('判斷新任務', () => {
    test('第一次啟用：目前全部當已知，不標新', () => {
        const hooks = createHooks();
        feedQuietly(hooks, characterData([randomTask(1), randomTask(2)]));
        const entry = readStoredEntry(hooks);
        assert.equal(entry.initialized, true);
        assert.deepEqual(sortedIds(entry.known), ['1', '2']);
        assert.deepEqual(entry.fresh, []);
        assert.equal(hooks.TaskNewBadgeFeature.beginPageVisit(idSet(1, 2)).size, 0);
    });

    test('下次登入多出來的任務 = 新；進任務頁標「新」並確認已讀，之後的造訪恢復一般', () => {
        const first = createHooks();
        feedQuietly(first, characterData([randomTask(1), randomTask(2)]));
        const second = createHooks({ gmValues: { [storageKey]: first.gmStore.get(storageKey) } });
        feedQuietly(second, characterData([randomTask(1), randomTask(2), randomTask(3)]));
        assert.deepEqual(readStoredEntry(second).fresh, ['3']);

        const feature = second.TaskNewBadgeFeature;
        assert.deepEqual(sortedIds(feature.beginPageVisit(idSet(1, 2, 3))), ['3']);
        assert.deepEqual(readStoredEntry(second).fresh, [], '顯示過就從未讀移除並寫回');
        assert.equal(feature.updatePageVisit(idSet(1, 2, 3)), false);
        assert.deepEqual(sortedIds(feature.getPageNewQuestIds()), ['3'], '本次造訪內一直標著');
        assert.equal(feature.beginPageVisit(idSet(1, 2, 3)).size, 0, '下一次造訪就不標了');
    });

    test('登入時已經不在的新任務、教學任務都不算', () => {
        const first = createHooks();
        feedQuietly(first, characterData([randomTask(1)]));
        const tutorial = { id: 50, category: '/quest_category/tutorial', type: '/quest_type/message', status: '/quest_status/in_progress' };
        const second = createHooks({ gmValues: { [storageKey]: first.gmStore.get(storageKey) } });
        feedQuietly(second, characterData([randomTask(1), randomTask(4), tutorial]));
        const third = createHooks({ gmValues: { [storageKey]: second.gmStore.get(storageKey) } });
        feedQuietly(third, characterData([randomTask(1)]));
        const entry = readStoredEntry(third);
        assert.deepEqual(entry.fresh, []);
        assert.deepEqual(entry.known, ['1'], '已知修剪成目前任務');
    });

    test('造訪中收到新任務（quests_updated）：本次集合變大一次；領取後忘掉', () => {
        const hooks = createHooks();
        feedQuietly(hooks, characterData([randomTask(1), randomTask(2)]));
        const feature = hooks.TaskNewBadgeFeature;
        feature.beginPageVisit(idSet(1, 2));
        feedQuietly(hooks, { type: 'quests_updated', endCharacterQuests: [randomTask(9)] });
        assert.deepEqual(readStoredEntry(hooks).fresh, ['9']);
        assert.equal(feature.updatePageVisit(idSet(1, 2, 9)), true);
        assert.equal(feature.updatePageVisit(idSet(1, 2, 9)), false);
        assert.deepEqual(sortedIds(feature.getPageNewQuestIds()), ['9']);

        feedQuietly(hooks, { type: 'quests_updated', endCharacterQuests: [randomTask(9, { status: '/quest_status/claimed' })] });
        assert.deepEqual(sortedIds(readStoredEntry(hooks).known), ['1', '2']);
        assert.equal(feature.updatePageVisit(idSet(1, 2)), false);
        assert.equal(feature.getPageNewQuestIds().size, 0, '任務不在了就從本次集合移除');
    });

    test('進度更新（action_completed）不會產生新任務，也不寫儲存', () => {
        const hooks = createHooks();
        feedQuietly(hooks, characterData([randomTask(1)]));
        const before = hooks.gmStore.get(storageKey);
        feedQuietly(hooks, {
            type: 'action_completed',
            endCharacterAction: { id: 1, actionHrid: '/actions/milking/cow', isDone: false, currentCount: 1 },
            endCharacterQuests: [randomTask(1, { currentCount: 1 })],
            endCharacterItems: [],
        });
        assert.equal(hooks.gmStore.get(storageKey), before);
    });

    test('從沒建立過基準（沒收到登入全量）時，增量只記成已知', () => {
        const hooks = createHooks();
        const feature = hooks.TaskNewBadgeFeature;
        const state = { initialized: false, known: new Set(), fresh: new Set() };
        assert.equal(feature._applyQuestUpdates(state, new Set(), [randomTask(5)]), true);
        assert.deepEqual(sortedIds(state.known), ['5']);
        assert.equal(state.fresh.size, 0);
        const initializedState = { initialized: true, known: new Set(['5']), fresh: new Set() };
        assert.equal(feature._applyQuestUpdates(initializedState, new Set(['5']), [randomTask(6)]), true);
        assert.deepEqual(sortedIds(initializedState.fresh), ['6']);
    });

    test('自己重置換來的任務：確認後不標新', () => {
        const hooks = createHooks();
        feedQuietly(hooks, characterData([randomTask(1)]));
        const feature = hooks.TaskNewBadgeFeature;
        feature.beginPageVisit(idSet(1));
        feedQuietly(hooks, { type: 'quests_updated', endCharacterQuests: [randomTask(2)] });
        feature.acknowledgeQuest('2');
        assert.equal(feature.updatePageVisit(idSet(1, 2)), false);
        assert.deepEqual(readStoredEntry(hooks).fresh, []);
    });
});

describe('儲存', () => {
    test('最多 20 個角色（刪最久沒更新的）；id 最多 100 個；壞資料當空的', () => {
        const characters = {};
        for (let index = 0; index < 25; index++) {
            characters[`www.milkywayidle.com:${100 + index}`] = { initialized: true, known: ['1'], fresh: [], updatedAt: index };
        }
        const hooks = createHooks({ gmValues: { [storageKey]: JSON.stringify({ version: 1, characters }) } });
        const manyQuests = Array.from({ length: 150 }, (_, index) => randomTask(1000 + index));
        feedQuietly(hooks, characterData(manyQuests));
        const stored = JSON.parse(hooks.gmStore.get(storageKey));
        assert.equal(Object.keys(stored.characters).length, 20);
        assert.ok(stored.characters[characterKey]);
        assert.ok(!stored.characters['www.milkywayidle.com:100']);
        assert.equal(stored.characters[characterKey].known.length, 100);

        const broken = createHooks({ gmValues: { [storageKey]: '[1,2' } });
        const originalWarn = console.warn;
        console.warn = () => {};
        try {
            feedQuietly(broken, characterData([randomTask(1)]));
        } finally {
            console.warn = originalWarn;
        }
        assert.deepEqual(readStoredEntry(broken).known, ['1']);
    });

    test('設定關閉（或任務平鋪版面關閉）：不寫儲存、不標新', () => {
        const disabled = createHooks({ localStorageValues: { script_settingsMap: JSON.stringify({ taskNewBadge: { id: 'taskNewBadge', isTrue: false } }) } });
        feedQuietly(disabled, characterData([randomTask(1)]));
        assert.equal(disabled.gmStore.has(storageKey), false);
        assert.equal(disabled.TaskNewBadgeFeature.beginPageVisit(idSet(1)).size, 0);

        const parentDisabled = createHooks({ localStorageValues: { script_settingsMap: JSON.stringify({ taskInsights: { id: 'taskInsights', isTrue: false } }) } });
        feedQuietly(parentDisabled, characterData([randomTask(1)]));
        assert.equal(parentDisabled.gmStore.has(storageKey), false);
    });
});
