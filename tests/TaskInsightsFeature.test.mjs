// 任務頁增強（TaskInsightsFeature）：任務 / 背包訊息、怪物→動作與地下城、分組排序、篩選統計、材料數、佇列進度、合併數量、圖示、篩選鎖、穩定順序與重置換位（node --test 'tests/*.test.mjs'）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadMwiToolsScript } from './MwiToolsScriptLoader.mjs';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const readGameData = (fileName) => JSON.parse(readFileSync(join(repositoryRoot, 'simulator/src/combatsimulator/data', fileName), 'utf8'));
const actionDetailMap = readGameData('actionDetailMap.json');
const itemDetailMap = readGameData('itemDetailMap.json');
const combatMonsterDetailMap = readGameData('combatMonsterDetailMap.json');
// 遊戲的 actionCategoryDetailMap 不在 simulator 資料裡，自己做一份只有 sortIndex 的（地圖順序 = 遊戲戰鬥頁的分頁順序）
const actionCategoryDetailMap = Object.fromEntries(
    [
        ['/action_categories/milking/cows', 1],
        ['/action_categories/foraging/farmland', 1],
        ['/action_categories/cheesesmithing/material', 1],
        ['/action_categories/cheesesmithing/main_hand', 2],
        ['/action_categories/cooking/instant_heal', 1],
        ['/action_categories/combat/smelly_planet', 1],
        ['/action_categories/combat/swamp_planet', 2],
        ['/action_categories/combat/aqua_planet', 3],
        ['/action_categories/combat/jungle_planet', 4],
        ['/action_categories/combat/gobo_planet', 5],
        ['/action_categories/combat/planet_of_the_eyes', 6],
        ['/action_categories/combat/sorcerers_tower', 7],
        ['/action_categories/combat/bear_with_it', 8],
        ['/action_categories/combat/golem_cave', 9],
        ['/action_categories/combat/twilight_zone', 10],
        ['/action_categories/combat/infernal_abyss', 11],
        ['/action_categories/combat/dungeons', 12],
    ].map(([hrid, sortIndex]) => [hrid, { hrid, sortIndex }])
);

const randomTask = (id, fields) => ({
    id,
    category: '/quest_category/random_task',
    status: '/quest_status/in_progress',
    goalCount: 10,
    currentCount: 0,
    itemRewardsJSON: '[]',
    ...fields,
});
const actionTask = (id, actionHrid, fields = {}) => randomTask(id, { type: '/quest_type/action', actionHrid, monsterHrid: '', ...fields });
const monsterTask = (id, monsterHrid, fields = {}) => randomTask(id, { type: '/quest_type/monster', actionHrid: '', monsterHrid, ...fields });
const inventoryItem = (itemHrid, count, enhancementLevel = 0) => ({
    hash: `7::/item_locations/inventory::${itemHrid}::${enhancementLevel}`,
    itemHrid,
    itemLocationHrid: '/item_locations/inventory',
    enhancementLevel,
    count,
});
const characterData = (quests, extra = {}) => ({
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
    ...extra,
});
// 跨 vm 的物件原型不同，比對前先轉成本地的純資料
const plain = (value) => JSON.parse(JSON.stringify(value));

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
        hooks = loadMwiToolsScript(['TaskInsightsFeature', 'TaskNewBadgeFeature', 'TaskAutoReturnFeature', 'settingsMap'], options);
    } finally {
        console.error = originalError;
    }
    feedQuietly(hooks, { type: 'init_client_data', itemDetailMap, actionDetailMap, actionCategoryDetailMap, combatMonsterDetailMap });
    return hooks;
}

// 假的任務卡：卡片根 div 的 host fiber，往上一層是 RandomTask 元件（props.characterQuest、state.showRerollOptions）
const createFakeCard = (quest, state = { showRerollOptions: false, showDiscardConfirmation: false }) => ({
    className: 'RandomTask_randomTask__3B9fA',
    dataset: {},
    querySelector: () => null,
    '__reactFiber$test': { memoizedProps: { className: 'RandomTask_randomTask__3B9fA' }, stateNode: {}, return: { memoizedProps: { characterQuest: quest }, stateNode: { state }, return: null } },
});

