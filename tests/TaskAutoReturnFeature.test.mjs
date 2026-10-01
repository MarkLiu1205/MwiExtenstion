// 任務自動返回（TaskAutoReturnFeature）：預期導覽頁、按「前往」記住任務、等動作視窗出現 / 關閉、導覽頁不符或逾時取消、回任務頁後置中卡片（node --test 'tests/*.test.mjs'）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadMwiToolsScript } from './MwiToolsScriptLoader.mjs';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const actionDetailMap = JSON.parse(readFileSync(join(repositoryRoot, 'simulator/src/combatsimulator/data/actionDetailMap.json'), 'utf8'));
const actionTask = (id, actionHrid, fields = {}) => ({
    id,
    category: '/quest_category/random_task',
    type: '/quest_type/action',
    actionHrid,
    monsterHrid: '',
    status: '/quest_status/in_progress',
    goalCount: 10,
    currentCount: 0,
    ...fields,
});
const monsterTask = (id, monsterHrid) => ({ ...actionTask(id, ''), type: '/quest_type/monster', monsterHrid });
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
        hooks = loadMwiToolsScript(['TaskAutoReturnFeature', 'TaskInsightsFeature', 'settingsMap'], options);
    } finally {
        console.error = originalError;
    }
    feedQuietly(hooks, { type: 'init_client_data', itemDetailMap: {}, actionDetailMap, actionCategoryDetailMap: {}, openableLootDropMap: {}, combatMonsterDetailMap: {} });
    return hooks;
}

// 假的遊戲畫面：GamePage（fiber 上有 handleChangeNavTarget 與 state.navTarget）、動作視窗、任務卡與「前往」鈕
function createFakeGame(hooks, navigationTarget = 'tasks') {
    const game = {
        navigationTarget,
        navigationCalls: [],
        actionPanels: [],
        navigationLinks: [],
        taskList: null,
    };
    const gamePageInstance = {
        state: { navTarget: navigationTarget },
        handleChangeNavTarget: (target) => {
            game.navigationCalls.push(target);
            gamePageInstance.state.navTarget = target;
        },
    };
    game.gamePageInstance = gamePageInstance;
    game.gamePageElement = { '__reactFiber$test': { stateNode: null, return: { stateNode: gamePageInstance, return: null } } };
    const document = hooks.sandbox.document;
    document.querySelector = (selector) => {
        if (selector.includes('GamePage_gamePage')) return game.gamePageElement;
        if (selector.includes('TasksPanel_taskList')) return game.taskList;
        return null;
    };
    document.querySelectorAll = (selector) => {
        if (selector.includes('SkillActionDetail_skillActionDetail')) return game.actionPanels.filter((panel) => panel.isConnected);
        if (selector.includes('NavigationBar_navigationLink')) return game.navigationLinks;
        return [];
    };
    return game;
}

function createTaskCard(quest) {
    const card = {
        className: 'RandomTask_randomTask__3B9fA',
        dataset: {},
        parentElement: null,
        '__reactFiber$test': { memoizedProps: {}, stateNode: {}, return: { memoizedProps: { characterQuest: quest }, stateNode: { state: {} }, return: null } },
        closest: (selector) => (selector.includes('RandomTask_randomTask') ? card : null),
        getBoundingClientRect: () => ({ top: 0, height: 0 }),
    };
    const buttonsContainer = { className: 'RandomTask_buttonsContainer__32ypF', closest: (selector) => (selector.includes('RandomTask_randomTask') ? card : null) };
    const goButton = {
        tagName: 'BUTTON',
        className: 'Button_button__1Fe9z Button_success__6d6kU',
        parentElement: buttonsContainer,
        closest: (selector) => (selector === 'button' ? goButton : selector.includes('RandomTask_randomTask') ? card : null),
    };
    return { card, goButton };
}

describe('預期的導覽頁（遊戲 handleGoToAction / handleGoToMonster）', () => {
    test('動作任務 = 動作類型最後一段；怪物任務 = combat；沒有動作資料時用 hrid 第二段', () => {
        const feature = createHooks().TaskAutoReturnFeature;
        assert.equal(feature._getExpectedNavigationTarget(actionTask(1, '/actions/milking/cow')), 'milking');
        assert.equal(feature._getExpectedNavigationTarget(actionTask(2, '/actions/cheesesmithing/cheese')), 'cheesesmithing');
        assert.equal(feature._getExpectedNavigationTarget(monsterTask(3, '/monsters/fly')), 'combat');
        assert.equal(feature._getExpectedNavigationTarget(actionTask(4, '/actions/fishing/trout')), 'fishing');
    });
});

