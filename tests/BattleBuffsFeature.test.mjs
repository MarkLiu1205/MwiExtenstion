// 戰鬥 Buff / Debuff 列：技能效果索引、施放推論、目標判定、倒數格式、單位對應、圖集網址（node --test 'tests/*.test.mjs'）
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadMwiToolsScript } from './MwiToolsScriptLoader.mjs';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const readGameData = (fileName) => JSON.parse(readFileSync(join(repositoryRoot, 'simulator/src/combatsimulator/data', fileName), 'utf8'));
const abilityDetailMap = readGameData('abilityDetailMap.json');
const buffTypeDetailMap = readGameData('buffTypeDetailMap.json');
// 關掉 mwiTools 自己的傷害統計，避免它在沙盒裡畫圖表時噴錯洗版（跟本功能無關）
const quietSettings = { showDamage: { id: 'showDamage', isTrue: false } };
const clientDataMessage = { type: 'init_client_data', itemDetailMap: { '/items/berserk': { hrid: '/items/berserk', name: 'Berserk' } }, abilityDetailMap, buffTypeDetailMap };
const characterDataMessage = {
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
};
const combatStartTime = '2026-10-01T08:00:00.000Z';
const now = 1_000_000;

// 沙盒裡的物件跟測試這邊不同 realm，比對前轉成一般 JSON
function toPlain(value) {
    return JSON.parse(JSON.stringify(value));
}

// mwiTools 收到 init_* 會 console.log 整包資料，餵訊息時先靜音
function feedQuietly(hooks, message) {
    const originalLog = console.log;
    console.log = () => {};
    try {
        hooks.feedMessage(message);
    } finally {
        console.log = originalLog;
    }
}

function loadFeature(localStorageValues) {
    const hooks = loadMwiToolsScript(['BattleBuffsFeature', 'settingsMap'], { localStorageValues });
    feedQuietly(hooks, clientDataMessage);
    return hooks;
}

function createPlayer(characterId, overrides = {}) {
    return {
        isPlayer: true,
        name: `Player${characterId}`,
        character: { id: characterId },
        currentHitpoints: 1000,
        maxHitpoints: 1000,
        currentManapoints: 500,
        maxManapoints: 500,
        preparingAbilityHrid: '',
        isPreparingAutoAttack: true,
        attackAttemptCounter: 1,
        damageSplatCounter: 0,
        criticalDamageSplatCounter: 0,
        isStunned: false,
        isSilenced: false,
        isBlinded: false,
        leftCombat: false,
        ...overrides,
    };
}

function createMonster(hrid, overrides = {}) {
    return { ...createPlayer(0, overrides), isPlayer: false, name: hrid, hrid, character: undefined, ...overrides };
}

function createNewBattle(battleId, players, monsters, startTime = combatStartTime) {
    return { type: 'new_battle', battleId, wave: 0, combatStartTime: startTime, players, monsters };
}

// battle_updated 的單位（短欄位名）；預設在準備普攻
function createPatch(overrides = {}) {
    return { cHP: 1000, mHP: 1000, cMP: 500, mMP: 500, atkCounter: 2, dmgCounter: 0, critCounter: 0, isAutoAtk: true, ...overrides };
}

function createBattleUpdated(battleId, pMap = {}, mMap = {}) {
    return { type: 'battle_updated', battleId, pMap, mMap };
}

function getEffectKeys(feature, unitKey) {
    return [...(feature._unitEffects.get(unitKey)?.keys() ?? [])];
}

const zhHooks = loadFeature({ i18nextLng: 'zh-TW', script_settingsMap: JSON.stringify(quietSettings) });
const enHooks = loadFeature({ script_settingsMap: JSON.stringify(quietSettings) });
const zhFeature = zhHooks.BattleBuffsFeature;
const enFeature = enHooks.BattleBuffsFeature;

function startBattle(players, monsters, battleId = 1, startTime = combatStartTime) {
    zhFeature._handleNewBattle(createNewBattle(battleId, players, monsters, startTime));
}

// 假的戰鬥單位根元素：React fiber 往上一層是 CombatUnit 元件（props 有 combatUnit、index、battleId、t）
function createUnitElement(props) {
    return { '__reactFiber$test': { memoizedProps: { className: 'CombatUnit_combatUnit__1m3XT' }, return: { memoizedProps: props, return: null } } };
}

// 假的 document.querySelector：回傳設定好的圖集 <use>，並記錄查了幾次
const fakeSpriteLookup = { lookupCount: 0, abilitiesHref: '', itemsHref: '' };

function fakeSpriteQuerySelector(selector) {
    fakeSpriteLookup.lookupCount++;
    const href = selector.includes('abilities_sprite') ? fakeSpriteLookup.abilitiesHref : fakeSpriteLookup.itemsHref;
    return href ? { hrefValue: href, getAttribute() { return this.hrefValue; } } : null;
}

function resetFeature(feature) {
    feature._resetBattleState();
    feature._characterId = null;
    feature._gameTranslate = null;
    feature._spriteBaseUrls = { abilities: '', items: '' };
    feature._lastSpriteScanTime = -Infinity;
}