describe('任務與背包訊息', () => {
    test('登入全量只留隨機任務；已領取 / 已放棄刪除；其餘整筆取代（跟遊戲 updateCharacterQuests 一樣）', () => {
        const hooks = createHooks();
        const tutorialQuest = { id: 1, category: '/quest_category/tutorial', type: '/quest_type/message', status: '/quest_status/in_progress' };
        feedQuietly(hooks, characterData([tutorialQuest, actionTask(10, '/actions/milking/cow'), monsterTask(11, '/monsters/fly')]));
        const feature = hooks.TaskInsightsFeature;
        assert.deepEqual([...feature._questsById.keys()].sort(), ['10', '11']);

        feedQuietly(hooks, { type: 'quests_updated', endCharacterQuests: [actionTask(10, '/actions/milking/cow', { status: '/quest_status/claimed' }), actionTask(12, '/actions/foraging/egg')] });
        assert.deepEqual([...feature._questsById.keys()].sort(), ['11', '12']);

        feedQuietly(hooks, { type: 'action_completed', endCharacterAction: { id: 1, actionHrid: '/actions/combat/fly', isDone: false, currentCount: 3 }, endCharacterQuests: [monsterTask(11, '/monsters/fly', { currentCount: 4 })], endCharacterItems: [] });
        assert.equal(feature._questsById.get('11').currentCount, 4);

        feedQuietly(hooks, { type: 'quests_updated', endCharacterQuests: [monsterTask(11, '/monsters/fly', { status: '/quest_status/discarded' })] });
        assert.deepEqual([...feature._questsById.keys()], ['12']);
    });

    test('背包數量：只算背包裡強化 0 的堆疊；items_updated / action_completed 是絕對數量，0 = 用完', () => {
        const hooks = createHooks();
        const equippedSword = { ...inventoryItem('/items/cheese_sword', 1), itemLocationHrid: '/item_locations/main_hand' };
        feedQuietly(hooks, characterData([], { characterItems: [inventoryItem('/items/milk', 50), inventoryItem('/items/cheese', 7, 1), equippedSword] }));
        const counts = hooks.TaskInsightsFeature._inventoryCountByItemHrid;
        assert.deepEqual(Object.fromEntries(counts), { '/items/milk': 50 });

        feedQuietly(hooks, { type: 'items_updated', endCharacterItems: [inventoryItem('/items/milk', 0), inventoryItem('/items/egg', 12)] });
        assert.deepEqual(Object.fromEntries(counts), { '/items/egg': 12 });

        feedQuietly(hooks, { type: 'action_completed', endCharacterAction: { id: 1, actionHrid: '/actions/foraging/egg', isDone: false, currentCount: 1 }, endCharacterQuests: [], endCharacterItems: [inventoryItem('/items/egg', 13)] });
        assert.equal(counts.get('/items/egg'), 13);
    });
});

describe('怪物 → 動作 / 地下城（遊戲「前往」規則）', () => {
    const hooks = createHooks();
    const feature = hooks.TaskInsightsFeature;

    test('一般怪物：依 sortIndex 第一個含此怪的動作是單怪動作，次數 × 1；boss：地區動作 × battlesPerBoss', () => {
        assert.deepEqual(plain(feature._resolveMonsterTarget('/monsters/fly')), { actionHrid: '/actions/combat/fly', battlesPerKill: 1 });
        assert.deepEqual(plain(feature._resolveMonsterTarget('/monsters/giant_shoebill')), { actionHrid: '/actions/combat/swamp_planet', battlesPerKill: 10 });
        assert.equal(feature._resolveMonsterTarget('/monsters/not_a_monster'), null);
    });

    test('地下城：怪物出現在哪些地下城（依 sortIndex），同一怪可在多個；四個地下城依序編號', () => {
        assert.deepEqual([...feature._getDungeonsForMonster('/monsters/eye')], ['/actions/combat/chimerical_den', '/actions/combat/pirate_cove']);
        assert.deepEqual([...feature._getDungeonsForMonster('/monsters/giant_shoebill')], []);
        assert.deepEqual(
            plain(feature._getDungeonList()).map((dungeon) => [dungeon.actionHrid, dungeon.position]),
            [
                ['/actions/combat/chimerical_den', 1],
                ['/actions/combat/sinister_circus', 2],
                ['/actions/combat/enchanted_fortress', 3],
                ['/actions/combat/pirate_cove', 4],
            ]
        );
    });

    test('專業：動作類型最後一段；怪物任務 = 戰鬥；未知類型歸到自訂專業（排在強化之後、戰鬥之前）', () => {
        assert.equal(feature._getProfession(actionTask(1, '/actions/cheesesmithing/cheese')).key, 'cheesesmithing');
        assert.equal(feature._getProfession(monsterTask(2, '/monsters/fly')).key, 'combat');
        const unknown = feature._getProfession(actionTask(3, '/actions/fishing/trout'));
        assert.equal(unknown.key, 'custom-fishing');
        assert.ok(unknown.order > feature._getProfession(actionTask(4, '/actions/enhancing/enhance')).order);
        assert.ok(unknown.order < feature._getProfession(monsterTask(5, '/monsters/fly')).order);
    });
});

