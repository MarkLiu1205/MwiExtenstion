// 公會經驗：序列記錄 / 壓縮 / 合併、速率、7 天趨勢、預計升級、閒置判斷、訊息處理與 GM 儲存（node --test 'tests/*.test.mjs'）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadMwiToolsScript } from './MwiToolsScriptLoader.mjs';

const MINUTE = 60000;
const HOUR = 3600000;
const DAY = 24 * HOUR;
// 對齊整點，方便推算 10 / 20 分鐘的時間桶
const BASE_TIME = 1790000000000 - (1790000000000 % HOUR);
const GUILD_HISTORY_KEY = 'MWITools_guildExperienceHistory_v1';
const LEADERBOARD_HISTORY_KEY = 'MWITools_guildLeaderboardHistory_v1';

// 沙盒裡建立的物件跟測試不在同一個 realm，比較前先轉成一般 JSON 資料
const plain = (value) => JSON.parse(JSON.stringify(value));

function loadFeature(options = {}) {
    const hooks = loadMwiToolsScript(['GuildExperienceFeature', 'settingsMap'], options);
    return { hooks, feature: hooks.GuildExperienceFeature };
}

// 每 stepMs 一點、每小時增加 ratePerHour 的序列（最後一點在 endAt）
function buildLinearSeries(endAt, durationMs, stepMs, ratePerHour, endXp) {
    const points = [];
    for (let at = endAt - durationMs; at <= endAt; at += stepMs) {
        points.push({ at, xp: endXp - ((endAt - at) / HOUR) * ratePerHour });
    }
    return points;
}

// init_character_data 要帶 mwiTools 本身會讀的欄位，否則 mwiTools 會先丟錯
function createCharacterData(overrides = {}) {
    return {
        type: 'init_character_data',
        character: { id: 7, name: 'Me' },
        characterSkills: [],
        characterItems: [],
        characterHouseRoomMap: {},
        actionTypeDrinkSlotsMap: {},
        characterAbilities: [],
        myMarketListings: [],
        combatUnit: { combatAbilities: [] },
        characterActions: [],
        guild: { id: 55, name: 'My Guild', level: 3, experience: 100 },
        guildCharacterMap: {
            7: { characterID: 7, status: 'joined', guildExperience: 10.5 },
            8: { characterID: 8, status: 'joined', guildExperience: 20 },
            9: { characterID: 9, status: 'invited', guildExperience: 0 },
        },
        guildSharableCharacterMap: {
            7: { name: 'Me', actionType: '', isOnline: true, hideOnlineStatus: false },
            8: { name: 'Alice', actionType: '', isOnline: true, hideOnlineStatus: false },
            9: { name: 'Invitee', actionType: '', isOnline: true, hideOnlineStatus: false },
        },
        ...overrides,
    };
}

function createLeaderboardMessage(overrides = {}) {
    return {
        type: 'leaderboard_updated',
        leaderboardType: 'guild',
        leaderboardCategory: 'guild',
        guildTypeFilter: '',
        gameModeFilter: '',
        trialFilter: '',
        leaderboardRevision: 3,
        leaderboard: {
            type: 'guild',
            category: 'guild',
            columnNames: ['leaderboardPanel.level', 'leaderboardPanel.experience'],
            rows: [
                { rank: 1, name: 'Alpha', id: 101, value1: 40, value2: 900000 },
                { rank: 2, name: 'Beta', id: 102, value1: 35, value2: 500000 },
            ],
        },
        personalRow: { rank: 12, name: 'My Guild', id: 55, value1: 3, value2: 100 },
        ...overrides,
    };
}

