// 每日資產盈虧的走勢圖與資料管理（AssetHistoryChartFeature）：範圍與補空日、圖表設定、tooltip / 刻度格式、匯出備份、匯入驗證與合併、刪除某天、訊息與設定開關（node --test 'tests/*.test.mjs'）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadMwiToolsScript } from './MwiToolsScriptLoader.mjs';

const chineseHooks = loadMwiToolsScript(['AssetHistoryChartFeature', 'settingsMap', 'getAssetHistoryDayKey'], {
    localStorageValues: { i18nextLng: 'zh' },
});
const feature = chineseHooks.AssetHistoryChartFeature;
const englishFeature = loadMwiToolsScript(['AssetHistoryChartFeature']).AssetHistoryChartFeature;

// 沙盒裡建立的物件原型屬於另一個 realm，比對前先轉成這邊的一般物件
const toPlain = value => JSON.parse(JSON.stringify(value));
const daysOf = totalsByDay => Object.fromEntries(Object.entries(totalsByDay).map(([dayKey, total]) => [dayKey, { total }]));
const recordAt = (total, recordedAt) => ({ recordedAt, total });
const latestAllowedDayKey = '2026-10-02';

describe('設定', () => {
    test('assetHistoryChart 預設開啟，說明是繁體並標示依賴每日資產盈虧', () => {
        const setting = chineseHooks.settingsMap.assetHistoryChart;
        assert.equal(setting.id, 'assetHistoryChart');
        assert.equal(setting.isTrue, true);
        assert.equal(setting.desc, '每日資產盈虧：顯示資產走勢圖與資料管理（匯出 / 匯入 / 刪除某天） [依賴每日資產盈虧]');
        assert.equal(feature._isEnabled(), true);
    });

    test('關掉 assetHistoryChart 或 assetHistory 時功能不啟用，收到訊息也不改狀態', () => {
        for (const disabledId of ['assetHistoryChart', 'assetHistory']) {
            const hooks = loadMwiToolsScript(['AssetHistoryChartFeature'], {
                localStorageValues: { script_settingsMap: JSON.stringify({ [disabledId]: { id: disabledId, isTrue: false } }) },
            });
            const disabledFeature = hooks.AssetHistoryChartFeature;
            assert.equal(disabledFeature._isEnabled(), false);
            disabledFeature._isDataDirty = false;
            disabledFeature.handleMessage({ type: 'init_character_data' });
            assert.equal(disabledFeature._isDataDirty, false);
            assert.doesNotThrow(() => disabledFeature.handleDomChange());
        }
    });
});

describe('日期工具', () => {
    test('合法日期：格式與不存在的日期', () => {
        assert.equal(feature._isValidDayKey('2026-10-01'), true);
        assert.equal(feature._isValidDayKey('2024-02-29'), true);
        assert.equal(feature._isValidDayKey('2026-02-29'), false);
        assert.equal(feature._isValidDayKey('2026-02-30'), false);
        assert.equal(feature._isValidDayKey('2026-13-01'), false);
        assert.equal(feature._isValidDayKey('2026-1-01'), false);
        assert.equal(feature._isValidDayKey('2026-10-01T00:00'), false);
        assert.equal(feature._isValidDayKey(20261001), false);
        assert.equal(feature._isValidDayKey(null), false);
    });

    test('日期加減：跨月、跨年、閏年、往回', () => {
        assert.equal(feature._shiftDayKey('2026-10-01', -1), '2026-09-30');
        assert.equal(feature._shiftDayKey('2026-12-31', 1), '2027-01-01');
        assert.equal(feature._shiftDayKey('2024-03-01', -1), '2024-02-29');
        assert.equal(feature._shiftDayKey('2026-10-01', -29), '2026-09-02');
        assert.equal(feature._shiftDayKey('2026-10-01', 0), '2026-10-01');
    });

    test('範圍按鈕文字與天數互轉，不認得的值回傳 undefined', () => {
        assert.equal(feature._parseRangeText('7'), 7);
        assert.equal(feature._parseRangeText('30'), 30);
        assert.equal(feature._parseRangeText('all'), null);
        assert.equal(feature._parseRangeText('15'), undefined);
        assert.equal(feature._parseRangeText('abc'), undefined);
        assert.equal(feature._formatRangeKey(7), '7');
        assert.equal(feature._formatRangeKey(null), 'all');
    });
});