describe('從「前往」到返回任務頁', () => {
    test('按「前往」記住任務；動作視窗出現後關閉、遊戲還在預期頁 → 切回任務頁', () => {
        const hooks = createHooks();
        const feature = hooks.TaskAutoReturnFeature;
        const game = createFakeGame(hooks);
        const { goButton } = createTaskCard(actionTask(5, '/actions/milking/cow'));
        feature._handleDocumentClick({ target: goButton });
        assert.equal(feature._pendingReturn.questId, '5');
        assert.equal(feature._pendingReturn.expectedNavigationTarget, 'milking');

        // 遊戲切到擠奶頁並打開動作視窗
        game.gamePageInstance.state.navTarget = 'milking';
        const now = Date.now();
        feature._checkActionPanel(now);
        assert.equal(feature._pendingReturn.panelElement, null, '視窗還沒出現就繼續等');
        const panel = { isConnected: true };
        game.actionPanels.push(panel);
        feature._checkActionPanel(now);
        assert.equal(feature._pendingReturn.panelElement, panel);
        feature._checkActionPanel(now);
        assert.deepEqual(game.navigationCalls, [], '視窗開著時不返回');

        // React 換掉同一個視窗的元素：改追新元素，不提早返回
        panel.isConnected = false;
        const replacement = { isConnected: true };
        game.actionPanels.push(replacement);
        feature._checkActionPanel(now);
        assert.equal(feature._pendingReturn.panelElement, replacement);
        assert.deepEqual(game.navigationCalls, []);

        // 按了開始 / 加入佇列（或關閉）：視窗消失
        replacement.isConnected = false;
        feature._checkActionPanel(now);
        assert.deepEqual(game.navigationCalls, ['tasks']);
        assert.equal(feature._pendingReturn, null);
        assert.equal(feature._returnTarget.questId, '5');
        assert.equal(feature.isResumingVisit(now), true);
        assert.equal(feature.isResumingVisit(now + 6000), false, '5 秒內沒置中就不算返回造訪');
    });

    test('視窗關閉時遊戲已經不在預期頁（例如佇列滿跳到牛鈴商店）→ 不返回', () => {
        const hooks = createHooks();
        const feature = hooks.TaskAutoReturnFeature;
        const game = createFakeGame(hooks);
        const { goButton } = createTaskCard(monsterTask(6, '/monsters/fly'));
        feature._handleDocumentClick({ target: goButton });
        game.gamePageInstance.state.navTarget = 'combat';
        const panel = { isConnected: true };
        game.actionPanels.push(panel);
        feature._checkActionPanel(Date.now());
        game.gamePageInstance.state.navTarget = 'cowbell store';
        panel.isConnected = false;
        feature._checkActionPanel(Date.now());
        assert.deepEqual(game.navigationCalls, []);
        assert.equal(feature._pendingReturn, null);
        assert.equal(feature._returnTarget, null);
    });

    test('30 秒內沒出現動作視窗就作廢；有返回在等時點導覽列 = 自己換頁，取消', () => {
        const hooks = createHooks();
        const feature = hooks.TaskAutoReturnFeature;
        createFakeGame(hooks);
        const { goButton } = createTaskCard(actionTask(7, '/actions/foraging/egg'));
        feature._handleDocumentClick({ target: goButton });
        feature._checkActionPanel(Date.now() + 29000);
        assert.ok(feature._pendingReturn);
        feature._checkActionPanel(Date.now() + 31000);
        assert.equal(feature._pendingReturn, null);

        feature._handleDocumentClick({ target: goButton });
        const navigationLink = { closest: (selector) => (selector.includes('NavigationBar_navigationLink') ? navigationLink : null) };
        feature._handleDocumentClick({ target: navigationLink });
        assert.equal(feature._pendingReturn, null);
    });

    test('找不到 GamePage 元件時點導覽列的「任務」連結（React key = tasks），而且不會被自己的點擊監聽取消', () => {
        const hooks = createHooks();
        const feature = hooks.TaskAutoReturnFeature;
        const game = createFakeGame(hooks);
        game.gamePageElement = {};
        let clickCount = 0;
        const otherLink = { '__reactFiber$test': { key: 'marketplace' }, click: () => assert.fail('不應該點到其他連結') };
        const tasksLink = {
            '__reactFiber$test': { key: 'tasks' },
            closest: (selector) => (selector.includes('NavigationBar_navigationLink') ? tasksLink : null),
            // 模擬瀏覽器：click() 會經過 document 的 capture 監聽
            click: () => {
                clickCount += 1;
                feature._handleDocumentClick({ target: tasksLink });
            },
        };
        game.navigationLinks.push(otherLink, tasksLink);
        const { goButton } = createTaskCard(actionTask(8, '/actions/milking/cow'));
        feature._handleDocumentClick({ target: goButton });
        const panel = { isConnected: true };
        game.actionPanels.push(panel);
        feature._checkActionPanel(Date.now());
        panel.isConnected = false;
        feature._checkActionPanel(Date.now());
        assert.equal(clickCount, 1);
        assert.equal(feature._returnTarget?.questId, '8');
    });

    test('重新登入（init_character_data）取消返回', () => {
        const hooks = createHooks();
        const feature = hooks.TaskAutoReturnFeature;
        createFakeGame(hooks);
        const { goButton } = createTaskCard(actionTask(9, '/actions/milking/cow'));
        feature._handleDocumentClick({ target: goButton });
        feedQuietly(hooks, characterData([]));
        assert.equal(feature._pendingReturn, null);
    });

    test('設定關閉：按「前往」不記任何東西', () => {
        const hooks = createHooks({ localStorageValues: { script_settingsMap: JSON.stringify({ taskAutoReturn: { id: 'taskAutoReturn', isTrue: false } }) } });
        const feature = hooks.TaskAutoReturnFeature;
        createFakeGame(hooks);
        const { goButton } = createTaskCard(actionTask(10, '/actions/milking/cow'));
        feature._handleDocumentClick({ target: goButton });
        assert.equal(feature._pendingReturn, null);
    });
});