describe('序列：加觀測與壓縮', () => {
    const { feature } = loadFeature();
    const guildPolicy = feature._guildSeriesPolicy;
    const memberPolicy = feature._memberSeriesPolicy;
    const leaderboardPolicy = feature._leaderboardSeriesPolicy;

    test('第一點、同一個 10 分鐘桶取代、跨桶追加，傳入的陣列不被改動', () => {
        const first = feature._appendObservation([], BASE_TIME, 50, guildPolicy);
        assert.deepEqual(plain(first), [{ at: BASE_TIME, xp: 50 }]);
        const sameBucket = feature._appendObservation(first, BASE_TIME + 5 * MINUTE, 60, guildPolicy);
        assert.deepEqual(plain(sameBucket), [{ at: BASE_TIME + 5 * MINUTE, xp: 60 }]);
        const nextBucket = feature._appendObservation(sameBucket, BASE_TIME + 11 * MINUTE, 70, guildPolicy);
        assert.deepEqual(plain(nextBucket), [
            { at: BASE_TIME + 5 * MINUTE, xp: 60 },
            { at: BASE_TIME + 11 * MINUTE, xp: 70 },
        ]);
        assert.equal(first.length, 1);
        assert.equal(sameBucket.length, 1);
    });

    test('經驗沒變：公會 / 成員照記（閒置期間速率才會降下來），排行榜舊快照不記', () => {
        const start = [{ at: BASE_TIME, xp: 100 }];
        const flatGuild = feature._appendObservation(start, BASE_TIME + 30 * MINUTE, 100, guildPolicy);
        assert.equal(flatGuild.length, 2);
        const flatLeaderboard = feature._appendObservation(start, BASE_TIME + 30 * MINUTE, 100, leaderboardPolicy);
        assert.equal(flatLeaderboard, start);
    });

    test('經驗變小：成員從新值重新開始（例如退出又加入），排行榜當成更舊的快照忽略', () => {
        const start = [
            { at: BASE_TIME, xp: 100 },
            { at: BASE_TIME + HOUR, xp: 200 },
        ];
        assert.deepEqual(plain(feature._appendObservation(start, BASE_TIME + 2 * HOUR, 5, memberPolicy)), [{ at: BASE_TIME + 2 * HOUR, xp: 5 }]);
        assert.equal(feature._appendObservation(start, BASE_TIME + 2 * HOUR, 150, leaderboardPolicy), start);
    });

    test('時間倒退、同一毫秒同一個值、非數字、負數都忽略；同一毫秒的新值取代；小數留兩位', () => {
        const start = [{ at: BASE_TIME, xp: 100 }];
        assert.equal(feature._appendObservation(start, BASE_TIME - MINUTE, 120, guildPolicy), start);
        assert.equal(feature._appendObservation(start, BASE_TIME, 100, guildPolicy), start);
        // 兩則訊息在同一毫秒處理時，後到的是比較新的值
        assert.deepEqual(plain(feature._appendObservation(start, BASE_TIME, 120, guildPolicy)), [{ at: BASE_TIME, xp: 120 }]);
        assert.equal(feature._appendObservation(start, BASE_TIME + HOUR, 'abc', guildPolicy), start);
        assert.equal(feature._appendObservation(start, BASE_TIME + HOUR, -1, guildPolicy), start);
        assert.equal(feature._appendObservation(start, Number.NaN, 120, guildPolicy), start);
        const decimal = feature._appendObservation([], BASE_TIME, 12.3456, memberPolicy);
        assert.equal(decimal[0].xp, 12.35);
    });

    test('壓縮：超過保留期丟掉；24 小時內每 10 分鐘一點、更舊每小時一點，結果依時間排序', () => {
        const now = BASE_TIME + 10 * DAY;
        const points = [
            { at: now - 9 * DAY, xp: 1 },
            { at: now - 2 * DAY, xp: 2 },
            { at: now - 2 * DAY + 20 * MINUTE, xp: 3 },
            { at: now - 2 * HOUR, xp: 4 },
            { at: now - 2 * HOUR + 5 * MINUTE, xp: 5 },
            { at: now - 2 * HOUR + 15 * MINUTE, xp: 6 },
        ];
        assert.deepEqual(plain(feature._compactSeries(points, now, guildPolicy)), [
            { at: now - 2 * DAY + 20 * MINUTE, xp: 3 },
            { at: now - 2 * HOUR + 5 * MINUTE, xp: 5 },
            { at: now - 2 * HOUR + 15 * MINUTE, xp: 6 },
        ]);
        // 成員只留 26 小時
        assert.deepEqual(
            plain(feature._compactSeries([{ at: now - 27 * HOUR, xp: 1 }, { at: now - HOUR, xp: 2 }], now, memberPolicy)),
            [{ at: now - HOUR, xp: 2 }]
        );
    });

    test('整理 / 合併：兩個分頁的點取聯集、同時間去重；成員遇到變小從那點重來；排行榜同值留第一次、變小的丟掉', () => {
        const now = BASE_TIME + 3 * HOUR;
        const tabA = [{ at: BASE_TIME, xp: 10 }, { at: BASE_TIME + HOUR, xp: 20 }];
        const tabB = [{ at: BASE_TIME + HOUR, xp: 20 }, { at: BASE_TIME + 2 * HOUR, xp: 30 }];
        assert.deepEqual(plain(feature._mergeSeries(tabA, tabB, now, guildPolicy)), [
            { at: BASE_TIME, xp: 10 },
            { at: BASE_TIME + HOUR, xp: 20 },
            { at: BASE_TIME + 2 * HOUR, xp: 30 },
        ]);
        const restarted = feature._normalizeSeries(
            [{ at: BASE_TIME + 2 * HOUR, xp: 3 }, { at: BASE_TIME, xp: 10 }, { at: BASE_TIME + HOUR, xp: 20 }, { at: BASE_TIME + 3 * HOUR, xp: 8 }],
            memberPolicy
        );
        assert.deepEqual(plain(restarted), [{ at: BASE_TIME + 2 * HOUR, xp: 3 }, { at: BASE_TIME + 3 * HOUR, xp: 8 }]);
        const leaderboard = feature._normalizeSeries(
            [{ at: BASE_TIME, xp: 100 }, { at: BASE_TIME + 20 * MINUTE, xp: 100 }, { at: BASE_TIME + 40 * MINUTE, xp: 90 }, { at: BASE_TIME + HOUR, xp: 130 }, { at: 'x', xp: 1 }],
            leaderboardPolicy
        );
        assert.deepEqual(plain(leaderboard), [{ at: BASE_TIME, xp: 100 }, { at: BASE_TIME + HOUR, xp: 130 }]);
    });
});