describe('圖表資料（_buildChartSeries）', () => {
    const gappedDays = daysOf({ '2026-09-24': 100, '2026-09-26': 120, '2026-09-30': 90, '2026-10-01': 150 });

    test('7 天：以最後一筆往回 7 個日曆天，沒紀錄的日子補 null，盈虧跟前一筆（可在範圍外）比', () => {
        const series = toPlain(feature._buildChartSeries(gappedDays, 7));
        assert.deepEqual(series.dayKeys, ['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01']);
        assert.deepEqual(series.totals, [null, 120, null, null, null, 90, 150]);
        assert.deepEqual(series.changes, [null, 20, null, null, null, -30, 60]);
        assert.deepEqual(series.previousTotals, [null, 100, null, null, null, 120, 90]);
        assert.deepEqual(series.gapDays, [null, 2, null, null, null, 4, 1]);
        assert.equal(series.recordCount, 3);
    });

    test('全部：從第一筆開始，第一筆沒有盈虧', () => {
        const series = toPlain(feature._buildChartSeries(gappedDays, null));
        assert.equal(series.dayKeys.length, 8);
        assert.equal(series.dayKeys[0], '2026-09-24');
        assert.equal(series.totals[0], 100);
        assert.equal(series.changes[0], null);
        assert.equal(series.gapDays[0], null);
        assert.equal(series.recordCount, 4);
    });

    test('範圍比紀錄長時從第一筆開始；範圍以最後一筆為準而不是今天', () => {
        const longRange = toPlain(feature._buildChartSeries(gappedDays, 30));
        assert.equal(longRange.dayKeys[0], '2026-09-24');
        assert.equal(longRange.dayKeys.at(-1), '2026-10-01');
        const oldDays = daysOf({ '2025-12-01': 5, '2026-01-10': 10 });
        const oldSeries = toPlain(feature._buildChartSeries(oldDays, 7));
        assert.deepEqual(oldSeries.dayKeys, ['2026-01-04', '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09', '2026-01-10']);
        assert.equal(oldSeries.changes.at(-1), 5);
        assert.equal(oldSeries.gapDays.at(-1), 40);
    });

    test('沒有紀錄回傳空資料；忽略不合法日期、非數字與空紀錄', () => {
        assert.deepEqual(toPlain(feature._buildChartSeries({}, 30)), { dayKeys: [], totals: [], changes: [], previousTotals: [], gapDays: [], recordCount: 0 });
        assert.equal(feature._buildChartSeries(null, 30).recordCount, 0);
        const messyDays = {
            '2026-09-29': { total: 'abc' },
            '2026-02-30': { total: 5 },
            'oops': { total: 5 },
            '2026-09-30': null,
            '2026-10-01': { total: 7 },
            '2026-09-28': { total: Number.NaN },
        };
        const series = toPlain(feature._buildChartSeries(messyDays, null));
        assert.deepEqual(series.dayKeys, ['2026-10-01']);
        assert.deepEqual(series.totals, [7]);
        assert.equal(series.recordCount, 1);
    });

    test('日曆跨度超過上限時只列有紀錄的日子（不補空日）', () => {
        const originalLimit = feature._maximumCalendarSpanDays;
        feature._maximumCalendarSpanDays = 5;
        try {
            const series = toPlain(feature._buildChartSeries(daysOf({ '2026-01-01': 10, '2026-01-20': 30 }), null));
            assert.deepEqual(series.dayKeys, ['2026-01-01', '2026-01-20']);
            assert.deepEqual(series.gapDays, [null, 19]);
            assert.deepEqual(series.changes, [null, 20]);
        } finally {
            feature._maximumCalendarSpanDays = originalLimit;
        }
    });

    test('簽章：角色、範圍或資料不同就不同', () => {
        const series = feature._buildChartSeries(gappedDays, 7);
        const signature = feature._buildSeriesSignature('123', 7, series);
        assert.equal(signature, feature._buildSeriesSignature('123', 7, feature._buildChartSeries(gappedDays, 7)));
        assert.notEqual(signature, feature._buildSeriesSignature('456', 7, series));
        assert.notEqual(signature, feature._buildSeriesSignature('123', null, series));
        const changedDays = { ...gappedDays, '2026-09-26': { total: 121 } };
        assert.notEqual(signature, feature._buildSeriesSignature('123', 7, feature._buildChartSeries(changedDays, 7)));
    });
});