describe('技能效果索引（真實 abilityDetailMap）', () => {
    const abilityIndex = zhFeature._getAbilityIndex();

    test('有持續效果的技能共 28 個；純傷害 / 治療技能不在索引', () => {
        assert.equal(abilityIndex.size, 28);
        assert.equal(abilityIndex.has('/abilities/aqua_arrow'), false);
        assert.equal(abilityIndex.has('/abilities/heal'), false);
        assert.equal(abilityIndex.has('/abilities/fireball'), false);
    });

    test('自身增益、全隊增益、單體 / 全體減益的目標與秒數', () => {
        assert.deepEqual(toPlain(abilityIndex.get('/abilities/berserk')), {
            buff: { durationSeconds: 20, targetType: 'self', typeHrids: ['/buff_types/physical_amplify'] },
            debuff: null,
        });
        assert.deepEqual(toPlain(abilityIndex.get('/abilities/mana_spring').buff), { durationSeconds: 10, targetType: 'allAllies', typeHrids: ['/buff_types/mp_regen'] });
        assert.deepEqual(toPlain(abilityIndex.get('/abilities/speed_aura').buff), {
            durationSeconds: 120,
            targetType: 'allAllies',
            typeHrids: ['/buff_types/attack_speed', '/buff_types/cast_speed'],
        });
        assert.deepEqual(toPlain(abilityIndex.get('/abilities/maim')), {
            buff: null,
            debuff: { durationSeconds: 12, targetType: 'enemy', typeHrids: ['/buff_types/damage_taken'] },
        });
        assert.deepEqual(toPlain(abilityIndex.get('/abilities/frost_surge').debuff), { durationSeconds: 9, targetType: 'allEnemies', typeHrids: ['/buff_types/evasion'] });
        assert.equal(abilityIndex.get('/abilities/pestilent_shot').debuff.typeHrids.length, 4);
        assert.equal(abilityIndex.get('/abilities/provoke').buff.durationSeconds, 65);
    });

    test('來源物件沒換就沿用同一個索引', () => {
        assert.equal(zhFeature._getAbilityIndex(), abilityIndex);
    });

    test('合成資料：effectType 寫明 debuff、沒寫目標時沿用同技能的敵方目標；多個效果取最長秒數與較廣目標', () => {
        const syntheticIndex = zhFeature._buildAbilityIndex({
            '/abilities/test_curse': {
                abilityEffects: [
                    { targetType: 'allEnemies', effectType: '/ability_effect_types/damage', buffs: null },
                    { targetType: '', effectType: '/ability_effect_types/debuff', buffs: [{ typeHrid: '/buff_types/armor', duration: 5e9 }] },
                ],
            },
            '/abilities/test_aura': {
                abilityEffects: [
                    { targetType: 'self', effectType: '/ability_effect_types/buff', buffs: [{ typeHrid: '/buff_types/armor', duration: 30e9 }] },
                    { targetType: 'allAllies', effectType: '/ability_effect_types/buff', buffs: [{ typeHrid: '/buff_types/evasion', duration: 10e9 }] },
                ],
            },
            '/abilities/test_zero': { abilityEffects: [{ targetType: 'self', effectType: '/ability_effect_types/buff', buffs: [{ typeHrid: '/buff_types/armor', duration: 0 }] }] },
        });
        assert.deepEqual(toPlain(syntheticIndex.get('/abilities/test_curse').debuff), { durationSeconds: 5, targetType: 'allEnemies', typeHrids: ['/buff_types/armor'] });
        assert.deepEqual(toPlain(syntheticIndex.get('/abilities/test_aura').buff), {
            durationSeconds: 30,
            targetType: 'allAllies',
            typeHrids: ['/buff_types/armor', '/buff_types/evasion'],
        });
        assert.equal(syntheticIndex.has('/abilities/test_zero'), false);
        assert.equal(zhFeature._buildAbilityIndex(null).size, 0);
    });
});

describe('單位快照', () => {
    test('動作鍵：技能 hrid、普攻 auto、沒在準備是空字串', () => {
        assert.equal(zhFeature._getActionKey('/abilities/berserk', false), '/abilities/berserk');
        assert.equal(zhFeature._getActionKey('', true), 'auto');
        assert.equal(zhFeature._getActionKey(undefined, undefined), '');
    });

    test('new_battle 完整單位 → 快照', () => {
        const snapshot = zhFeature._readFullUnitSnapshot(createPlayer(123, { preparingAbilityHrid: '/abilities/berserk', isPreparingAutoAttack: false, isStunned: true }));
        assert.deepEqual(toPlain(snapshot), {
            actionKey: '/abilities/berserk',
            hitpoints: 1000,
            manapoints: 500,
            damageCounter: 0,
            isStunned: true,
            isSilenced: false,
            hasLeftCombat: false,
            isCastInterrupted: true,
        });
    });

    test('pMap 合併：照遊戲語意，沒帶技能就是沒在準備；數值沒帶沿用；leftCombat 沒帶沿用', () => {
        const previous = { actionKey: '/abilities/berserk', hitpoints: 800, manapoints: 400, damageCounter: 3, isStunned: true, isSilenced: false, hasLeftCombat: true, isCastInterrupted: true };
        const merged = zhFeature._mergeUnitPatch(previous, { cMP: 300 });
        assert.deepEqual(toPlain(merged), {
            actionKey: '',
            hitpoints: 800,
            manapoints: 300,
            damageCounter: 3,
            isStunned: false,
            isSilenced: false,
            hasLeftCombat: true,
            isCastInterrupted: false,
        });
        assert.equal(zhFeature._mergeUnitPatch(previous, { leftCombat: false }).hasLeftCombat, false);
        assert.equal(zhFeature._mergeUnitPatch(null, { abilityHrid: '/abilities/maim', cHP: 5 }).actionKey, '/abilities/maim');
        assert.equal(zhFeature._mergeUnitPatch(null, {}).hitpoints, null);
    });

    test('存活判斷：HP ≤ 0 或離開戰鬥就不算活著；沒有快照當作活著', () => {
        assert.equal(zhFeature._isUnitAlive({ hitpoints: 1, hasLeftCombat: false }), true);
        assert.equal(zhFeature._isUnitAlive({ hitpoints: 0, hasLeftCombat: false }), false);
        assert.equal(zhFeature._isUnitAlive({ hitpoints: 10, hasLeftCombat: true }), false);
        assert.equal(zhFeature._isUnitAlive({ hitpoints: null, hasLeftCombat: false }), true);
        assert.equal(zhFeature._isUnitAlive(undefined), true);
    });
});

