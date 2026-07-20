import { nextTick } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createMainSiteShareProfileFixture } from "./fixtures/mainSiteShareProfileFixture.js";
import {
    applyTampermonkeyEnhancementImportMessage,
    applyTampermonkeyImportMessage,
    applyTampermonkeyLoadoutCollectionMessage,
    applyTampermonkeySkillingImportMessage,
} from "../tampermonkeyImportBridge.js";
import { useSimulatorStore } from "../../stores/simulatorStore.js";
import { ENHANCEMENT_STORAGE_KEY, useEnhancementStore } from "../../stores/enhancementStore.js";

function createLocalStorageMock() {
    const store = new Map();
    return {
        getItem: vi.fn((key) => (store.has(key) ? store.get(key) : null)),
        setItem: vi.fn((key, value) => {
            store.set(key, String(value));
        }),
        removeItem: vi.fn((key) => {
            store.delete(key);
        }),
        clear: vi.fn(() => {
            store.clear();
        }),
    };
}

function createImportMessage(overrides = {}) {
    const characterName = overrides.characterName ?? "Imported Hero";
    return {
        requestId: String(overrides.requestId ?? `request-${characterName}`),
        targetPlayerId: String(overrides.targetPlayerId ?? "1"),
        payload: createMainSiteShareProfileFixture({ characterName }),
        ...overrides,
    };
}

function createLoadoutPayloadFixture(loadoutName) {
    return {
        character: { name: loadoutName },
        characterSkills: [{ skillHrid: "/skills/attack", level: 80, experience: 0 }],
        characterItems: [
            { itemHrid: "/items/cheese_sword", itemLocationHrid: "/item_locations/main_hand", enhancementLevel: 5, count: 1 },
        ],
    };
}