describe('圖表設定與格式', () => {
    const series = feature._buildChartSeries(daysOf({ '2026-09-29': 1000, '2026-09-30': 1200, '2026-10-01': 1100 }), 30);

    test('responsive 關閉、標籤是 MM/DD、空日 spanGaps、回呼都是靜態方法參照', () => {
        const config = feature._buildChartConfig(series);
        assert.equal(config.type, 'line');
        assert.equal(config.options.responsive, false);
        assert.equal(config.options.animation, false);
        assert.equal(config.options.devicePixelRatio, 1);
        assert.deepEqual(toPlain(config.data.labels), ['09/29', '09/30', '10/01']);
        const dataset = config.data.datasets[0];
        assert.equal(dataset.label, '總資產');
        assert.equal(dataset.spanGaps, true);
        assert.equal(dataset.pointRadius, 2);
        assert.equal(config.options.onClick, feature._handleChartClick);
        assert.equal(config.options.plugins.tooltip.callbacks.title, feature._formatTooltipTitle);
        assert.equal(config.options.plugins.tooltip.callbacks.label, feature._formatTooltipLabel);
        assert.equal(config.options.plugins.tooltip.callbacks.afterLabel, feature._formatTooltipAfterLabel);
        assert.equal(config.options.scales.y.ticks.callback, feature._formatAxisTick);
        assert.equal(config.options.plugins.datalabels.display, false);
        assert.equal(config.options.scales.y.suggestedMin, undefined);
    });

    test('紀錄超過 60 筆時不畫圓點', () => {
        const manyDays = {};
        for (let index = 0; index < 61; index++) {
            manyDays[feature._shiftDayKey('2026-08-01', index)] = { total: 1000 + index * 50 };
        }
        const manySeries = feature._buildChartSeries(manyDays, null);
        assert.equal(manySeries.recordCount, 61);
        assert.equal(feature._buildChartConfig(manySeries).data.datasets[0].pointRadius, 0);
    });

    test('只有一筆或數值幾乎沒變時，Y 軸上下各留 5%', () => {
        assert.deepEqual(toPlain(feature._buildValueAxisBounds([null, 1000000, null])), { suggestedMin: 950000, suggestedMax: 1050000 });
        assert.deepEqual(toPlain(feature._buildValueAxisBounds([1000000000, 1000000500])), { suggestedMin: 949999975, suggestedMax: 1050000525 });
        assert.deepEqual(toPlain(feature._buildValueAxisBounds([0])), { suggestedMin: 0, suggestedMax: 1 });
        assert.deepEqual(toPlain(feature._buildValueAxisBounds([1000, 2000])), {});
        assert.deepEqual(toPlain(feature._buildValueAxisBounds([null])), {});
        const flatConfig = feature._buildChartConfig(feature._buildChartSeries(daysOf({ '2026-10-01': 2000000 }), 30));
        assert.equal(flatConfig.options.scales.y.suggestedMin, 1900000);
    });

    test('Y 軸刻度：相鄰刻度會撞成同一個字時才加小數位', () => {
        const wideTicks = [{ value: 1e9 }, { value: 2e9 }, { value: 3e9 }];
        assert.equal(feature._formatAxisTick(2e9, 1, wideTicks), '2B');
        const narrowTicks = [{ value: 1.2e9 }, { value: 1.21e9 }, { value: 1.22e9 }];
        assert.equal(feature._formatAxisTick(1.21e9, 1, narrowTicks), '1.21B');
        assert.equal(feature._formatAxisTick(1.2e9, 0, narrowTicks), '1.2B');
        const veryNarrowTicks = [{ value: 1.2e9 }, { value: 1.2005e9 }, { value: 1.201e9 }];
        assert.equal(feature._formatAxisTick(1.201e9, 2, veryNarrowTicks), '1.201B');
        assert.equal(feature._formatAxisTick(5000, 0, undefined), '5k');
        assert.equal(feature._formatAxisTick(Number.NaN, 0, []), '');
    });

    test('tooltip：完整日期、總資產、較前一筆與百分比、相隔天數', () => {
        const gappedSeries = feature._buildChartSeries(daysOf({ '2026-09-24': 100, '2026-09-26': 120, '2026-09-27': 90 }), null);
        feature._chartSeries = gappedSeries;
        try {
            assert.equal(feature._formatTooltipTitle([{ dataIndex: 2 }]), '2026-09-26');
            assert.equal(feature._formatTooltipLabel({ dataIndex: 2 }), '總資產：120');
            assert.equal(feature._formatTooltipAfterLabel({ dataIndex: 2 }), '較前一筆：+20（+20.00%），相隔 2 天');
            assert.equal(feature._formatTooltipAfterLabel({ dataIndex: 3 }), '較前一筆：-30（-25.00%）');
            assert.equal(feature._formatTooltipAfterLabel({ dataIndex: 0 }), '第一筆紀錄');
            assert.equal(feature._formatTooltipLabel({ dataIndex: 1 }), '');
            assert.equal(feature._formatTooltipAfterLabel({ dataIndex: 1 }), '');
            assert.equal(feature._formatTooltipTitle([]), '');
        } finally {
            feature._chartSeries = null;
        }
    });

    test('tooltip：今天的日期加註（今天），英文介面用英文', () => {
        const todayDayKey = chineseHooks.getAssetHistoryDayKey(new Date());
        feature._chartSeries = feature._buildChartSeries({ [todayDayKey]: { total: 5 } }, 30);
        englishFeature._chartSeries = englishFeature._buildChartSeries(daysOf({ '2026-09-24': 100, '2026-09-26': 120 }), null);
        try {
            assert.equal(feature._formatTooltipTitle([{ dataIndex: 0 }]), `${todayDayKey}（今天）`);
            assert.equal(englishFeature._formatTooltipLabel({ dataIndex: 2 }), 'Total assets: 120');
            assert.equal(englishFeature._formatTooltipAfterLabel({ dataIndex: 2 }), 'vs previous: +20 (+20.00%), 2 days apart');
            assert.equal(englishFeature._buildChartConfig(englishFeature._chartSeries).data.datasets[0].label, 'Total assets');
        } finally {
            feature._chartSeries = null;
            englishFeature._chartSeries = null;
        }
    });

    test('點圖：只有點到有紀錄的日子才選取，沒有面板時不出錯', () => {
        feature._chartSeries = feature._buildChartSeries(daysOf({ '2026-09-24': 100, '2026-09-26': 120 }), null);
        try {
            assert.doesNotThrow(() => feature._handleChartClick({}, [{ index: 2, datasetIndex: 0 }]));
            assert.doesNotThrow(() => feature._handleChartClick({}, [{ index: 1, datasetIndex: 0 }]));
            assert.doesNotThrow(() => feature._handleChartClick({}, []));
        } finally {
            feature._chartSeries = null;
        }
    });
});