describe('施放完成判斷', () => {
    const preparing = { actionKey: '/abilities/berserk', hitpoints: 1000, manapoints: 500, damageCounter: 0, isStunned: false, isSilenced: false, hasLeftCombat: false };

    test('技能 → 普攻 / 其他技能：施放完成', () => {
        assert.equal(zhFeature._isCastCompleted(preparing, { ...preparing, actionKey: 'auto' }), true);
        assert.equal(zhFeature._isCastCompleted(preparing, { ...preparing, actionKey: '/abilities/frenzy' }), true);
    });

    test('沒換動作、普攻換技能、沒有上一筆：不算', () => {
        assert.equal(zhFeature._isCastCompleted(preparing, { ...preparing }), false);
        assert.equal(zhFeature._isCastCompleted({ ...preparing, actionKey: 'auto' }, preparing), false);
        assert.equal(zhFeature._isCastCompleted(null, preparing), false);
    });

    test('被暈 / 沉默打斷：沒扣魔不算，有扣魔（施放完成同時被暈）才算', () => {
        assert.equal(zhFeature._isCastCompleted(preparing, { ...preparing, actionKey: '', isStunned: true }), false);
        assert.equal(zhFeature._isCastCompleted(preparing, { ...preparing, actionKey: 'auto', isSilenced: true }), false);
        assert.equal(zhFeature._isCastCompleted(preparing, { ...preparing, actionKey: '', isStunned: true, manapoints: 435 }), true);
    });

    test('死亡、或之後什麼都沒在準備（例如這波怪被打完）且沒扣魔：不算', () => {
        assert.equal(zhFeature._isCastCompleted(preparing, { ...preparing, actionKey: '', hitpoints: 0 }), false);
        assert.equal(zhFeature._isCastCompleted(preparing, { ...preparing, actionKey: '' }), false);
        assert.equal(zhFeature._isCastCompleted(preparing, { ...preparing, actionKey: '', manapoints: 435 }), true);
    });

    test('被暈時遊戲若還留著準備中的技能：打斷標記一直保留到動作換掉，換掉時沒扣魔不算', () => {
        const stunnedWhilePreparing = zhFeature._mergeUnitPatch(preparing, { cMP: 500, abilityHrid: '/abilities/berserk', isStunned: true });
        assert.equal(stunnedWhilePreparing.isCastInterrupted, true);
        assert.equal(zhFeature._isCastCompleted(preparing, stunnedWhilePreparing), false);
        const stunEnded = zhFeature._mergeUnitPatch(stunnedWhilePreparing, { cMP: 500, abilityHrid: '/abilities/berserk' });
        assert.equal(stunEnded.isCastInterrupted, true, '動作沒換掉前一直保留');
        assert.equal(zhFeature._isCastCompleted(stunEnded, zhFeature._mergeUnitPatch(stunEnded, { cMP: 500, isAutoAtk: true })), false);
        assert.equal(zhFeature._isCastCompleted(stunEnded, zhFeature._mergeUnitPatch(stunEnded, { cMP: 435, isAutoAtk: true })), true);
        assert.equal(zhFeature._mergeUnitPatch(stunEnded, { cMP: 500, abilityHrid: '/abilities/frenzy' }).isCastInterrupted, false, '換成別的動作就重新計算');
    });
});

describe('減益目標判定', () => {
    test('有人掉血：全體技能取全部，單體取第一個', () => {
        assert.deepEqual(toPlain(zhFeature._resolveDebuffTargets('allEnemies', [0, 2], [0, 2], [0, 1, 2])), [0, 2]);
        assert.deepEqual(toPlain(zhFeature._resolveDebuffTargets('enemy', [2, 0], [2, 0], [0, 1, 2])), [2]);
    });

    test('有被攻擊但沒掉血（沒打中）：不上減益', () => {
        assert.deepEqual(toPlain(zhFeature._resolveDebuffTargets('allEnemies', [], [1], [0, 1])), []);
    });

    test('沒有攻擊跡象：全體技能給所有活著的，單體技能只在剩一個活的時候給它', () => {
        assert.deepEqual(toPlain(zhFeature._resolveDebuffTargets('allEnemies', [], [], [0, 1])), [0, 1]);
        assert.deepEqual(toPlain(zhFeature._resolveDebuffTargets('enemy', [], [], [1])), [1]);
        assert.deepEqual(toPlain(zhFeature._resolveDebuffTargets('enemy', [], [], [0, 1])), []);
    });
});