describe('分組與排序', () => {
    const hooks = createHooks();
    const feature = hooks.TaskInsightsFeature;
    // 遊戲原生順序：id 由大到小
    const quests = [
        monsterTask(40, '/monsters/eye'),
        monsterTask(39, '/monsters/fly'),
        actionTask(38, '/actions/cheesesmithing/cheese_sword'),
        monsterTask(37, '/monsters/rat'),
        actionTask(36, '/actions/cheesesmithing/holy_cheese'),
        actionTask(35, '/actions/milking/cow', { status: '/quest_status/completed', currentCount: 10 }),
        monsterTask(34, '/monsters/fly'),
        actionTask(33, '/actions/cheesesmithing/cheese'),
        monsterTask(32, '/monsters/giant_shoebill'),
        actionTask(31, '/actions/foraging/egg'),
        actionTask(30, '/actions/milking/verdant_cow'),
    ];
    const sortedIds = (rows) => [...rows].map((row) => row.questId);

    test('新 → 已完成 → 一般；專業依導覽列順序；戰鬥依地圖 → 同怪物相鄰；自動整理時專業內依分類 → 等級', () => {
        const rows = feature._buildRows(quests, new Set(['33']));
        assert.deepEqual(sortedIds(feature._sortRows(rows, true)), ['33', '35', '30', '31', '36', '38', '39', '34', '37', '32', '40']);
    });

    test('不自動整理（只按排序鈕）：專業內維持原生順序，其餘分組相同', () => {
        const rows = feature._buildRows(quests, new Set());
        assert.deepEqual(sortedIds(feature._sortRows(rows, false)), ['35', '30', '31', '38', '36', '33', '39', '34', '37', '32', '40']);
    });

    test('分類：狀態、剩餘數、戰鬥目標動作、地圖序、地下城', () => {
        const [eyeRow, , , , , cowRow, , , shoebillRow] = feature._buildRows(quests, new Set());
        assert.equal(cowRow.state, 'completed');
        assert.equal(cowRow.isInProgress, false);
        assert.equal(shoebillRow.targetActionHrid, '/actions/combat/swamp_planet');
        assert.equal(shoebillRow.battlesPerKill, 10);
        assert.equal(shoebillRow.zoneOrder, 2);
        assert.equal(eyeRow.zoneOrder, 6);
        assert.deepEqual([...eyeRow.dungeonHrids], ['/actions/combat/chimerical_den', '/actions/combat/pirate_cove']);
        assert.equal(eyeRow.remaining, 10);
    });
});