describe('速率與趨勢', () => {
    const { feature } = loadFeature();

    test('每小時 100：近 6 小時與 24 小時速率、增加量與涵蓋時間', () => {
        const now = BASE_TIME + 30 * HOUR;
        const points = buildLinearSeries(now, 30 * HOUR, 30 * MINUTE, 100, 5000);
        const rates = feature._calculateRates(points, now);
        assert.ok(Math.abs(rates.recent.rate - 100) < 1e-9);
        assert.ok(Math.abs(rates.day.rate - 100) < 1e-9);
        assert.equal(rates.day.gained, 2400);
        assert.equal(rates.day.coveredMs, 24 * HOUR);
        assert.equal(rates.recent.coveredMs, 6 * HOUR);
        assert.equal(rates.lastSampleAt, now);
        assert.equal(rates.sampleCount, points.length);
    });

    test('涵蓋不足：近 6 小時至少 1 小時、24 小時至少 12 小時，否則 null', () => {
        const now = BASE_TIME + 30 * HOUR;
        const halfHour = buildLinearSeries(now, 30 * MINUTE, 10 * MINUTE, 100, 5000);
        assert.equal(feature._calculateRates(halfHour, now).recent, null);
        const eightHours = buildLinearSeries(now, 8 * HOUR, 30 * MINUTE, 100, 5000);
        const rates = feature._calculateRates(eightHours, now);
        assert.ok(Math.abs(rates.recent.rate - 100) < 1e-9);
        assert.equal(rates.day, null);
        assert.equal(feature._calculateRates([], now).recent, null);
        assert.equal(feature._calculateRates([], now).lastSampleAt, null);
    });

    test('經驗不變也有紀錄時，閒置期間速率會下降（修正上游只記增加造成的偏高）', () => {
        const now = BASE_TIME + 24 * HOUR;
        // 前 12 小時每小時 100，後 12 小時沒練（每 30 分鐘仍有一筆不變的觀測）
        const points = [];
        for (let hour = 0; hour <= 24; hour += 0.5) {
            points.push({ at: BASE_TIME + hour * HOUR, xp: Math.min(hour, 12) * 100 });
        }
        const rates = feature._calculateRates(points, now);
        assert.ok(Math.abs(rates.day.rate - 50) < 1e-9);
        assert.equal(rates.recent.rate, 0);
    });

    test('經驗反向（最後一筆比第一筆小）不算速率', () => {
        const now = BASE_TIME + 2 * HOUR;
        assert.equal(feature._calculateWindowRate([{ at: BASE_TIME, xp: 50 }, { at: now, xp: 40 }], 6 * HOUR, HOUR, now), null);
    });

    test('趨勢：每點用 6 小時內最早的點；不到 1 小時改用至少 1 小時前的點；7 天前的點不畫', () => {
        const now = BASE_TIME + 3 * DAY;
        const dense = buildLinearSeries(now, 3 * DAY, HOUR, 100, 10000);
        const trend = feature._buildTrendPoints(dense, now);
        assert.equal(trend.length, dense.length - 1);
        assert.ok(trend.every((point) => Math.abs(point.rate - 100) < 1e-9));
        const sparse = [
            { at: BASE_TIME, xp: 0 },
            { at: BASE_TIME + 30 * MINUTE, xp: 50 },
            { at: BASE_TIME + 2 * HOUR, xp: 200 },
        ];
        assert.deepEqual(plain(feature._buildTrendPoints(sparse, BASE_TIME + 2 * HOUR)), [{ at: BASE_TIME + 2 * HOUR, rate: 100 }]);
        const gap = [
            { at: BASE_TIME, xp: 0 },
            { at: BASE_TIME + 10 * HOUR, xp: 1000 },
            { at: BASE_TIME + 10.5 * HOUR, xp: 1050 },
        ];
        assert.deepEqual(plain(feature._buildTrendPoints(gap, BASE_TIME + 11 * HOUR)), [
            { at: BASE_TIME + 10 * HOUR, rate: 100 },
            { at: BASE_TIME + 10.5 * HOUR, rate: 100 },
        ]);
        const old = [{ at: now - 8 * DAY, xp: 0 }, { at: now - 7.5 * DAY, xp: 100 }, { at: now - HOUR, xp: 200 }];
        assert.equal(feature._buildTrendPoints(old, now).length, 1);
    });

    test('Y 軸上限：每格 1 / 2 / 5 / 10 × 10 的次方、共 4 格', () => {
        assert.equal(feature._getNiceRateCeiling(0), 1);
        assert.equal(feature._getNiceRateCeiling(-5), 1);
        assert.equal(feature._getNiceRateCeiling(123), 200);
        assert.equal(feature._getNiceRateCeiling(400), 400);
        assert.equal(feature._getNiceRateCeiling(401), 800);
        assert.equal(feature._getNiceRateCeiling(9000), 20000);
    });

    test('趨勢圖：少於 2 點顯示樣本不足；否則 5 個 Y 刻度、4 個 X 刻度、折線點數 = 資料點數', () => {
        const emptyMarkup = feature._buildTrendSvgMarkup([]);
        assert.match(emptyMarkup, /trend-empty/);
        assert.match(emptyMarkup, /Not enough data/);
        assert.doesNotMatch(emptyMarkup, /polyline/);
        const ratePoints = [
            { at: BASE_TIME, rate: 100 },
            { at: BASE_TIME + HOUR, rate: 300 },
            { at: BASE_TIME + 2 * HOUR, rate: 200 },
        ];
        const markup = feature._buildTrendSvgMarkup(ratePoints);
        assert.equal(markup.match(/trend-y-tick/g).length, 5);
        assert.equal(markup.match(/trend-x-tick/g).length, 4);
        const polylinePoints = markup.match(/<polyline[^>]*points="([^"]*)"/)[1].split(' ');
        assert.equal(polylinePoints.length, 3);
        // 第一點在左邊界、最後一點在右邊界；300 對上限 400 → 高度 3/4
        assert.equal(polylinePoints[0].split(',')[0], '58');
        assert.equal(polylinePoints[2].split(',')[0], '508');
        assert.equal(polylinePoints[1].split(',')[1], '45');
        assert.match(markup, /role="img"/);
    });

    test('預計升級：24 小時優先、退近 6 小時、都沒有、最高等級、等級表未載入', () => {
        const table = [0, 0, 33, 76, 132];
        const dayRates = { day: { rate: 13 }, recent: { rate: 26 } };
        assert.deepEqual(plain(feature._estimateLevelEta(2, 50, dayRates, table)), { kind: 'estimate', hours: 2, basis: 'day', remaining: 26, rate: 13 });
        const recentOnly = { day: null, recent: { rate: 26 } };
        assert.deepEqual(plain(feature._estimateLevelEta(2, 50, recentOnly, table)), { kind: 'estimate', hours: 1, basis: 'recent', remaining: 26, rate: 26 });
        assert.deepEqual(plain(feature._estimateLevelEta(2, 50, { day: null, recent: null }, table)), { kind: 'insufficient', remaining: 26 });
        assert.equal(feature._estimateLevelEta(4, 140, dayRates, table).kind, 'maxLevel');
        assert.equal(feature._estimateLevelEta(2, 50, dayRates, null).kind, 'unknown');
        assert.equal(feature._estimateLevelEta(Number.NaN, 50, dayRates, table).kind, 'unknown');
    });

    test('速率文字：有值、等待採樣（沒有紀錄）、樣本不足（涵蓋不夠）；小於 1 也看得出來', () => {
        const withValue = feature._describeRate({ rate: 1234.5, gained: 24000, coveredMs: 13.5 * HOUR }, 30, 24, 12, 'waiting', true);
        assert.equal(withValue.text, '1.2k');
        assert.equal(withValue.isEmpty, false);
        assert.match(withValue.title, /13\.5/);
        const waiting = feature._describeRate(null, 0, 24, 12, 'waiting title', true);
        assert.deepEqual([waiting.text, waiting.title, waiting.isEmpty, waiting.value], ['Waiting', 'waiting title', true, -1]);
        const insufficient = feature._describeRate(null, 3, 24, 12, 'waiting', false);
        assert.equal(insufficient.text, 'Not enough data');
        assert.match(insufficient.title, /12 hours/);
        assert.equal(feature._formatAmount(0.5), '0.50');
        assert.equal(feature._formatAmount(42), '42');
    });

    test('中文介面文字', () => {
        const { feature: chineseFeature } = loadFeature({ localStorageValues: { i18nextLng: 'zh' } });
        assert.equal(chineseFeature._describeRate(null, 0, 24, 12, '', true).text, '等待採樣');
        assert.equal(chineseFeature._describeRate(null, 2, 24, 12, '', true).text, '樣本不足');
        assert.match(chineseFeature._buildTrendSvgMarkup([]), /樣本不足/);
        assert.equal(chineseFeature._describeEta({ kind: 'maxLevel' }, BASE_TIME).text, '已達最高等級');
    });
});