describe('戰鬥訊息推論效果', () => {
    beforeEach(() => resetFeature(zhFeature));

    test('自身增益：狂暴施放完成 → 施法者有效果，到期時間 = 現在 + 20 秒', () => {
        startBattle([createPlayer(123, { preparingAbilityHrid: '/abilities/berserk', isPreparingAutoAttack: false }), createPlayer(456)], [createMonster('/monsters/fly')]);
        assert.equal(zhFeature._handleBattleUpdated(createBattleUpdated(1, { 0: createPatch({ cMP: 435 }) }), now), true);
        assert.deepEqual(getEffectKeys(zhFeature, 'player:123'), ['buff:/abilities/berserk']);
        assert.equal(zhFeature._unitEffects.get('player:123').get('buff:/abilities/berserk').expiresAt, now + 20000);
        assert.equal(zhFeature._unitEffects.has('player:456'), false);
    });

    test('全隊增益只給活著的隊友', () => {
        startBattle(
            [createPlayer(123, { preparingAbilityHrid: '/abilities/speed_aura', isPreparingAutoAttack: false }), createPlayer(456), createPlayer(789, { currentHitpoints: 0 })],
            [createMonster('/monsters/fly')]
        );
        zhFeature._handleBattleUpdated(createBattleUpdated(1, { 0: createPatch({ cMP: 400 }) }), now);
        assert.deepEqual(getEffectKeys(zhFeature, 'player:123'), ['buff:/abilities/speed_aura']);
        assert.deepEqual(getEffectKeys(zhFeature, 'player:456'), ['buff:/abilities/speed_aura']);
        assert.equal(zhFeature._unitEffects.has('player:789'), false);
        assert.equal(zhFeature._unitEffects.get('player:456').get('buff:/abilities/speed_aura').expiresAt, now + 120000);
    });

    test('單體減益加在掉血的那隻怪', () => {
        startBattle([createPlayer(123, { preparingAbilityHrid: '/abilities/maim', isPreparingAutoAttack: false })], [createMonster('/monsters/fly'), createMonster('/monsters/rat')]);
        zhFeature._handleBattleUpdated(createBattleUpdated(1, { 0: createPatch({ cMP: 450 }) }, { 1: createPatch({ cHP: 700, dmgCounter: 1 }) }), now);
        assert.deepEqual(getEffectKeys(zhFeature, 'monster:1'), ['debuff:/abilities/maim']);
        assert.equal(zhFeature._unitEffects.has('monster:0'), false);
    });

    test('全體減益加在每隻掉血的怪', () => {
        startBattle([createPlayer(123, { preparingAbilityHrid: '/abilities/frost_surge', isPreparingAutoAttack: false })], [createMonster('/monsters/fly'), createMonster('/monsters/rat')]);
        zhFeature._handleBattleUpdated(
            createBattleUpdated(1, { 0: createPatch({ cMP: 425 }) }, { 0: createPatch({ cHP: 800, dmgCounter: 1 }), 1: createPatch({ cHP: 900, dmgCounter: 1 }) }),
            now
        );
        assert.deepEqual(getEffectKeys(zhFeature, 'monster:0'), ['debuff:/abilities/frost_surge']);
        assert.deepEqual(getEffectKeys(zhFeature, 'monster:1'), ['debuff:/abilities/frost_surge']);
        assert.equal(zhFeature._unitEffects.get('monster:0').get('debuff:/abilities/frost_surge').expiresAt, now + 9000);
    });

    test('沒打中（傷害計數器變了但血沒掉）不上減益', () => {
        startBattle([createPlayer(123, { preparingAbilityHrid: '/abilities/maim', isPreparingAutoAttack: false })], [createMonster('/monsters/fly'), createMonster('/monsters/rat')]);
        zhFeature._handleBattleUpdated(createBattleUpdated(1, { 0: createPatch({ cMP: 450 }) }, { 0: createPatch({ dmgCounter: 1 }) }), now);
        assert.equal(zhFeature._unitEffects.size, 0);
    });

    test('沒有攻擊跡象、對面只剩一隻活的：給那一隻', () => {
        startBattle(
            [createPlayer(123, { preparingAbilityHrid: '/abilities/maim', isPreparingAutoAttack: false })],
            [createMonster('/monsters/fly', { currentHitpoints: 0 }), createMonster('/monsters/rat')]
        );
        zhFeature._handleBattleUpdated(createBattleUpdated(1, { 0: createPatch({ cMP: 450 }) }), now);
        assert.deepEqual(getEffectKeys(zhFeature, 'monster:1'), ['debuff:/abilities/maim']);
    });

    test('怪物對玩家放冰槍術：掉血的玩家有減益', () => {
        startBattle([createPlayer(123), createPlayer(456)], [createMonster('/monsters/frost_imp', { preparingAbilityHrid: '/abilities/ice_spear', isPreparingAutoAttack: false })]);
        zhFeature._handleBattleUpdated(createBattleUpdated(1, { 1: createPatch({ cHP: 850, dmgCounter: 1 }) }, { 0: createPatch({ cMP: 455 }) }), now);
        assert.deepEqual(getEffectKeys(zhFeature, 'player:456'), ['debuff:/abilities/ice_spear']);
        assert.equal(zhFeature._unitEffects.has('player:123'), false);
    });

    test('被暈打斷（沒扣魔）不算施放；純傷害技能不產生效果', () => {
        startBattle([createPlayer(123, { preparingAbilityHrid: '/abilities/berserk', isPreparingAutoAttack: false }), createPlayer(456, { preparingAbilityHrid: '/abilities/aqua_arrow', isPreparingAutoAttack: false })], [createMonster('/monsters/fly')]);
        zhFeature._handleBattleUpdated(createBattleUpdated(1, { 0: createPatch({ isAutoAtk: false, isStunned: true }), 1: createPatch({ cMP: 465 }) }), now);
        assert.equal(zhFeature._unitEffects.size, 0);
    });

    test('被暈期間仍顯示準備狂暴、暈完改普攻且沒扣魔：不算施放', () => {
        startBattle([createPlayer(123, { preparingAbilityHrid: '/abilities/berserk', isPreparingAutoAttack: false })], [createMonster('/monsters/fly')]);
        zhFeature._handleBattleUpdated(createBattleUpdated(1, { 0: createPatch({ isAutoAtk: false, abilityHrid: '/abilities/berserk', isStunned: true }) }), now);
        zhFeature._handleBattleUpdated(createBattleUpdated(1, { 0: createPatch({ isAutoAtk: false, abilityHrid: '/abilities/berserk' }) }), now + 3000);
        zhFeature._handleBattleUpdated(createBattleUpdated(1, { 0: createPatch() }), now + 4000);
        assert.equal(zhFeature._unitEffects.size, 0);
    });

    test('battleId 不同的更新直接忽略（跟遊戲一樣）', () => {
        startBattle([createPlayer(123, { preparingAbilityHrid: '/abilities/berserk', isPreparingAutoAttack: false })], [createMonster('/monsters/fly')]);
        assert.equal(zhFeature._handleBattleUpdated(createBattleUpdated(2, { 0: createPatch({ cMP: 435 }) }), now), false);
        assert.equal(zhFeature._unitEffects.size, 0);
        assert.equal(zhFeature._trackedUnits.get('player:123').actionKey, '/abilities/berserk');
    });

    test('重放同一技能是刷新到期時間，不會多一個', () => {
        startBattle([createPlayer(123, { preparingAbilityHrid: '/abilities/berserk', isPreparingAutoAttack: false })], [createMonster('/monsters/fly')]);
        zhFeature._handleBattleUpdated(createBattleUpdated(1, { 0: createPatch({ cMP: 435 }) }), now);
        zhFeature._handleBattleUpdated(createBattleUpdated(1, { 0: createPatch({ cMP: 435, isAutoAtk: false, abilityHrid: '/abilities/berserk' }) }), now + 1000);
        zhFeature._handleBattleUpdated(createBattleUpdated(1, { 0: createPatch({ cMP: 370 }) }), now + 5000);
        assert.deepEqual(getEffectKeys(zhFeature, 'player:123'), ['buff:/abilities/berserk']);
        assert.equal(zhFeature._unitEffects.get('player:123').get('buff:/abilities/berserk').expiresAt, now + 25000);
    });

    test('死亡或離開戰鬥會清掉效果', () => {
        startBattle([createPlayer(123, { preparingAbilityHrid: '/abilities/berserk', isPreparingAutoAttack: false })], [createMonster('/monsters/fly', { preparingAbilityHrid: '/abilities/frenzy', isPreparingAutoAttack: false })]);
        zhFeature._handleBattleUpdated(createBattleUpdated(1, { 0: createPatch({ cMP: 435 }) }, { 0: createPatch({ cMP: 435 }) }), now);
        assert.equal(zhFeature._unitEffects.size, 2);
        zhFeature._handleBattleUpdated(createBattleUpdated(1, { 0: createPatch({ cHP: 0, isAutoAtk: false }) }, { 0: createPatch({ leftCombat: true }) }), now + 1000);
        assert.equal(zhFeature._unitEffects.size, 0);
    });

    test('pMap 出現新的位置時會擴充單位數', () => {
        startBattle([createPlayer(123)], [createMonster('/monsters/fly')]);
        zhFeature._handleBattleUpdated(createBattleUpdated(1, { 2: createPatch() }), now);
        assert.equal(zhFeature._sideUnitCounts.players, 3);
        assert.deepEqual(toPlain(zhFeature._getLivingIndexes('players')), [0, 1, 2]);
    });

    test('同一場戰鬥的下一波：玩家效果保留、怪物清掉；新的一場全部清掉', () => {
        startBattle([createPlayer(123, { preparingAbilityHrid: '/abilities/berserk', isPreparingAutoAttack: false })], [createMonster('/monsters/fly')]);
        zhFeature._handleBattleUpdated(createBattleUpdated(1, { 0: createPatch({ cMP: 435 }) }), now);
        zhFeature._applyEffect('monster:0', 'debuff', '/abilities/maim', { durationSeconds: 12, typeHrids: [] }, now);
        startBattle([createPlayer(123)], [createMonster('/monsters/rat')], 2);
        assert.deepEqual(getEffectKeys(zhFeature, 'player:123'), ['buff:/abilities/berserk']);
        assert.equal(zhFeature._unitEffects.has('monster:0'), false);
        assert.equal(zhFeature._battleId, 2);
        startBattle([createPlayer(123)], [createMonster('/monsters/rat')], 1, '2026-10-01T09:00:00.000Z');
        assert.equal(zhFeature._unitEffects.size, 0);
    });

    test('init_character_data：同一個角色（重新連線）保留，換角色全部清掉', () => {
        zhFeature._handleCharacterData({ character: { id: 123 } });
        startBattle([createPlayer(123)], [createMonster('/monsters/fly')]);
        zhFeature._applyEffect('player:123', 'buff', '/abilities/berserk', { durationSeconds: 20, typeHrids: [] }, now);
        zhFeature._handleCharacterData({ character: { id: 123 } });
        assert.equal(zhFeature._unitEffects.size, 1);
        assert.equal(zhFeature._battleId, 1);
        zhFeature._handleCharacterData({ character: { id: 999 } });
        assert.equal(zhFeature._unitEffects.size, 0);
        assert.equal(zhFeature._battleId, null);
    });
});

