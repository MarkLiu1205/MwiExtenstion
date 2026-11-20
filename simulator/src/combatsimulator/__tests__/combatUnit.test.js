import { describe, expect, it } from "vitest";

import CombatUnit from "../combatUnit.js";
import { buildSimulationExtraBuffs } from "../../shared/simulationExtraBuffs.js";

function createUnitWithBuffs(extraBuffs) {
    const unit = new CombatUnit();
    unit.zoneBuffs = [];
    unit.extraBuffs = extraBuffs;
    unit.generatePermanentBuffs();
    return unit;
}

describe("CombatUnit permanent buffs", () => {
    it("does not let party members accumulate the same shared extra buff objects", () => {
        // worker 會把同一份 extraBuffs 給每位隊員
        const sharedExtraBuffs = buildSimulationExtraBuffs({
            mooPass: true,
            comExp: 20,
            scrolls: ["/personal_buff_types/wisdom"],
        });
        const snapshot = structuredClone(sharedExtraBuffs);

        const first = createUnitWithBuffs(sharedExtraBuffs);
        const second = createUnitWithBuffs(sharedExtraBuffs);

        expect(first.permanentBuffs["/buff_types/wisdom"].flatBoost).toBeCloseTo(0.545, 6);
        expect(second.permanentBuffs["/buff_types/wisdom"].flatBoost).toBeCloseTo(0.545, 6);
        expect(sharedExtraBuffs).toEqual(snapshot);
    });
});