describe('閒置與排序', () => {
    const { feature } = loadFeature();
    const joined = { status: 'joined' };

    test('在線、沒隱藏、沒有動作 → 閒置；有動作 / 離線 / 隱藏 / 邀請中 → 不算', () => {
        const idle = { actionType: '', isOnline: true, hideOnlineStatus: false };
        assert.equal(feature._isMemberIdle(joined, idle, false, 3, true), true);
        assert.equal(feature._isMemberIdle(joined, { ...idle, actionType: '/action_types/milking' }, false, 3, true), false);
        assert.equal(feature._isMemberIdle(joined, { ...idle, isOnline: false }, false, 3, true), false);
        assert.equal(feature._isMemberIdle(joined, { ...idle, hideOnlineStatus: true }, false, 3, true), false);
        assert.equal(feature._isMemberIdle({ status: 'invited' }, idle, false, 3, true), false);
        assert.equal(feature._isMemberIdle(joined, undefined, false, 3, true), false);
    });

    test('沒帶 actionType：同一份資料有人帶這個欄位才當作沒在做事，整份都沒有就不判斷', () => {
        const withoutActionType = { isOnline: true };
        assert.equal(feature._isMemberIdle(joined, withoutActionType, false, 0, true), true);
        assert.equal(feature._isMemberIdle(joined, withoutActionType, false, 0, false), false);
    });

    test('自己的角色看本地動作佇列', () => {
        assert.equal(feature._isMemberIdle(joined, { isOnline: false }, true, 0, true), true);
        assert.equal(feature._isMemberIdle(joined, { actionType: '' }, true, 1, true), false);
    });

    test('排序比較：沒有值的排最後，同值保持原順序；由大到小 / 由小到大', () => {
        const entries = [
            { value: 5, index: 0 },
            { value: -1, index: 1 },
            { value: 20, index: 2 },
            { value: 5, index: 3 },
        ];
        feature._memberSortDirection = 'desc';
        assert.deepEqual([...entries].sort(feature._compareMemberSortEntries).map((entry) => entry.index), [2, 0, 3, 1]);
        feature._memberSortDirection = 'asc';
        assert.deepEqual([...entries].sort(feature._compareMemberSortEntries).map((entry) => entry.index), [0, 3, 2, 1]);
        feature._memberSortDirection = '';
    });
});