describe('走完整的 WebSocket 掛鉤（先給 mwiTools 再給功能）', () => {
    test('init_character_data → new_battle → battle_updated 之後狂暴在玩家身上', () => {
        resetFeature(zhFeature);
        feedQuietly(zhHooks, characterDataMessage);
        feedQuietly(zhHooks, createNewBattle(5, [createPlayer(123, { preparingAbilityHrid: '/abilities/berserk', isPreparingAutoAttack: false })], [createMonster('/monsters/fly')]));
        assert.equal(zhFeature._battleId, 5);
        const before = Date.now();
        feedQuietly(zhHooks, createBattleUpdated(5, { 0: createPatch({ cMP: 435 }) }));
        const after = Date.now();
        const effect = zhFeature._unitEffects.get('player:123')?.get('buff:/abilities/berserk');
        assert.ok(effect, '應該推論出狂暴');
        assert.ok(effect.expiresAt >= before + 20000 && effect.expiresAt <= after + 20000);
    });

    test('設定關閉時什麼都不做', () => {
        const disabledHooks = loadMwiToolsScript(['BattleBuffsFeature', 'settingsMap'], {
            localStorageValues: { script_settingsMap: JSON.stringify({ ...quietSettings, battleBuffs: { id: 'battleBuffs', isTrue: false } }) },
        });
        const disabledFeature = disabledHooks.BattleBuffsFeature;
        assert.equal(disabledHooks.settingsMap.battleBuffs.isTrue, false);
        assert.equal(disabledFeature._countdownTimerId, null);
        feedQuietly(disabledHooks, createNewBattle(1, [createPlayer(123)], [createMonster('/monsters/fly')]));
        assert.equal(disabledFeature._battleId, null);
        assert.equal(disabledFeature._trackedUnits.size, 0);
    });

    test('預設開啟，啟動時有註冊每秒倒數', () => {
        assert.equal(zhHooks.settingsMap.battleBuffs.isTrue, true);
        assert.notEqual(zhFeature._countdownTimerId, null);
    });
});