describe('篩選與統計', () => {
    const hooks = createHooks();
    const feature = hooks.TaskInsightsFeature;
    const rows = feature._buildRows(
        [actionTask(5, '/actions/milking/cow'), actionTask(4, '/actions/foraging/egg'), monsterTask(3, '/monsters/eye'), monsterTask(2, '/monsters/fly'), actionTask(1, '/actions/milking/cow')],
        new Set()
    );
    const visibleIds = () => [...rows].filter((row) => feature._rowMatchesFilters(row)).map((row) => row.questId);

    test('沒有篩選 = 全部顯示；多選是「或」；地下城看怪物出現在哪', () => {
        assert.deepEqual(visibleIds(), ['5', '4', '3', '2', '1']);
        feature._activeProfessionKeys = new Set(['milking']);
        assert.deepEqual(visibleIds(), ['5', '1']);
        feature._activeDungeonHrids = new Set(['/actions/combat/pirate_cove']);
        assert.deepEqual(visibleIds(), ['5', '3', '1']);
        feature._isCombatFilterActive = true;
        assert.deepEqual(visibleIds(), ['5', '3', '2', '1']);
    });

    test('重置後黏住的任務不受篩選影響', () => {
        feature._activeProfessionKeys = new Set(['foraging']);
        feature._activeDungeonHrids = new Set();
        feature._isCombatFilterActive = false;
        feature._stickyQuestIds = new Set(['2']);
        assert.deepEqual(visibleIds(), ['4', '2']);
        feature._activeProfessionKeys = new Set();
        feature._stickyQuestIds = new Set();
    });

    test('數量：全部、各專業、戰鬥、各地下城', () => {
        const counts = feature._countRows(rows);
        assert.equal(counts.total, 5);
        assert.equal(counts.professionCounts.get('milking'), 2);
        assert.equal(counts.professionCounts.get('foraging'), 1);
        assert.equal(counts.combatCount, 2);
        assert.equal(counts.dungeonCounts.get('/actions/combat/chimerical_den'), 1);
        assert.equal(counts.dungeonCounts.get('/actions/combat/sinister_circus'), undefined);
    });
});

describe('材料可做次數（遊戲 renderItemRequirements 的算法）', () => {
    test('沒有茶：⌊背包數 ÷ 每次數量⌋ 取最小；飲料欄有工匠茶（-10%）：10 個蛋每次 1 個 → 11 次', () => {
        const hooks = createHooks();
        feedQuietly(hooks, characterData([], { characterItems: [inventoryItem('/items/egg', 10), inventoryItem('/items/wheat', 20), inventoryItem('/items/sugar', 100)] }));
        const feature = hooks.TaskInsightsFeature;
        assert.equal(feature._computeMaterialCapacity('/actions/cooking/donut'), 10);
        feedQuietly(hooks, { type: 'action_type_consumable_slots_updated', actionTypeDrinkSlotsMap: { '/action_types/cooking': [{ itemHrid: '/items/artisan_tea', isActive: true }, null] } });
        assert.equal(feature._getArtisanRate('/action_types/cooking'), 0.1);
        assert.equal(feature._computeMaterialCapacity('/actions/cooking/donut'), 11);
    });

    test('有升級底材時受底材數量限制；沒有輸入材料的動作回傳 null', () => {
        const hooks = createHooks();
        const plenty = ['/items/red_tea_leaf', '/items/star_fruit', '/items/alchemy_essence', '/items/crushed_amber'].map((itemHrid) => inventoryItem(itemHrid, 999));
        feedQuietly(hooks, characterData([], { characterItems: [...plenty, inventoryItem('/items/alchemy_tea', 3)] }));
        const feature = hooks.TaskInsightsFeature;
        assert.equal(feature._computeMaterialCapacity('/actions/brewing/super_alchemy_tea'), 3);
        feedQuietly(hooks, { type: 'items_updated', endCharacterItems: [inventoryItem('/items/alchemy_tea', 0)] });
        assert.equal(feature._computeMaterialCapacity('/actions/brewing/super_alchemy_tea'), 0);
        assert.equal(feature._computeMaterialCapacity('/actions/milking/cow'), null);
    });
});