describe('遊戲訊息', () => {
    test('init_character_data：記公會與已加入成員各一點（邀請中不記），第一次立刻寫進 GM', () => {
        const { hooks, feature } = loadFeature();
        hooks.feedMessage(createCharacterData());
        assert.equal(feature._guild.id, 55);
        assert.ok(feature._memberStateUpdatedAt > 0);
        const history = plain(feature._getGuildHistory());
        assert.equal(history.guilds['55'].points.length, 1);
        assert.equal(history.guilds['55'].points[0].xp, 100);
        assert.deepEqual(Object.keys(history.guilds['55'].members).sort(), ['7', '8']);
        assert.equal(history.guilds['55'].members['7'][0].xp, 10.5);
        const stored = JSON.parse(hooks.gmStore.get(GUILD_HISTORY_KEY));
        assert.equal(stored.version, 1);
        assert.equal(stored.guilds['55'].points[0][1], 100);
        assert.equal(feature._isGuildHistoryDirty, false);
    });

    test('閒置名單：自己沒有動作也算；隱藏、離線、邀請中不算；名字排序', () => {
        const { hooks, feature } = loadFeature();
        hooks.feedMessage(
            createCharacterData({
                guildCharacterMap: {
                    7: { status: 'joined', guildExperience: 1 },
                    8: { status: 'joined', guildExperience: 1 },
                    10: { status: 'joined', guildExperience: 1 },
                    11: { status: 'joined', guildExperience: 1 },
                    12: { status: 'joined', guildExperience: 1 },
                    9: { status: 'invited', guildExperience: 0 },
                },
                guildSharableCharacterMap: {
                    7: { name: 'Me', actionType: '/action_types/milking', isOnline: true },
                    8: { name: 'Zed', actionType: '', isOnline: true },
                    10: { name: 'Bob', actionType: '', isOnline: true },
                    11: { name: 'Hidden', actionType: '', isOnline: true, hideOnlineStatus: true },
                    12: { name: 'Busy', actionType: '/action_types/combat', isOnline: true },
                    9: { name: 'Invitee', actionType: '', isOnline: true },
                },
            })
        );
        // 自己的動作佇列是空的（characterActions: []），所以就算公開資料寫著在擠奶也算閒置
        assert.deepEqual([...feature._getIdleMemberNames()], ['Bob', 'Me', 'Zed']);
        hooks.feedMessage({ type: 'actions_updated', endCharacterActions: [{ id: 1, actionHrid: '/actions/milking/cow', isDone: false, ordinal: 1 }] });
        assert.deepEqual([...feature._getIdleMemberNames()], ['Bob', 'Zed']);
    });

    test('guild_updated：同一個 10 分鐘內取代最後一點；null 代表離開公會，成員資料清掉', () => {
        const { hooks, feature } = loadFeature();
        hooks.feedMessage(createCharacterData());
        hooks.feedMessage({ type: 'guild_updated', guild: { id: 55, name: 'My Guild', level: 3, experience: 130 } });
        const points = plain(feature._getGuildHistory().guilds['55'].points);
        assert.equal(points[points.length - 1].xp, 130);
        hooks.feedMessage({ type: 'guild_updated', guild: null });
        assert.equal(feature._guild, null);
        assert.deepEqual(plain(feature._guildCharacterMap), {});
        assert.equal(feature._memberStateUpdatedAt, 0);
    });

    test('guild_characters_updated：整份換掉、只記已加入、成員紀錄帶別的 guildID 就不記', () => {
        const { hooks, feature } = loadFeature();
        hooks.feedMessage(createCharacterData({ guildCharacterMap: {}, guildSharableCharacterMap: {} }));
        hooks.feedMessage({
            type: 'guild_characters_updated',
            guildCharacterMap: {
                20: { characterID: 20, guildID: 55, status: 'joined', guildExperience: 3 },
                21: { characterID: 21, guildID: 55, status: 'invited', guildExperience: 0 },
                22: { characterID: 22, guildID: 99, status: 'joined', guildExperience: 4 },
            },
            guildSharableCharacterMap: { 20: { name: 'New' } },
        });
        assert.deepEqual(Object.keys(feature._getGuildHistory().guilds['55'].members), ['20']);
        assert.equal(feature._guildSharableCharacterMap['20'].name, 'New');
    });

    test('leaderboard_updated（公會 / 等級）：記其他公會的 value2，自己公會不記但記下名稱對照', () => {
        const { hooks, feature } = loadFeature();
        hooks.feedMessage(createCharacterData());
        hooks.feedMessage(createLeaderboardMessage());
        const history = plain(feature._getLeaderboardHistory());
        assert.deepEqual(Object.keys(history.guilds).sort(), ['101', '102']);
        assert.equal(history.guilds['101'].name, 'Alpha');
        assert.equal(history.guilds['101'].points[0].xp, 900000);
        assert.equal(feature._getLeaderboardKeyForName('Alpha'), '101');
        assert.equal(feature._getLeaderboardKeyForName('My Guild'), '55');
        const ownSeries = feature._getLeaderboardDisplaySeries('My Guild');
        assert.equal(ownSeries.isOwnGuild, true);
        assert.equal(ownSeries.points.length, 1);
        assert.equal(feature._getLeaderboardDisplaySeries('Alpha').isOwnGuild, false);
        assert.ok(hooks.gmStore.has(LEADERBOARD_HISTORY_KEY));
        assert.deepEqual(plain(feature._lastLeaderboardBoard), { type: 'guild', category: 'guild' });
    });

    test('其他榜 / 欄位格式不對 / 內外 type 不一致：不記，但記下最後顯示的榜', () => {
        const { hooks, feature } = loadFeature();
        hooks.feedMessage(createCharacterData());
        hooks.feedMessage(createLeaderboardMessage({ leaderboardType: 'standard', leaderboardCategory: 'total_level', leaderboard: { type: 'standard', category: 'total_level', rows: [{ name: 'Someone', value1: 2000, value2: 5 }] } }));
        assert.deepEqual(plain(feature._lastLeaderboardBoard), { type: 'standard', category: 'total_level' });
        hooks.feedMessage(createLeaderboardMessage({ leaderboardCategory: 'guild_points', leaderboard: { type: 'guild', category: 'guild_points', rows: [{ name: 'Alpha', id: 101, value1: 5, value2: 9 }] } }));
        const wrongColumns = createLeaderboardMessage();
        wrongColumns.leaderboard.columnNames = ['leaderboardPanel.level', 'leaderboardPanel.points'];
        hooks.feedMessage(wrongColumns);
        const mismatched = createLeaderboardMessage();
        mismatched.leaderboard.category = 'guild_points';
        hooks.feedMessage(mismatched);
        assert.deepEqual(Object.keys(feature._getLeaderboardHistory().guilds), []);
        assert.equal(hooks.gmStore.has(LEADERBOARD_HISTORY_KEY), false);
    });

    test('沒有 id 的列用 name: 開頭的鍵；公會等級榜判斷', () => {
        const { feature } = loadFeature();
        assert.equal(feature._getLeaderboardSeriesKey({ name: 'Gamma', id: 7 }), '7');
        assert.equal(feature._getLeaderboardSeriesKey({ name: 'Gamma' }), 'name:Gamma');
        assert.equal(feature._getLeaderboardSeriesKey({}), '');
        assert.equal(feature._isGuildLevelBoard('guild', 'guild'), true);
        assert.equal(feature._isGuildLevelBoard('guild', 'guild_points'), false);
        assert.equal(feature._isGuildLevelBoard('standard', 'total_level'), false);
    });

    test('關掉「在本機記錄公會經驗」：什麼都不記、不寫 GM', () => {
        const settings = { guildXpTracking: { id: 'guildXpTracking', isTrue: false } };
        const { hooks, feature } = loadFeature({ localStorageValues: { script_settingsMap: JSON.stringify(settings) } });
        assert.equal(hooks.settingsMap.guildXpTracking.isTrue, false);
        hooks.feedMessage(createCharacterData());
        hooks.feedMessage(createLeaderboardMessage());
        assert.equal(feature._guild, null);
        assert.equal(feature._guildHistory, null);
        assert.equal(hooks.gmStore.has(GUILD_HISTORY_KEY), false);
        assert.equal(hooks.gmStore.has(LEADERBOARD_HISTORY_KEY), false);
        // 子功能的開關也一併視為關閉
        assert.equal(feature._isOverviewEnabled(), false);
        assert.equal(feature._isMemberRateEnabled(), false);
    });

    test('畫面函式在沒有 DOM 的環境不出錯', () => {
        const { hooks, feature } = loadFeature();
        hooks.feedMessage(createCharacterData());
        assert.doesNotThrow(() => feature.handleDomChange());
    });
});