describe('日期選單', () => {
    test('新到舊、標出今天、選項文字含總資產', () => {
        const options = toPlain(feature._buildDayOptions(daysOf({ '2026-09-30': 1200000, '2026-10-01': 1500000, '2026-02-30': 5 }), '2026-10-01'));
        assert.deepEqual(options, [
            { dayKey: '2026-10-01', total: 1500000, isToday: true },
            { dayKey: '2026-09-30', total: 1200000, isToday: false },
        ]);
        assert.equal(feature._formatDayOptionText(options[0]), '2026-10-01（今天） · 1.5M');
        assert.equal(feature._formatDayOptionText({ dayKey: '2026-09-30', total: 1234567, isToday: false }), '2026-09-30 · 1.23M');
        assert.equal(englishFeature._formatDayOptionText(options[0]), '2026-10-01 (today) · 1.5M');
    });

    test('刪除確認：今天的紀錄另外提醒會再寫入', () => {
        assert.equal(feature._buildDeleteConfirmText('2026-09-30', '2026-10-01'), '確定刪除 2026-09-30 的資產紀錄？');
        assert.match(feature._buildDeleteConfirmText('2026-10-01', '2026-10-01'), /^確定刪除 2026-10-01 的資產紀錄？\n這是今天的紀錄：下次重新計算資產時/);
    });
});