describe('過期與排序', () => {
    beforeEach(() => resetFeature(zhFeature));

    test('過期效果會被剪掉，空的單位也一起刪', () => {
        zhFeature._applyEffect('player:1', 'buff', '/abilities/berserk', { durationSeconds: 20, typeHrids: [] }, now);
        zhFeature._applyEffect('player:1', 'buff', '/abilities/speed_aura', { durationSeconds: 120, typeHrids: [] }, now);
        zhFeature._applyEffect('monster:0', 'debuff', '/abilities/maim', { durationSeconds: 12, typeHrids: [] }, now);
        assert.equal(zhFeature._pruneExpiredEffects(now + 11000), false);
        assert.equal(zhFeature._pruneExpiredEffects(now + 20000), true);
        assert.deepEqual(getEffectKeys(zhFeature, 'player:1'), ['buff:/abilities/speed_aura']);
        assert.equal(zhFeature._unitEffects.has('monster:0'), false);
    });

    test('依到期時間由近到遠，同時間依效果鍵', () => {
        zhFeature._applyEffect('player:1', 'buff', '/abilities/speed_aura', { durationSeconds: 120, typeHrids: [] }, now);
        zhFeature._applyEffect('player:1', 'debuff', '/abilities/maim', { durationSeconds: 12, typeHrids: [] }, now);
        zhFeature._applyEffect('player:1', 'buff', '/abilities/berserk', { durationSeconds: 12, typeHrids: [] }, now);
        assert.deepEqual(toPlain(zhFeature._getSortedEffects('player:1', now).map((effect) => effect.effectKey)), [
            'buff:/abilities/berserk',
            'debuff:/abilities/maim',
            'buff:/abilities/speed_aura',
        ]);
        assert.equal(zhFeature._getSortedEffects('player:1', now + 12000).length, 1);
        assert.equal(zhFeature._getSortedEffects('player:404', now).length, 0);
    });
});

describe('倒數文字與提示', () => {
    beforeEach(() => {
        resetFeature(zhFeature);
        resetFeature(enFeature);
    });

    test('60 秒以內顯示秒數，更久顯示無條件進位分鐘', () => {
        assert.equal(zhFeature._formatRemainingText(0), '0');
        assert.equal(zhFeature._formatRemainingText(59), '59');
        assert.equal(zhFeature._formatRemainingText(60), '60');
        assert.equal(zhFeature._formatRemainingText(61), '2分');
        assert.equal(zhFeature._formatRemainingText(120), '2分');
        assert.equal(enFeature._formatRemainingText(61), '2m');
        assert.equal(zhFeature._getRemainingSeconds({ expiresAt: now + 11001 }, now), 12);
        assert.equal(zhFeature._getRemainingSeconds({ expiresAt: now - 5 }, now), 0);
    });

    test('技能名稱：中文用繁體站名稱，英文用 client data', () => {
        assert.equal(zhFeature._getAbilityDisplayName('/abilities/berserk'), '狂暴');
        assert.equal(zhFeature._getAbilityDisplayName('/abilities/mana_spring'), '法力噴泉');
        assert.equal(enFeature._getAbilityDisplayName('/abilities/berserk'), 'Berserk');
        assert.equal(enFeature._getAbilityDisplayName('/abilities/not_real_skill'), 'not real skill');
    });

    test('中文提示：效果類型用遊戲的翻譯函式；拿不到就整行省略', () => {
        const effect = { effectKey: 'buff:/abilities/berserk', abilityHrid: '/abilities/berserk', kind: 'buff', typeHrids: ['/buff_types/physical_amplify'] };
        assert.equal(zhFeature._buildChipTitle(effect, 12), '狂暴（增益）\n剩餘 12 秒');
        zhFeature._gameTranslate = (key) => (key === 'buffTypeNames./buff_types/physical_amplify' ? '物理增幅' : key);
        assert.equal(zhFeature._buildChipTitle(effect, 12), '狂暴（增益）\n效果：物理增幅\n剩餘 12 秒');
        const debuff = { effectKey: 'debuff:/abilities/pestilent_shot', abilityHrid: '/abilities/pestilent_shot', kind: 'debuff', typeHrids: ['/buff_types/armor', '/buff_types/physical_amplify'] };
        assert.equal(zhFeature._buildChipTitle(debuff, 3), `${zhFeature._getAbilityDisplayName('/abilities/pestilent_shot')}（減益）\n效果：物理增幅\n剩餘 3 秒`);
        zhFeature._gameTranslate = () => {
            throw new Error('翻譯失敗');
        };
        assert.equal(zhFeature._buildChipTitle(effect, 1), '狂暴（增益）\n剩餘 1 秒');
    });

    test('英文提示：效果類型用 client data 的 buffTypeDetailMap', () => {
        const effect = { effectKey: 'debuff:/abilities/pestilent_shot', abilityHrid: '/abilities/pestilent_shot', kind: 'debuff', typeHrids: ['/buff_types/armor', '/buff_types/fire_resistance'] };
        assert.equal(enFeature._buildChipTitle(effect, 7), 'Pestilent Shot (Debuff)\nEffects: Armor, Fire Resistance\n7s remaining');
    });
});