describe('GM 儲存', () => {
    test('60 秒節流：第二則訊息先不寫，強制寫入（關分頁 / 切背景）才寫', () => {
        const { hooks, feature } = loadFeature();
        hooks.feedMessage(createCharacterData());
        const firstWrite = hooks.gmStore.get(GUILD_HISTORY_KEY);
        hooks.feedMessage({ type: 'guild_updated', guild: { id: 55, name: 'My Guild', level: 3, experience: 150 } });
        assert.equal(hooks.gmStore.get(GUILD_HISTORY_KEY), firstWrite);
        assert.equal(feature._isGuildHistoryDirty, true);
        feature._saveHistoriesIfDue(Date.now(), true);
        const stored = JSON.parse(hooks.gmStore.get(GUILD_HISTORY_KEY));
        assert.equal(stored.guilds['55'].points[stored.guilds['55'].points.length - 1][1], 150);
        assert.equal(feature._isGuildHistoryDirty, false);
    });

    test('寫入前讀回合併：另一個分頁寫的公會與較舊的點都留著', () => {
        const now = Date.now();
        const otherTabHistory = {
            version: 1,
            guilds: {
                55: { points: [[now - 3 * HOUR, 40]], members: { 8: [[now - 3 * HOUR, 15]] } },
                77: { points: [[now - HOUR, 999]], members: {} },
            },
        };
        const { hooks, feature } = loadFeature({ gmValues: { [GUILD_HISTORY_KEY]: JSON.stringify(otherTabHistory) } });
        // 模擬「這個分頁已經讀過舊值」之後，另一個分頁才寫入新的資料
        feature._guildHistory = feature._createEmptyHistory();
        hooks.feedMessage(createCharacterData());
        const stored = JSON.parse(hooks.gmStore.get(GUILD_HISTORY_KEY));
        assert.deepEqual(Object.keys(stored.guilds).sort(), ['55', '77']);
        assert.equal(stored.guilds['55'].points.length, 2);
        assert.equal(stored.guilds['55'].points[0][1], 40);
        assert.equal(stored.guilds['55'].members['8'].length, 2);
        // 合併結果成為新的記憶體副本
        assert.equal(feature._getGuildHistory().guilds['77'].points[0].xp, 999);
    });

    test('壞掉的儲存值、版本不符：當成空的，不丟例外', () => {
        const { feature } = loadFeature();
        assert.deepEqual(plain(feature._parseGuildHistory('{bad json')), { version: 1, guilds: {} });
        assert.deepEqual(plain(feature._parseGuildHistory(JSON.stringify({ version: 2, guilds: {} }))), { version: 1, guilds: {} });
        assert.deepEqual(plain(feature._parseGuildHistory(undefined)), { version: 1, guilds: {} });
        assert.deepEqual(plain(feature._parseLeaderboardHistory('[]')), { version: 1, guilds: {} });
        // JSON 文字裡的 "__proto__" 會變成一般屬性，不能讓它被當成鍵寫回物件（會改到原型）
        const withBadPoints = feature._parseGuildHistory(
            '{"version":1,"guilds":{"__proto__":{"points":[[1,1]]},"55":{"points":[[1,2],["x",3],null,[2,"y"]],"members":{"__proto__":[[1,1]],"8":"nope"}}}}'
        );
        assert.deepEqual(Object.keys(withBadPoints.guilds), ['55']);
        assert.deepEqual(plain(withBadPoints.guilds['55']), { points: [{ at: 1, xp: 2 }], members: { 8: [] } });
    });

    test('上限：最多 5 個公會、每公會 100 位成員、排行榜 200 個公會（都留最新的）', () => {
        const { feature } = loadFeature();
        const now = BASE_TIME + DAY;
        const history = feature._createEmptyHistory();
        for (let index = 0; index < 7; index += 1) {
            history.guilds[String(index)] = { points: [{ at: now - index * MINUTE, xp: index }], members: Object.create(null) };
        }
        for (let index = 0; index < 105; index += 1) {
            history.guilds['0'].members[String(1000 + index)] = [{ at: now - index * MINUTE, xp: 1 }];
        }
        const pruned = plain(feature._pruneGuildHistory(history, now));
        assert.deepEqual(Object.keys(pruned.guilds).sort(), ['0', '1', '2', '3', '4']);
        assert.equal(Object.keys(pruned.guilds['0'].members).length, 100);
        assert.ok(!('1104' in pruned.guilds['0'].members));
        const leaderboard = feature._createEmptyHistory();
        for (let index = 0; index < 205; index += 1) {
            leaderboard.guilds[String(index)] = { name: `G${index}`, points: [{ at: now - index * MINUTE, xp: 1 }] };
        }
        const prunedLeaderboard = plain(feature._pruneLeaderboardHistory(leaderboard, now));
        assert.equal(Object.keys(prunedLeaderboard.guilds).length, 200);
        assert.ok(!('204' in prunedLeaderboard.guilds));
    });

    test('重新整理後：排行榜名稱對照從儲存的名稱重建（新的優先）', () => {
        const now = Date.now();
        const stored = {
            version: 1,
            guilds: {
                101: { name: 'Alpha', points: [[now - 2 * HOUR, 1000], [now - HOUR, 1100]] },
                '201': { name: 'Alpha', points: [[now - 25 * HOUR, 1]] },
            },
        };
        const { feature } = loadFeature({ gmValues: { [LEADERBOARD_HISTORY_KEY]: JSON.stringify(stored) } });
        assert.equal(feature._getLeaderboardKeyForName('Alpha'), '101');
        assert.equal(feature._getLeaderboardKeyForName('Unknown'), 'name:Unknown');
        const rates = feature._calculateRates(feature._getLeaderboardDisplaySeries('Alpha').points, now);
        assert.ok(Math.abs(rates.recent.rate - 100) < 1e-9);
    });

    test('序列化：點存成 [at, xp]，讀回來一樣', () => {
        const { feature } = loadFeature();
        const history = feature._createEmptyHistory();
        history.guilds['55'] = { points: [{ at: 1, xp: 2 }], members: Object.create(null) };
        history.guilds['55'].members['7'] = [{ at: 3, xp: 4.5 }];
        const text = feature._serializeGuildHistory(history);
        assert.deepEqual(JSON.parse(text), { version: 1, guilds: { 55: { points: [[1, 2]], members: { 7: [[3, 4.5]] } } } });
        assert.deepEqual(plain(feature._parseGuildHistory(text)), plain(history));
    });
});

describe('概覽卡內容', () => {
    test('名字跳脫、閒置名單、數值格式', () => {
        const { feature } = loadFeature();
        const now = BASE_TIME + 30 * HOUR;
        const points = buildLinearSeries(now, 30 * HOUR, 30 * MINUTE, 1000, 50000);
        const rates = feature._calculateRates(points, now);
        const html = feature._buildOverviewHtml({
            rates,
            eta: feature._estimateLevelEta(2, 50, rates, [0, 0, 33, 1000076]),
            trendPoints: feature._buildTrendPoints(points, now),
            isIdleShown: true,
            idleNames: ['<img src=x onerror=alert(1)>', 'Bob'],
            memberStateUpdatedAt: now,
            now,
        });
        assert.doesNotMatch(html, /<img/);
        assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
        assert.match(html, /Idle now \(2\)/);
        assert.match(html, />1k\/h</);
        assert.match(html, /41\.7 days/);
        assert.match(html, /<polyline/);
    });
});