describe('匯出備份', () => {
    const history = {
        version: 1,
        roles: {
            123: { days: { '2026-09-30': { recordedAt: '2026-09-30T15:00:00.000Z', total: 100, equipment: 40, inventory: 60 }, '2026-10-01': { total: 120 } } },
            456: { days: { '2026-10-01': { recordedAt: '2026-10-01T01:00:00.000Z', total: 5 } } },
            789: { days: {} },
        },
    };

    test('備份格式：標記、版本、匯出時間、完整原始紀錄', () => {
        const backup = toPlain(feature._buildBackup(history, '2026-10-01T12:00:00.000Z'));
        assert.deepEqual(backup, { mwiToolsAssetHistoryBackup: true, version: 1, exportedAt: '2026-10-01T12:00:00.000Z', history });
        assert.deepEqual(toPlain(feature._buildBackup(null, 'x')).history, { version: 1, roles: {} });
        assert.equal(feature._buildDownloadFileName('2026-10-01'), 'MWITools_assetHistory_2026-10-01.json');
    });

    test('計數只算有有效紀錄的角色', () => {
        assert.deepEqual(toPlain(feature._countHistory(history)), { characterCount: 2, dayCount: 3 });
        assert.deepEqual(toPlain(feature._countHistory({})), { characterCount: 0, dayCount: 0 });
    });

    test('往返：匯出的文字匯入到空紀錄後跟原本相同', () => {
        const exportText = feature._buildExportText(history, '2026-10-01T12:00:00.000Z');
        const parseResult = feature._parseImportText(exportText, latestAllowedDayKey);
        assert.equal(parseResult.errorText, undefined);
        assert.equal(parseResult.imported.characterCount, 2);
        assert.equal(parseResult.imported.dayCount, 3);
        const mergeResult = feature._mergeHistories({ version: 1, roles: {} }, parseResult.imported.roles);
        assert.equal(mergeResult.addedCount, 3);
        assert.deepEqual(toPlain(mergeResult.history), { version: 1, roles: { 123: history.roles[123], 456: history.roles[456] } });
        const againResult = feature._mergeHistories(mergeResult.history, parseResult.imported.roles);
        assert.deepEqual([againResult.addedCount, againResult.replacedCount, againResult.skippedCount], [0, 0, 3]);
    });
});