describe('跑馬燈、簽章、樣式', () => {
    test('4 個以內不捲動；5 個捲 6.875rem（根字級 16px 時 110px）、4.583 秒', () => {
        assert.deepEqual(toPlain(zhFeature._getMarqueeMetrics(4)), { isScrolling: false, distanceRem: 0, durationSeconds: 0 });
        assert.deepEqual(toPlain(zhFeature._getMarqueeMetrics(5)), { isScrolling: true, distanceRem: 6.875, durationSeconds: 4.583 });
        assert.equal(zhFeature._getMarqueeMetrics(10).durationSeconds, 9.167);
    });

    test('4 個 chip 放得進最窄的卡片（6.875rem 扣掉左右 0.125rem 內距），5 個放不下', () => {
        const innerWidthRem = 6.875 - 2 * 0.125;
        const chipWidthRem = 1.25;
        const gapRem = zhFeature._chipPitchRem - chipWidthRem;
        const capacity = zhFeature._staticChipCapacity;
        assert.ok(capacity * chipWidthRem + (capacity - 1) * gapRem <= innerWidthRem);
        assert.ok((capacity + 1) * chipWidthRem + capacity * gapRem > innerWidthRem);
        const styleText = zhFeature._buildStyleText();
        assert.ok(styleText.includes('width:1.25rem;height:1.25rem'));
        assert.ok(styleText.includes('gap:.125rem'));
    });

    test('簽章包含圖示模式與效果順序', () => {
        const effects = [{ effectKey: 'buff:/abilities/berserk' }, { effectKey: 'debuff:/abilities/maim' }];
        assert.equal(zhFeature._buildBarSignature(effects, 'abilities'), 'abilities|buff:/abilities/berserk,debuff:/abilities/maim');
        assert.equal(zhFeature._buildBarSignature([], 'text'), 'text|');
    });

    test('樣式包含所有用到的 class 與 CSS 變數', () => {
        const styleText = zhFeature._buildStyleText();
        for (const name of ['bar', 'track', 'sequence', 'chip', 'buff', 'debuff', 'icon', 'glyph', 'countdown', 'marquee']) {
            assert.ok(styleText.includes(`mwitools-local-battle-buffs-${name}`), name);
        }
        assert.ok(styleText.includes('--mwitools-local-battle-buffs-distance'));
        assert.ok(styleText.includes('--mwitools-local-battle-buffs-duration'));
        assert.ok(styleText.includes('prefers-reduced-motion'));
    });
});