describe('回到任務頁後的位置', () => {
    test('卡片置中在捲動容器裡（超出範圍時夾住）', () => {
        const feature = createHooks().TaskAutoReturnFeature;
        const scroller = { scrollTop: 0, clientHeight: 500, scrollHeight: 3000, getBoundingClientRect: () => ({ top: 100 }) };
        const card = { getBoundingClientRect: () => ({ top: 900, height: 100 }) };
        feature._centerCardInScroller(card, scroller);
        assert.equal(scroller.scrollTop, 600);
        const shortScroller = { scrollTop: 0, clientHeight: 500, scrollHeight: 800, getBoundingClientRect: () => ({ top: 100 }) };
        feature._centerCardInScroller(card, shortScroller);
        assert.equal(shortScroller.scrollTop, 300);
    });

    test('找到原任務卡就置中；卡片不見了（例如已領取）就還原原本的捲動位置', () => {
        const hooks = createHooks();
        const feature = hooks.TaskAutoReturnFeature;
        const game = createFakeGame(hooks);
        hooks.sandbox.getComputedStyle = (element) => element.fakeStyle || {};
        const scroller = { fakeStyle: { overflowY: 'auto', overflow: 'hidden auto' }, scrollTop: 0, clientHeight: 400, scrollHeight: 2000, getBoundingClientRect: () => ({ top: 0 }), parentElement: null };
        const { card } = createTaskCard(actionTask(11, '/actions/milking/cow'));
        card.parentElement = scroller;
        card.getBoundingClientRect = () => ({ top: 1000, height: 100 });
        game.taskList = { children: [card], parentElement: scroller };

        feature._returnTarget = { questId: '11', scrollTop: 50, startedAt: Date.now() };
        feature._restorePosition(Date.now());
        assert.equal(scroller.scrollTop, 850);
        assert.equal(feature._returnTarget, null);

        feature._returnTarget = { questId: '99', scrollTop: 120, startedAt: Date.now() };
        feature._restorePosition(Date.now());
        assert.equal(scroller.scrollTop, 120);
    });
});