describe('匯入驗證（_normalizeImportedHistory / _parseImportText）', () => {
    test('接受 mwiTools 原始紀錄格式，只保留已知欄位並統一 recordedAt', () => {
        const imported = feature._normalizeImportedHistory(
            {
                version: 1,
                roles: {
                    123: {
                        days: {
                            '2026-09-30': { recordedAt: '2026-09-30T15:00:00Z', total: 100, cowbells: 3, tokens: 4, extra: 'x', houses: 'bad' },
                        },
                    },
                },
            },
            latestAllowedDayKey
        );
        assert.deepEqual(toPlain(imported), {
            roles: { 123: { days: { '2026-09-30': { recordedAt: '2026-09-30T15:00:00.000Z', total: 100, cowbells: 3, tokens: 4 } } } },
            characterCount: 1,
            dayCount: 1,
            invalidCount: 0,
            ignoredCharacterCount: 0,
        });
    });

    test('接受上游 26.x 備份：production:123 → 123、分項轉成本地欄位、測試伺服器角色不匯入', () => {
        const upstreamBackup = {
            __mwitools_asset_history_backup__: true,
            schema: 2,
            exportedAt: '2026-10-01T00:00:00.000Z',
            data: {
                version: 2,
                roles: {
                    'production:123': {
                        days: {
                            '2026-09-30': {
                                recordedAt: '2026-09-30T15:59:00.000Z',
                                values: { equipment: 1, inventory: 2, marketListings: 3, houses: 4, abilities: 5, nonTradableTokens: 6, shrine: 7, liquid: 6, fixed: 22, total: 28 },
                            },
                            '2026-10-01': { recordedAt: '2026-10-01T01:00:00.000Z', values: { total: null } },
                        },
                    },
                    'test:123': { days: { '2026-09-29': { recordedAt: '2026-09-29T01:00:00.000Z', values: { total: 99 } } } },
                },
            },
        };
        const imported = toPlain(feature._normalizeImportedHistory(upstreamBackup, latestAllowedDayKey));
        assert.deepEqual(imported.roles, {
            123: {
                days: {
                    '2026-09-30': { recordedAt: '2026-09-30T15:59:00.000Z', total: 28, equipment: 1, inventory: 2, marketListings: 3, tokens: 6, houses: 4, abilities: 5 },
                },
            },
        });
        assert.equal(imported.invalidCount, 1);
        assert.equal(imported.ignoredCharacterCount, 1);
    });

    test('同一個檔案裡同一天重複時留 recordedAt 較新的', () => {
        const upstreamBackup = {
            __mwitools_asset_history_backup__: true,
            data: {
                roles: {
                    'production:123': { days: { '2026-09-30': { recordedAt: '2026-09-30T10:00:00.000Z', values: { total: 1 } } } },
                    123: { days: { '2026-09-30': { recordedAt: '2026-09-30T12:00:00.000Z', values: { total: 2 } } } },
                },
            },
        };
        assert.equal(feature._normalizeImportedHistory(upstreamBackup, latestAllowedDayKey).roles[123].days['2026-09-30'].total, 2);
    });

    test('擋掉不合格的日期、總資產與角色鍵', () => {
        const imported = feature._normalizeImportedHistory(
            {
                roles: {
                    123: {
                        days: {
                            '2026-10-02': { total: 1 },
                            '2026-10-03': { total: 1 },
                            '2019-12-31': { total: 1 },
                            '2026-02-30': { total: 1 },
                            '2026-09-01': { total: -5 },
                            '2026-09-02': { total: '100' },
                            '2026-09-03': { total: Number.POSITIVE_INFINITY },
                            '2026-09-04': null,
                            '2026-09-05': { total: 0, recordedAt: 'not a date' },
                        },
                    },
                    abc: { days: { '2026-09-30': { total: 1 } } },
                    ['__proto__']: { days: { '2026-09-30': { total: 1 } } },
                    '-1': { days: { '2026-09-30': { total: 1 } } },
                    456: { days: [] },
                },
            },
            latestAllowedDayKey
        );
        assert.deepEqual(Object.keys(imported.roles), ['123']);
        assert.deepEqual(toPlain(imported.roles[123].days), { '2026-09-05': { total: 0 }, '2026-10-02': { total: 1 } });
        assert.equal(imported.invalidCount, 7);
        assert.equal(imported.ignoredCharacterCount, 3);
        assert.equal(Object.prototype.hasOwnProperty.call(imported.roles, '__proto__'), false);
        assert.equal(feature._normalizeImportedHistory({ roles: {} }, latestAllowedDayKey).roles.days, undefined);
    });

    test(`一次最多匯入 ${50} 個角色`, () => {
        const roles = {};
        for (let index = 1; index <= 55; index++) {
            roles[String(index)] = { days: { '2026-09-30': { total: index } } };
        }
        const imported = feature._normalizeImportedHistory({ roles }, latestAllowedDayKey);
        assert.equal(imported.characterCount, feature._maximumImportCharacterCount);
        assert.equal(imported.ignoredCharacterCount, 5);
    });

    test('認不得的格式回傳 null', () => {
        for (const parsed of [null, 5, 'text', [], {}, { roles: [] }, { roles: 'x' }, { mwiToolsAssetHistoryBackup: true }, { __mwitools_asset_history_backup__: true, data: {} }]) {
            assert.equal(feature._normalizeImportedHistory(parsed, latestAllowedDayKey), null, JSON.stringify(parsed));
        }
    });

    test('文字解析的錯誤訊息：空白、太大、不是 JSON、格式不符、沒有有效紀錄', () => {
        assert.equal(feature._parseImportText('   ', latestAllowedDayKey).errorText, '請先貼上備份 JSON，或按「選擇檔案…」');
        assert.equal(feature._parseImportText(undefined, latestAllowedDayKey).errorText, '請先貼上備份 JSON，或按「選擇檔案…」');
        const originalLimit = feature._maximumImportTextLength;
        feature._maximumImportTextLength = 10;
        try {
            assert.equal(feature._parseImportText('{"roles":{}} ', latestAllowedDayKey).errorText, '內容太大（超過 10 字元），不像是資產紀錄備份');
        } finally {
            feature._maximumImportTextLength = originalLimit;
        }
        assert.match(feature._parseImportText('{not json', latestAllowedDayKey).errorText, /^不是有效的 JSON：/);
        assert.match(feature._parseImportText('{"hello":1}', latestAllowedDayKey).errorText, /^格式不符/);
        assert.match(feature._parseImportText('{"roles":{"123":{"days":{"2026-09-30":{"total":-1}}}}}', latestAllowedDayKey).errorText, /^沒有可以匯入的有效紀錄（1 筆無效/);
        assert.match(englishFeature._parseImportText('{not json', latestAllowedDayKey).errorText, /^Not valid JSON: /);
    });
});