describe('佇列進度', () => {
    test('同一個動作的剩餘次數加總（含正在做的）；無限次數；boss 戰鬥次數換成擊殺數；已完成不算', () => {
        const hooks = createHooks();
        feedQuietly(hooks, characterData([]));
        const feature = hooks.TaskInsightsFeature;
        const queuedAction = (id, actionHrid, maxCount, currentCount, ordinal) => ({ id, actionHrid, hasMaxCount: maxCount > 0, maxCount, currentCount, isDone: false, ordinal, partyID: 0 });
        feedQuietly(hooks, {
            type: 'actions_updated',
            endCharacterActions: [
                queuedAction(1, '/actions/milking/cow', 30, 5, 1),
                queuedAction(2, '/actions/milking/cow', 10, 0, 2),
                queuedAction(3, '/actions/combat/swamp_planet', 55, 0, 3),
                queuedAction(4, '/actions/foraging/egg', 0, 0, 4),
            ],
        });
        const rowOf = (quest) => feature._classifyQuest(quest, 0, new Set());
        assert.deepEqual(plain(feature._computeQueuedCount(rowOf(actionTask(1, '/actions/milking/cow')))), { queued: 35, isInfinite: false });
        assert.deepEqual(plain(feature._computeQueuedCount(rowOf(monsterTask(2, '/monsters/giant_shoebill')))), { queued: 5, isInfinite: false });
        assert.deepEqual(plain(feature._computeQueuedCount(rowOf(actionTask(3, '/actions/foraging/egg')))), { queued: 0, isInfinite: true });
        assert.equal(feature._computeQueuedCount(rowOf(actionTask(4, '/actions/cooking/donut'))), null);
        assert.equal(feature._computeQueuedCount(rowOf(actionTask(5, '/actions/milking/cow', { status: '/quest_status/completed', currentCount: 10 }))), null);
    });
});

describe('合併同動作數量', () => {
    const hooks = createHooks();
    const feature = hooks.TaskInsightsFeature;

    test('同動作進行中的任務至少 2 個才合併；已完成、做完的不算', () => {
        const quests = [
            actionTask(1, '/actions/milking/cow', { currentCount: 2 }),
            actionTask(2, '/actions/milking/cow', { goalCount: 5 }),
            actionTask(3, '/actions/milking/cow', { status: '/quest_status/completed', currentCount: 10 }),
            actionTask(4, '/actions/foraging/egg'),
        ];
        assert.deepEqual(plain(feature._buildMergePlan(quests[0], quests)), { targetActionHrid: '/actions/milking/cow', count: 13, taskCount: 2 });
        assert.equal(feature._buildMergePlan(quests[3], quests), null);
        assert.equal(feature._buildMergePlan(quests[2], quests), null);
    });

    test('戰鬥依怪物合併；boss 次數 × battlesPerBoss，目標是遊戲前往會開的地區動作', () => {
        const quests = [monsterTask(1, '/monsters/giant_shoebill', { goalCount: 3 }), monsterTask(2, '/monsters/giant_shoebill', { goalCount: 4, currentCount: 2 }), monsterTask(3, '/monsters/fly')];
        assert.deepEqual(plain(feature._buildMergePlan(quests[0], quests)), { targetActionHrid: '/actions/combat/swamp_planet', count: 50, taskCount: 2 });
        assert.equal(feature._buildMergePlan(quests[2], quests), null);
    });
});

describe('卡片圖示（照遊戲動作格挑圖規則）', () => {
    const hooks = createHooks();
    const feature = hooks.TaskInsightsFeature;
    const artworkOf = (quest) => plain(feature._resolveArtwork(feature._classifyQuest(quest, 0, new Set())));

    test('擠奶 / 伐木用動作圖；掉落或產出只有一種用該物品；多種掉落用動作圖；戰鬥用怪物圖', () => {
        assert.deepEqual(artworkOf(actionTask(1, '/actions/milking/cow')), { kind: 'actions', symbol: 'cow' });
        assert.deepEqual(artworkOf(actionTask(2, '/actions/woodcutting/tree')), { kind: 'actions', symbol: 'tree' });
        assert.deepEqual(artworkOf(actionTask(3, '/actions/foraging/egg')), { kind: 'items', symbol: 'egg' });
        assert.deepEqual(artworkOf(actionTask(4, '/actions/cheesesmithing/cheese')), { kind: 'items', symbol: 'cheese' });
        assert.deepEqual(artworkOf(actionTask(5, '/actions/foraging/farmland')), { kind: 'actions', symbol: 'farmland' });
        assert.deepEqual(artworkOf(monsterTask(6, '/monsters/fly')), { kind: 'combat_monsters', symbol: 'fly' });
    });

    test('sprite 網址：從 <use href> 或資源紀錄記下各種類的檔案，沒找到就不給網址', () => {
        assert.equal(feature._getSpriteHref('items', 'egg'), '');
        assert.equal(feature._registerSpriteSource('/static/media/items_sprite.f58c9476.svg#coin'), true);
        assert.equal(feature._registerSpriteSource('https://www.milkywayidle.com/static/media/combat_monsters_sprite.ddb69185.svg'), true);
        assert.equal(feature._registerSpriteSource('/static/media/chat_icons_sprite.5a021815.svg#x'), false);
        assert.equal(feature._getSpriteHref('items', 'egg'), '/static/media/items_sprite.f58c9476.svg#egg');
        assert.equal(feature._getSpriteHref('combat_monsters', 'fly'), 'https://www.milkywayidle.com/static/media/combat_monsters_sprite.ddb69185.svg#fly');
    });
});