describe("tampermonkeyImportBridge", () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        global.localStorage = createLocalStorageMock();
    });

    it("stores combat loadout collections and applies only the first loadout", () => {
        const simulator = useSimulatorStore();
        const result = applyTampermonkeyLoadoutCollectionMessage(simulator, {
            requestId: "loadouts-1",
            activateAfterImport: true,
            payload: {
                characterName: "Hero",
                loadouts: [
                    { loadoutId: 1, loadoutName: "Boss Set", payload: createLoadoutPayloadFixture("Boss Set") },
                    { loadoutId: 2, loadoutName: "Farm Set", payload: createLoadoutPayloadFixture("Farm Set") },
                ],
            },
        });

        expect(result.storedCount).toBe(2);
        expect(result.appliedLoadoutName).toBe("Boss Set");
        expect(result.detectedFormat).toBe("main-site-combat-loadouts");
        expect(simulator.importedCombatLoadouts).toHaveLength(2);
        // 只套用到目前玩家欄位，其他欄位不受影響
        expect(simulator.players[0].name).toBe("Boss Set");
        expect(simulator.players[1].name).not.toBe("Farm Set");

        // 切換配裝會覆寫同一個玩家欄位
        simulator.applyImportedCombatLoadout(2);
        expect(simulator.players[0].name).toBe("Farm Set");
    });

    it("persists imported loadout collections across store instances", () => {
        const simulator = useSimulatorStore();
        applyTampermonkeyLoadoutCollectionMessage(simulator, {
            requestId: "loadouts-persist",
            payload: {
                loadouts: [
                    { loadoutId: 7, loadoutName: "Saved Set", payload: createLoadoutPayloadFixture("Saved Set") },
                ],
            },
        });

        setActivePinia(createPinia());
        const reloadedSimulator = useSimulatorStore();
        expect(reloadedSimulator.importedCombatLoadouts).toHaveLength(1);
        expect(reloadedSimulator.importedCombatLoadouts[0].loadoutName).toBe("Saved Set");
    });

    it("rejects loadout collections without any usable loadout", () => {
        const simulator = useSimulatorStore();
        expect(() => applyTampermonkeyLoadoutCollectionMessage(simulator, {
            requestId: "loadouts-empty",
            payload: { loadouts: [] },
        })).toThrow();
    });

    it("keeps the original active player during multi-slot team imports", () => {
        const simulator = useSimulatorStore();
        simulator.setActivePlayer("4");

        applyTampermonkeyImportMessage(simulator, createImportMessage({
            requestId: "team-1",
            targetPlayerId: "1",
            characterName: "Team Alpha",
            resetTeamSelection: true,
            selectAfterImport: true,
            activateAfterImport: false,
        }));
        applyTampermonkeyImportMessage(simulator, createImportMessage({
            requestId: "team-2",
            targetPlayerId: "2",
            characterName: "Team Beta",
            selectAfterImport: true,
            activateAfterImport: false,
        }));
        applyTampermonkeyImportMessage(simulator, createImportMessage({
            requestId: "team-3",
            targetPlayerId: "3",
            characterName: "Team Gamma",
            selectAfterImport: true,
            activateAfterImport: false,
        }));

        expect(simulator.activePlayerId).toBe("4");
        expect(simulator.players[0].name).toBe("Team Alpha");
        expect(simulator.players[1].name).toBe("Team Beta");
        expect(simulator.players[2].name).toBe("Team Gamma");
        expect(simulator.players[0].selected).toBe(true);
        expect(simulator.players[1].selected).toBe(true);
        expect(simulator.players[2].selected).toBe(true);
        expect(simulator.players[3].selected).toBe(false);
    });

    it("keeps the original active player even when that slot is part of the imported team", () => {
        const simulator = useSimulatorStore();
        simulator.setActivePlayer("2");

        applyTampermonkeyImportMessage(simulator, createImportMessage({
            requestId: "team-same-1",
            targetPlayerId: "1",
            characterName: "Team One",
            resetTeamSelection: true,
            selectAfterImport: true,
            activateAfterImport: false,
        }));
        applyTampermonkeyImportMessage(simulator, createImportMessage({
            requestId: "team-same-2",
            targetPlayerId: "2",
            characterName: "Team Two",
            selectAfterImport: true,
            activateAfterImport: false,
        }));
        applyTampermonkeyImportMessage(simulator, createImportMessage({
            requestId: "team-same-3",
            targetPlayerId: "3",
            characterName: "Team Three",
            selectAfterImport: true,
            activateAfterImport: false,
        }));

        expect(simulator.activePlayerId).toBe("2");
        expect(simulator.players[1].name).toBe("Team Two");
        expect(simulator.players[1].selected).toBe(true);
    });

    it("keeps backward-compatible activation when only selectAfterImport is provided", () => {
        const simulator = useSimulatorStore();
        simulator.setActivePlayer("4");

        applyTampermonkeyImportMessage(simulator, createImportMessage({
            requestId: "legacy-single",
            targetPlayerId: "2",
            characterName: "Solo Import",
            selectAfterImport: true,
        }));

        expect(simulator.activePlayerId).toBe("2");
        expect(simulator.players[1].name).toBe("Solo Import");
        expect(simulator.players[1].selected).toBe(true);
    });

    it("resets team selection before marking imported slots as selected", () => {
        const simulator = useSimulatorStore();
        simulator.players.forEach((player) => {
            player.selected = true;
        });

        applyTampermonkeyImportMessage(simulator, createImportMessage({
            requestId: "selection-reset",
            targetPlayerId: "2",
            characterName: "Selection Reset",
            resetTeamSelection: true,
            selectAfterImport: true,
            activateAfterImport: false,
        }));

        expect(simulator.players[0].selected).toBe(false);
        expect(simulator.players[1].selected).toBe(true);
        expect(simulator.players[2].selected).toBe(false);
        expect(simulator.players[3].selected).toBe(false);
        expect(simulator.players[4].selected).toBe(false);
    });

    it("clears requested non-target slots without affecting the imported target slot", () => {
        const simulator = useSimulatorStore();

        simulator.importSoloConfig(JSON.stringify(createMainSiteShareProfileFixture({ characterName: "Existing Two" })), "2");
        simulator.importSoloConfig(JSON.stringify(createMainSiteShareProfileFixture({ characterName: "Existing Three" })), "3");

        applyTampermonkeyImportMessage(simulator, createImportMessage({
            requestId: "clear-others",
            targetPlayerId: "1",
            characterName: "Fresh One",
            clearPlayerIds: ["1", "2", "3"],
            selectAfterImport: true,
            activateAfterImport: false,
        }));

        expect(simulator.players[0].name).toBe("Fresh One");
        expect(simulator.queue.importedProfileByPlayer["1"]).toBe(true);
        expect(simulator.players[1].name).toBe("Player 2");
        expect(simulator.players[2].name).toBe("Player 3");
        expect(simulator.queue.importedProfileByPlayer["2"]).toBe(false);
        expect(simulator.queue.importedProfileByPlayer["3"]).toBe(false);
    });

    it("routes a current-character snapshot to the skilling store", () => {
        const importProfile = vi.fn();
        const payload = {
            character: { name: "Skiller" },
            characterSkills: [{ skillHrid: "/skills/cooking", level: 31, experience: 12345 }],
            characterItems: [{ itemHrid: "/items/coin", itemLocationHrid: "/item_locations/inventory", count: 10 }],
        };

        const result = applyTampermonkeySkillingImportMessage({ importProfile }, { payload });

        expect(importProfile).toHaveBeenCalledOnce();
        expect(importProfile.mock.calls[0][0].characterName).toBe("Skiller");
        expect(result.detectedFormat).toBe("main-site-skilling-character");
    });

    it("keeps enhancement character imports in the current page session", async () => {
        const enhancement = useEnhancementStore();
        enhancement.config.targetLevel = 7;
        await nextTick();
        global.localStorage.setItem.mockClear();

        const result = applyTampermonkeyEnhancementImportMessage(enhancement, {
            payload: {
                character: { name: "Enhancer" },
                characterSkills: [{ skillHrid: "/skills/enhancing", level: 177 }],
            },
        });
        await nextTick();

        expect(result.detectedFormat).toBe("main-site-enhancement-character");
        expect(enhancement.config.skillLevel).toBe(177);
        expect(global.localStorage.setItem.mock.calls.some(([key]) => key === ENHANCEMENT_STORAGE_KEY)).toBe(false);

        setActivePinia(createPinia());
        const refreshedEnhancement = useEnhancementStore();
        expect(refreshedEnhancement.config.targetLevel).toBe(7);
        expect(refreshedEnhancement.config.skillLevel).toBe(100);
    });
});
