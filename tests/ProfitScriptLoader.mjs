// 在 Node 的 vm 沙盒裡載入 profit.js（Tampermonkey 腳本），把 IIFE 內部函式掛出來給測試用
// 只模擬腳本啟動時會碰到的瀏覽器 / GM API，不連網、不啟動計時器
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const testHooksSource = `
    globalThis.__profitPanelTestHooks = {
        globals,
        buffs,
        Buff,
        ProfitCaculation,
        mergeSimulatedScrollBuffs,
        toggleScrollKey,
        validateProfitSettings,
        generateScrollBuffButtons,
        calculateWisdomScrollExp,
        findSkillActionDetailInstance,
        collectCurrentActionBuffs,
        formatWisdomScrollExpHint,
        getWisdomScrollExpHint,
        findActionHridByName,
        simulatedScrollOptions
    };
})();`;

class FakeMessageEvent {
    get data() {
        return null;
    }
}
class FakeWebSocket {}

function createFakeDocument() {
    return {
        hidden: false,
        querySelector: () => null,
        querySelectorAll: () => [],
        getElementById: () => null,
        addEventListener: () => {},
        removeEventListener: () => {},
        createElement: () => ({ style: {}, appendChild: () => {}, setAttribute: () => {} }),
        body: { appendChild: () => {} }
    };
}

function createSandbox() {
    const gmStorage = new Map();
    const sandbox = {
        console,
        document: createFakeDocument(),
        localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
        MessageEvent: FakeMessageEvent,
        WebSocket: FakeWebSocket,
        CustomEvent: class {},
        LZString: { decompressFromUTF16: () => null },
        unsafeWindow: {},
        addEventListener: () => {},
        dispatchEvent: () => {},
        requestAnimationFrame: () => 0,
        // 測試只驗證計算，計時器一律不執行，避免 Node 程序被市場刷新計時器卡住
        setTimeout: () => 0,
        clearTimeout: () => {},
        setInterval: () => 0,
        GM_getValue: (key, defaultValue) => (gmStorage.has(key) ? gmStorage.get(key) : defaultValue),
        GM_setValue: (key, value) => gmStorage.set(key, value),
        GM_registerMenuCommand: () => {},
        GM_xmlhttpRequest: () => {},
        GM_addStyle: () => {}
    };
    sandbox.window = { location: { hostname: 'www.milkywayidle.com' } };
    return sandbox;
}

export function loadProfitScript(scriptPath) {
    const source = readFileSync(scriptPath, 'utf8');
    const closingIndex = source.lastIndexOf('})();');
    if (closingIndex === -1) throw new Error('profit.js 結尾找不到 })();，無法掛測試鉤子');
    const instrumentedSource = source.slice(0, closingIndex) + testHooksSource + source.slice(closingIndex + '})();'.length);
    const sandbox = createSandbox();
    createContext(sandbox);
    runInContext(instrumentedSource, sandbox, { filename: 'profit.js' });
    return sandbox.__profitPanelTestHooks;
}