describe('篩選鎖（GM 儲存，依伺服器 + 角色）', () => {
    test('只接受生活專業、戰鬥、地下城三種鍵', () => {
        const feature = createHooks().TaskInsightsFeature;
        assert.equal(feature._normalizeFilterLockKey('profession:milking'), 'profession:milking');
        assert.equal(feature._normalizeFilterLockKey('profession:combat'), '');
        assert.equal(feature._normalizeFilterLockKey('combat:combat'), 'combat:combat');
        assert.equal(feature._normalizeFilterLockKey('dungeon:/actions/combat/pirate_cove'), 'dungeon:/actions/combat/pirate_cove');
        assert.equal(feature._normalizeFilterLockKey('dungeon:/actions/combat/'), '');
        assert.equal(feature._normalizeFilterLockKey('garbage'), '');
    });

    test('切換鎖定會寫回儲存；登入時讀回來（壞鍵丟掉）；鎖定判斷依專業 / 戰鬥 / 地下城', () => {
        const hooks = createHooks();
        feedQuietly(hooks, characterData([]));
        const feature = hooks.TaskInsightsFeature;
        assert.equal(feature._toggleFilterLock('profession', 'milking'), true);
        assert.equal(feature._toggleFilterLock('dungeon', '/actions/combat/pirate_cove'), true);
        const stored = JSON.parse(hooks.gmStore.get('MWITools_taskFilterLocks_v1'));
        assert.deepEqual(stored.characters['www.milkywayidle.com:7'].locked, ['dungeon:/actions/combat/pirate_cove', 'profession:milking']);

        const cowRow = feature._classifyQuest(actionTask(1, '/actions/milking/cow'), 0, new Set());
        const eyeRow = feature._classifyQuest(monsterTask(2, '/monsters/eye'), 1, new Set());
        const flyRow = feature._classifyQuest(monsterTask(3, '/monsters/fly'), 2, new Set());
        assert.equal(feature._rowMatchesLockedFilter(cowRow), true);
        assert.equal(feature._rowMatchesLockedFilter(eyeRow), true);
        assert.equal(feature._rowMatchesLockedFilter(flyRow), false);
        assert.equal(feature._toggleFilterLock('profession', 'milking'), false);
        assert.equal(feature._rowMatchesLockedFilter(cowRow), false);
        assert.equal(feature._toggleFilterLock('profession', 'combat'), false);

        stored.characters['www.milkywayidle.com:7'].locked.push('profession:not_a_skill', 'combat:combat');
        const reloaded = createHooks({ gmValues: { MWITools_taskFilterLocks_v1: JSON.stringify(stored) } });
        feedQuietly(reloaded, characterData([]));
        assert.deepEqual([...reloaded.TaskInsightsFeature._lockedFilterKeys].sort(), ['combat:combat', 'dungeon:/actions/combat/pirate_cove', 'profession:milking']);
    });

    test('最多存 20 個角色（刪最舊的）；壞資料當空的', () => {
        const characters = {};
        for (let index = 0; index < 25; index++) characters[`www.milkywayidle.com:${100 + index}`] = { locked: ['combat:combat'], updatedAt: index };
        const hooks = createHooks({ gmValues: { MWITools_taskFilterLocks_v1: JSON.stringify({ version: 1, characters }) } });
        feedQuietly(hooks, characterData([]));
        hooks.TaskInsightsFeature._toggleFilterLock('combat', 'combat');
        const keys = Object.keys(JSON.parse(hooks.gmStore.get('MWITools_taskFilterLocks_v1')).characters);
        assert.equal(keys.length, 20);
        assert.ok(keys.includes('www.milkywayidle.com:7'));
        assert.ok(!keys.includes('www.milkywayidle.com:100'));

        const broken = createHooks({ gmValues: { MWITools_taskFilterLocks_v1: '{not json' } });
        const originalWarn = console.warn;
        console.warn = () => {};
        try {
            feedQuietly(broken, characterData([]));
        } finally {
            console.warn = originalWarn;
        }
        assert.equal(broken.TaskInsightsFeature._lockedFilterKeys.size, 0);
        broken.TaskInsightsFeature._toggleFilterLock('combat', 'combat');
        assert.deepEqual(JSON.parse(broken.gmStore.get('MWITools_taskFilterLocks_v1')).characters['www.milkywayidle.com:7'].locked, ['combat:combat']);
    });
});