describe('合併與刪除', () => {
    const baseHistory = {
        version: 1,
        roles: {
            123: {
                note: 'keep',
                days: {
                    '2026-09-28': { recordedAt: '2026-09-28T10:00:00.000Z', total: 10 },
                    '2026-09-29': { recordedAt: '2026-09-29T10:00:00.000Z', total: 20 },
                    '2026-09-30': { total: 30 },
                    '2026-10-01': { recordedAt: '2026-10-01T10:00:00.000Z', total: 40 },
                    '2026-09-27': { total: 'broken' },
                },
            },
            456: { days: { '2026-10-01': { total: 7 } } },
        },
    };

    test('新增、較新覆蓋、較舊略過、沒有時間不覆蓋、現有沒時間被覆蓋，不改動輸入、保留其他角色與欄位', () => {
        const before = JSON.stringify(baseHistory);
        const importedRoles = {
            123: {
                days: {
                    '2026-09-26': { total: 1 },
                    '2026-09-27': { total: 2 },
                    '2026-09-28': { recordedAt: '2026-09-28T11:00:00.000Z', total: 11 },
                    '2026-09-29': { recordedAt: '2026-09-29T09:00:00.000Z', total: 19 },
                    '2026-09-30': { recordedAt: '2026-09-30T09:00:00.000Z', total: 31 },
                    '2026-10-01': { total: 41 },
                },
            },
            789: { days: { '2026-10-01': { total: 9 } } },
        };
        const mergeResult = feature._mergeHistories(baseHistory, importedRoles);
        assert.deepEqual([mergeResult.addedCount, mergeResult.replacedCount, mergeResult.skippedCount], [3, 2, 2]);
        const mergedDays = toPlain(mergeResult.history.roles[123].days);
        assert.equal(mergedDays['2026-09-26'].total, 1);
        assert.equal(mergedDays['2026-09-27'].total, 2);
        assert.equal(mergedDays['2026-09-28'].total, 11);
        assert.equal(mergedDays['2026-09-29'].total, 20);
        assert.equal(mergedDays['2026-09-30'].total, 31);
        assert.equal(mergedDays['2026-10-01'].total, 40);
        assert.equal(mergeResult.history.roles[123].note, 'keep');
        assert.equal(mergeResult.history.roles[456].days['2026-10-01'].total, 7);
        assert.equal(mergeResult.history.roles[789].days['2026-10-01'].total, 9);
        assert.equal(mergeResult.history.version, 1);
        assert.equal(JSON.stringify(baseHistory), before);
    });

    test('合併到壞掉或空的紀錄', () => {
        const mergeResult = feature._mergeHistories(null, { 123: { days: { '2026-10-01': { total: 1 } } } });
        assert.deepEqual(toPlain(mergeResult.history), { version: 1, roles: { 123: { days: { '2026-10-01': { total: 1 } } } } });
    });

    test('匯入確認文字列出新增 / 覆蓋 / 略過與無效、略過的角色', () => {
        const text = feature._buildImportConfirmText(
            { characterCount: 2, invalidCount: 3, ignoredCharacterCount: 1 },
            { addedCount: 5, replacedCount: 1, skippedCount: 2 }
        );
        assert.equal(
            text,
            [
                '將合併 2 個角色的資產紀錄：',
                '・新增 5 天',
                '・以較新的紀錄覆蓋 1 天',
                '・略過 2 天（現有紀錄較新或相同）',
                '另有 3 筆無效紀錄不會匯入',
                '另有 1 個角色沒有匯入（角色編號不合法、測試伺服器，或超過一次 50 個的上限）',
                '確定匯入？',
            ].join('\n')
        );
    });

    test('刪除某天：只刪目前角色那天、不改動輸入；找不到時回傳原物件', () => {
        const before = JSON.stringify(baseHistory);
        const result = feature._deleteDay(baseHistory, '123', '2026-09-29');
        assert.equal(result.isDeleted, true);
        assert.equal(result.history.roles[123].days['2026-09-29'], undefined);
        assert.equal(Object.keys(result.history.roles[123].days).length, 4);
        assert.equal(result.history.roles[123].note, 'keep');
        assert.equal(result.history.roles[456].days['2026-10-01'].total, 7);
        assert.equal(JSON.stringify(baseHistory), before);
        const missing = feature._deleteDay(baseHistory, '123', '2026-01-01');
        assert.equal(missing.isDeleted, false);
        assert.equal(missing.history, baseHistory);
        assert.equal(feature._deleteDay(baseHistory, '999', '2026-10-01').isDeleted, false);
        assert.equal(feature._deleteDay({}, '123', '2026-10-01').isDeleted, false);
        assert.equal(feature._deleteDay(baseHistory, '123', 'toString').isDeleted, false);
    });

    test('recordedAt 比較規則', () => {
        assert.equal(feature._isNewerRecord({ recordedAt: '2026-10-01T02:00:00Z' }, { recordedAt: '2026-10-01T01:00:00Z' }), true);
        assert.equal(feature._isNewerRecord({ recordedAt: '2026-10-01T01:00:00Z' }, { recordedAt: '2026-10-01T01:00:00Z' }), false);
        assert.equal(feature._isNewerRecord({}, { recordedAt: '2026-10-01T01:00:00Z' }), false);
        assert.equal(feature._isNewerRecord({}, {}), false);
        assert.equal(feature._isNewerRecord({ recordedAt: '2026-10-01T01:00:00Z' }, {}), true);
        assert.equal(feature._isNewerRecord({ recordedAt: 'garbage' }, {}), false);
    });
});