describe('遊戲圖集網址', () => {
    beforeEach(() => resetFeature(zhFeature));

    test('解析技能 / 物品圖集網址，去掉 #符號', () => {
        assert.deepEqual(toPlain(zhFeature._parseSpriteUrl('/static/media/abilities_sprite.fdd1b4de.svg#berserk')), { kind: 'abilities', baseUrl: '/static/media/abilities_sprite.fdd1b4de.svg' });
        assert.deepEqual(toPlain(zhFeature._parseSpriteUrl('https://www.milkywayidle.com/static/media/items_sprite.f58c9476.svg')), {
            kind: 'items',
            baseUrl: 'https://www.milkywayidle.com/static/media/items_sprite.f58c9476.svg',
        });
        assert.equal(zhFeature._parseSpriteUrl('/static/media/buffs_sprite.cd54d85e.svg#wisdom'), null);
        assert.equal(zhFeature._parseSpriteUrl(undefined), null);
    });

    test('從畫面上的 <use href> 找技能圖集；找到後不再找，找不到時 2 秒節流', () => {
        const sandboxDocument = zhHooks.sandbox.document;
        const originalQuerySelector = sandboxDocument.querySelector;
        Object.assign(fakeSpriteLookup, { lookupCount: 0, abilitiesHref: '', itemsHref: '/static/media/items_sprite.aaa.svg#berserk' });
        sandboxDocument.querySelector = fakeSpriteQuerySelector;
        try {
            zhFeature._scanSpriteBaseUrls(now);
            assert.equal(zhFeature._getIconMode(), 'items');
            // 技能書圖示當備援（物品 /items/berserk 存在）；沒有對應技能書就不給圖示
            assert.equal(zhFeature._getIconHref('/abilities/berserk'), '/static/media/items_sprite.aaa.svg#berserk');
            assert.equal(zhFeature._getIconHref('/abilities/maim'), '');
            const countAfterFirstScan = fakeSpriteLookup.lookupCount;
            zhFeature._scanSpriteBaseUrls(now + 500);
            assert.equal(fakeSpriteLookup.lookupCount, countAfterFirstScan, '2 秒內不重找');
            fakeSpriteLookup.abilitiesHref = '/static/media/abilities_sprite.bbb.svg#aqua_arrow';
            zhFeature._scanSpriteBaseUrls(now + 2500);
            assert.equal(zhFeature._getIconMode(), 'abilities');
            assert.equal(zhFeature._getIconHref('/abilities/maim'), '/static/media/abilities_sprite.bbb.svg#maim');
            const countAfterFound = fakeSpriteLookup.lookupCount;
            zhFeature._scanSpriteBaseUrls(now + 9000);
            assert.equal(fakeSpriteLookup.lookupCount, countAfterFound, '找到技能圖集後不再找');
        } finally {
            sandboxDocument.querySelector = originalQuerySelector;
        }
    });

    test('畫面上找不到時看已載入的資源清單', () => {
        const sandboxPerformance = zhHooks.sandbox.performance;
        sandboxPerformance.getEntriesByType = () => [{ name: 'https://www.milkywayidle.com/static/js/main.js' }, { name: 'https://www.milkywayidle.com/static/media/abilities_sprite.ccc.svg' }];
        try {
            zhFeature._scanSpriteBaseUrls(now);
            assert.equal(zhFeature._spriteBaseUrls.abilities, 'https://www.milkywayidle.com/static/media/abilities_sprite.ccc.svg');
        } finally {
            delete sandboxPerformance.getEntriesByType;
        }
    });

    test('什麼圖集都沒有：文字模式', () => {
        assert.equal(zhFeature._getIconMode(), 'text');
        assert.equal(zhFeature._getIconHref('/abilities/berserk'), '');
    });
});

describe('畫面單位對應（React fiber）', () => {
    beforeEach(() => {
        resetFeature(zhFeature);
        zhFeature._handleNewBattle(createNewBattle(7, [createPlayer(123), createPlayer(456)], [createMonster('/monsters/fly'), createMonster('/monsters/rat')]));
    });

    test('從 fiber 讀出單位身分，並記下遊戲的翻譯函式', () => {
        const translate = (key) => key;
        const identity = zhFeature._readUnitIdentity(createUnitElement({ battleId: 7, battleWave: 0, combatUnit: { isPlayer: true, character: { id: 456 } }, index: 1, t: translate }));
        assert.deepEqual(toPlain(identity), { isPlayer: true, index: 1, battleId: 7, characterId: 456, monsterHrid: '' });
        assert.equal(zhFeature._gameTranslate, translate);
        assert.equal(zhFeature._readUnitIdentity({}), null);
    });

    test('玩家用角色 id 對應，怪物用位置並比對種類', () => {
        assert.equal(zhFeature._resolveUnitKey({ isPlayer: true, index: 0, battleId: 7, characterId: 456, monsterHrid: '' }, 'players', 0), 'player:456');
        assert.equal(zhFeature._resolveUnitKey({ isPlayer: false, index: 1, battleId: 7, characterId: null, monsterHrid: '/monsters/rat' }, 'monsters', 1), 'monster:1');
    });

    test('battleId 不同、不是這場的角色、怪物種類不符、側別不符：不掛列', () => {
        assert.equal(zhFeature._resolveUnitKey({ isPlayer: true, index: 0, battleId: 8, characterId: 123, monsterHrid: '' }, 'players', 0), '');
        assert.equal(zhFeature._resolveUnitKey({ isPlayer: true, index: 0, battleId: 7, characterId: 999, monsterHrid: '' }, 'players', 0), '');
        assert.equal(zhFeature._resolveUnitKey({ isPlayer: false, index: 1, battleId: 7, characterId: null, monsterHrid: '/monsters/fly' }, 'monsters', 1), '');
        assert.equal(zhFeature._resolveUnitKey({ isPlayer: false, index: 0, battleId: 7, characterId: null, monsterHrid: '/monsters/fly' }, 'players', 0), '');
    });

    test('沒有 fiber 時退回位置對應', () => {
        assert.equal(zhFeature._resolveUnitKey(null, 'players', 1), 'player:456');
        assert.equal(zhFeature._resolveUnitKey(null, 'monsters', 1), 'monster:1');
        assert.equal(zhFeature._resolveUnitKey(null, 'monsters', 2), '');
    });

    test('沙盒的假 DOM 沒有戰鬥面板：handleDomChange 安全結束', () => {
        assert.doesNotThrow(() => zhFeature.handleDomChange());
        assert.equal(zhFeature._hasRenderedChips, false);
    });

    test('倒數只改文字節點的 nodeValue', () => {
        const textNode = { nodeType: 3, nodeValue: '12' };
        const label = { firstChild: textNode, lastChild: textNode, textContent: '12' };
        zhFeature._setText(label, '11');
        assert.equal(textNode.nodeValue, '11');
        const emptyLabel = { firstChild: null, lastChild: null, textContent: '' };
        zhFeature._setText(emptyLabel, '5');
        assert.equal(emptyLabel.textContent, '5');
    });
});