describe('穩定順序與重置換位', () => {
    test('排過一次後已有位置的不動，新卡接在最後，消失的任務移除；還沒排過時回傳空（維持原生順序）', () => {
        const feature = createHooks().TaskInsightsFeature;
        const firstRows = feature._buildRows([actionTask(3, '/actions/foraging/egg'), actionTask(2, '/actions/milking/cow'), monsterTask(1, '/monsters/fly')], new Set());
        assert.equal(feature._assignOrders(firstRows, false, true).size, 0);
        assert.deepEqual(Object.fromEntries(feature._assignOrders(firstRows, true, true)), { 2: 1, 3: 2, 1: 3 });
        const laterRows = feature._buildRows([actionTask(9, '/actions/milking/cow'), actionTask(3, '/actions/foraging/egg'), monsterTask(1, '/monsters/fly')], new Set());
        assert.deepEqual(Object.fromEntries(feature._assignOrders(laterRows, false, true)), { 3: 2, 1: 3, 9: 4 });
    });

    test('同 id 重抽：內容換了 → 黏住可見；新 id：接手舊位置、黏住，且不算新領取', () => {
        const hooks = createHooks();
        feedQuietly(hooks, characterData([actionTask(6, '/actions/milking/cow'), actionTask(5, '/actions/foraging/egg')]));
        const feature = hooks.TaskInsightsFeature;
        feature._lastRows = [{ questId: '6', nativeIndex: 0 }, { questId: '5', nativeIndex: 1 }];
        feature._activeProfessionKeys = new Set(['foraging']);
        const card = createFakeCard(actionTask(5, '/actions/foraging/egg'));
        card.dataset.mwitoolsLocalTasksFiltered = 'false';

        feature._recordPendingReroll(card, Date.now());
        assert.equal(feature._hasExplicitOrder, true, '還沒排過時先固定目前位置');
        assert.equal(feature._pendingReroll.order, 2);
        assert.equal(feature._pendingReroll.isSticky, true);
        feature._resolvePendingReroll([actionTask(6, '/actions/milking/cow'), actionTask(5, '/actions/foraging/egg')], Date.now());
        assert.ok(feature._pendingReroll, '內容還沒換，繼續等');
        feature._resolvePendingReroll([actionTask(6, '/actions/milking/cow'), actionTask(5, '/actions/cooking/donut')], Date.now());
        assert.equal(feature._pendingReroll, null);
        assert.ok(feature._stickyQuestIds.has('5'));

        feature._recordPendingReroll(card, Date.now());
        feedQuietly(hooks, { type: 'quests_updated', endCharacterQuests: [actionTask(5, '/actions/foraging/egg', { status: '/quest_status/discarded' }), actionTask(9, '/actions/cooking/donut')] });
        assert.ok(hooks.TaskNewBadgeFeature._state.fresh.has('9'), '訊息進來時先被當成新任務');
        feature._resolvePendingReroll([actionTask(9, '/actions/cooking/donut'), actionTask(6, '/actions/milking/cow')], Date.now());
        assert.equal(feature._orderByQuestId.get('9'), 2);
        assert.ok(feature._stickyQuestIds.has('9'));
        assert.ok(!hooks.TaskNewBadgeFeature._state.fresh.has('9'), '自己重置換來的任務不標新');
    });

    test('30 秒內沒等到就作廢；舊任務消失但新任務還沒到時繼續等', () => {
        const feature = createHooks().TaskInsightsFeature;
        feature._lastRows = [{ questId: '5', nativeIndex: 0 }];
        feature._recordPendingReroll(createFakeCard(actionTask(5, '/actions/foraging/egg')), Date.now());
        feature._resolvePendingReroll([], Date.now());
        assert.ok(feature._pendingReroll);
        feature._pendingReroll.clickedAt = Date.now() - 31000;
        feature._resolvePendingReroll([actionTask(8, '/actions/milking/cow')], Date.now());
        assert.equal(feature._pendingReroll, null);
        assert.equal(feature._orderByQuestId.has('8'), false);
    });
});