describe('訊息與畫面（測試沙盒沒有真的 DOM）', () => {
    test('init_character_data 標記要重讀紀錄並重建日期選單', () => {
        const hooks = loadMwiToolsScript(['AssetHistoryChartFeature']);
        const messageFeature = hooks.AssetHistoryChartFeature;
        messageFeature._isDataDirty = false;
        messageFeature._daySelectSignature = 'old';
        hooks.feedMessage({ type: 'chat_message_received' });
        assert.equal(messageFeature._isDataDirty, false);
        hooks.feedMessage({
            type: 'init_character_data',
            character: { id: 123, name: 'Tester' },
            characterSkills: [],
            characterItems: [],
            characterHouseRoomMap: {},
            actionTypeDrinkSlotsMap: {},
            characterAbilities: [],
            myMarketListings: [],
            combatUnit: { combatAbilities: [] },
            characterActions: [],
        });
        assert.equal(messageFeature._isDataDirty, true);
        assert.equal(messageFeature._daySelectSignature, '');
    });

    test('setup / handleDomChange 在沒有 Chart、ResizeObserver、總結區塊時不出錯也不畫', () => {
        assert.doesNotThrow(() => feature.setup());
        assert.equal(feature._resizeObserver, null);
        assert.doesNotThrow(() => feature.handleDomChange());
        assert.equal(feature._chart, null);
        assert.doesNotThrow(() => feature._handleResizeFrame());
    });

    test('樣式與面板模板帶前綴、含警示色，模板不含遊戲資料', () => {
        const styles = feature._buildStyles();
        assert.match(styles, /\.mwitools-local-asset-history-chart-panel\[hidden\]/);
        assert.match(styles, /display: none !important/);
        assert.match(styles, /\[data-error="true"\] \{ color: red; \}/);
        const panelHtml = feature._buildPanelHtml();
        for (const action of ['range', 'delete-day', 'export', 'copy', 'download', 'import', 'choose-file']) {
            assert.match(panelHtml, new RegExp(`data-action="${action}"`));
        }
        assert.match(panelHtml, /資料管理（刪除 \/ 匯出 \/ 匯入）/);
        assert.match(englishFeature._buildPanelHtml(), /Data management \(delete \/ export \/ import\)/);
        assert.doesNotMatch(panelHtml, /\$\{/);
    });
});
