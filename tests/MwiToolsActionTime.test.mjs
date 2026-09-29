// mwiTools 頁首「目前動作」時間估算：次數解析測試（node --test tests/）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFunctionFromScript } from './UserScriptFunctionExtractor.mjs';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const parseHeaderActionCount = loadFunctionFromScript(join(repositoryRoot, 'mwiTools.js'), 'parseHeaderActionCount');

test('一般次數（10 萬以下遊戲顯示完整數字）', () => {
    assert.equal(parseHeaderActionCount('桃子優格 (123)'), 123);
    assert.equal(parseHeaderActionCount('Peach Yogurt (99999)'), 99999);
});

test('縮寫次數：K / M / B / T', () => {
    assert.equal(parseHeaderActionCount('桃子優格 (240K)'), 240000);
    assert.equal(parseHeaderActionCount('Milk (5M)'), 5000000);
    assert.equal(parseHeaderActionCount('Milk (3B)'), 3000000000);
    assert.equal(parseHeaderActionCount('Milk (2T)'), 2000000000000);
    assert.equal(parseHeaderActionCount('Milk (12.5K)'), 12500);
});

test('名稱本身有括號：取最後一組', () => {
    assert.equal(parseHeaderActionCount('Something (R) (240K)'), 240000);
});

test('沒有次數或遊戲顯示 Lots!：回傳 null（維持顯示 ∞）', () => {
    assert.equal(parseHeaderActionCount('擠奶 - 奶牛'), null);
    assert.equal(parseHeaderActionCount('Milk (Lots!)'), null);
    assert.equal(parseHeaderActionCount(''), null);
    assert.equal(parseHeaderActionCount(undefined), null);
});