describe('卡片 / 按鈕辨識（React fiber 與 CSS 模組類名）', () => {
    const feature = createHooks().TaskInsightsFeature;

    test('卡片任務：fiber 往上找 props.characterQuest；讀不到回傳 null', () => {
        const quest = actionTask(5, '/actions/milking/cow');
        assert.equal(feature.readCardQuest(createFakeCard(quest)), quest);
        assert.equal(feature.readCardQuest({}), null);
        assert.equal(feature.readCardQuest(null), null);
    });

    test('「前往」= 任務卡按鈕區裡的 Button_success；未讀任務橫幅的「讀取」、領取獎勵（Button_buy）都不是', () => {
        const card = { className: 'RandomTask_randomTask__3B9fA' };
        const buttonsContainer = { className: 'RandomTask_buttonsContainer__32ypF', closest: (selector) => (selector.includes('RandomTask_randomTask') ? card : null) };
        const unreadContainer = { className: 'TasksPanel_buttonContainer__1R8ee', closest: () => null };
        const goButton = { tagName: 'BUTTON', className: 'Button_button__1Fe9z Button_success__6d6kU', parentElement: buttonsContainer };
        const claimButton = { tagName: 'BUTTON', className: 'Button_button__1Fe9z Button_buy__3s24l', parentElement: buttonsContainer };
        const readButton = { tagName: 'BUTTON', className: 'Button_button__1Fe9z Button_success__6d6kU Button_fullWidth__17pVU', parentElement: unreadContainer };
        assert.equal(feature.isTaskGoButton(goButton), true);
        assert.equal(feature.isTaskGoButton(claimButton), false);
        assert.equal(feature.isTaskGoButton(readButton), false);
        assert.equal(feature.isTaskGoButton(null), false);
    });

    test('重置選項 / 放棄確認開著：遊戲 state 為真時視為互動中', () => {
        assert.equal(feature._isCardInteractionOpen(createFakeCard(actionTask(1, '/actions/milking/cow'), { showRerollOptions: true, showDiscardConfirmation: false })), true);
        assert.equal(feature._isCardInteractionOpen(createFakeCard(actionTask(1, '/actions/milking/cow'))), false);
    });
});

describe('設定', () => {
    test('子設定依賴主設定；地下城角標另外依賴卡片圖示', () => {
        const hooks = createHooks();
        const feature = hooks.TaskInsightsFeature;
        assert.equal(feature._isEnabled('taskDungeonIcons'), true);
        hooks.settingsMap.taskIcons.isTrue = false;
        assert.equal(feature._isEnabled('taskDungeonIcons'), false);
        hooks.settingsMap.taskIcons.isTrue = true;
        hooks.settingsMap.taskInsights.isTrue = false;
        assert.equal(feature._isEnabled('taskStatistics'), false);
    });

    test('主設定關閉（存在 localStorage）：收到訊息也不記任何東西、不寫儲存', () => {
        const hooks = createHooks({ localStorageValues: { script_settingsMap: JSON.stringify({ taskInsights: { id: 'taskInsights', isTrue: false } }) } });
        assert.equal(hooks.settingsMap.taskInsights.isTrue, false);
        feedQuietly(hooks, characterData([actionTask(1, '/actions/milking/cow')], { characterItems: [inventoryItem('/items/milk', 5)] }));
        assert.equal(hooks.TaskInsightsFeature._questsById.size, 0);
        assert.equal(hooks.TaskInsightsFeature._inventoryCountByItemHrid.size, 0);
        assert.equal(hooks.gmStore.has('MWITools_taskNewState_v1'), false);
        assert.equal(hooks.gmStore.has('MWITools_taskFilterLocks_v1'), false);
    });
});
