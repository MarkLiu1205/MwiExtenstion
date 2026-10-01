// 在 Node 的 vm 沙盒裡載入整支 mwiTools.js（Tampermonkey 腳本），把 IIFE 內部的函式 / class 掛出來給測試用
// 只模擬腳本啟動時會碰到的瀏覽器 / GM API；計時器一律不執行，不連網
// 環境變數 MWI_TOOLS_SCRIPT_PATH 可指定要載入的檔案（移植功能時用來測試合併後的暫存副本）
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

export function getMwiToolsScriptPath() {
    return process.env.MWI_TOOLS_SCRIPT_PATH || join(repositoryRoot, 'mwiTools.js');
}

class FakeElement {
    constructor(tagName = 'div') {
        this.tagName = tagName.toUpperCase();
        this.style = {};
        this.dataset = {};
        this.children = [];
        this.childNodes = [];
        this.classList = { add() {}, remove() {}, contains() { return false; }, toggle() {} };
        this.textContent = '';
        this.innerHTML = '';
        this.nodeType = 1;
    }
    appendChild(child) {
        this.children.push(child);
        return child;
    }
    append() {}
    prepend() {}
    remove() {}
    insertAdjacentHTML() {}
    insertAdjacentElement(position, element) {
        return element;
    }
    setAttribute() {}
    getAttribute() {
        return null;
    }
    removeAttribute() {}
    addEventListener() {}
    removeEventListener() {}
    querySelector() {
        return null;
    }
    querySelectorAll() {
        return [];
    }
    closest() {
        return null;
    }
    matches() {
        return false;
    }
    getBoundingClientRect() {
        return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
    }
    getContext() {
        return null;
    }
}

class FakeMutationObserver {
    observe() {}
    disconnect() {}
    takeRecords() {
        return [];
    }
}

class FakeMessageEvent {
    get data() {
        return null;
    }
}
class FakeWebSocket {}

function createStorage() {
    const store = new Map();
    return {
        getItem: (key) => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => store.set(key, String(value)),
        removeItem: (key) => store.delete(key),
        clear: () => store.clear(),
    };
}

function createFakeDocument() {
    const body = new FakeElement('body');
    return {
        URL: 'https://www.milkywayidle.com/game',
        hidden: false,
        body,
        documentElement: new FakeElement('html'),
        head: new FakeElement('head'),
        createElement: (tagName) => new FakeElement(tagName),
        createElementNS: (namespace, tagName) => new FakeElement(tagName),
        createTextNode: () => new FakeElement('#text'),
        querySelector: () => null,
        querySelectorAll: () => [],
        getElementById: () => null,
        getElementsByClassName: () => [],
        addEventListener: () => {},
        removeEventListener: () => {},
    };
}

/**
 * 載入 mwiTools.js，回傳指定名稱的函式 / class / 變數
 * @param {string[]} exportNames - 要掛出來的名稱（必須是 IIFE 內的頂層宣告）
 * @param {Object} options - { gmValues: 預先放進 GM 儲存的值, localStorageValues: 預先放進 localStorage 的值 }
 * @returns {Object} - { 名稱: 值, sandbox, gmStore, localStorage, feedMessage(訊息物件或字串) }
 */
export function loadMwiToolsScript(exportNames, options = {}) {
    const source = readFileSync(getMwiToolsScriptPath(), 'utf8');
    const closingIndex = source.lastIndexOf('})();');
    if (closingIndex === -1) throw new Error('mwiTools.js 結尾找不到 })();，無法掛測試鉤子');
    // 送一則遊戲訊息：跟真的 WebSocket 掛鉤一樣，先給 mwiTools 處理，再交給本地移植功能
    const hookSource = `
    globalThis.__mwiToolsTestHooks = { ${exportNames.join(', ')} };
    globalThis.__mwiToolsFeedMessage = function (messageText) {
        try {
            handleMessage(messageText);
        } catch (error) {
            console.error("handleMessage error:", error);
        } finally {
            dispatchLatestMessageToLocalFeatures();
        }
    };
`;
    const instrumentedSource = source.slice(0, closingIndex) + hookSource + source.slice(closingIndex);

    const gmStore = new Map(Object.entries(options.gmValues || {}));
    const localStorage = createStorage();
    for (const [key, value] of Object.entries(options.localStorageValues || {})) localStorage.setItem(key, value);
    const document = createFakeDocument();
    const sandbox = {
        console,
        document,
        localStorage,
        sessionStorage: createStorage(),
        navigator: { clipboard: { writeText: () => Promise.resolve() }, userAgent: 'node' },
        location: { href: document.URL, hostname: 'www.milkywayidle.com' },
        MutationObserver: FakeMutationObserver,
        MessageEvent: FakeMessageEvent,
        WebSocket: FakeWebSocket,
        Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
        HTMLElement: FakeElement,
        Element: FakeElement,
        Event: class {},
        CustomEvent: class {},
        KeyboardEvent: class {},
        MouseEvent: class {},
        Notification: class {},
        // 計時器一律不執行，避免輪詢 DOM 的程式卡住 Node
        setTimeout: () => 0,
        clearTimeout: () => {},
        setInterval: () => 0,
        clearInterval: () => {},
        requestAnimationFrame: () => 0,
        cancelAnimationFrame: () => {},
        queueMicrotask: (callback) => Promise.resolve().then(callback),
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => true,
        getComputedStyle: () => ({}),
        confirm: () => true,
        alert: () => {},
        fetch: () => Promise.reject(new Error('測試中不連網')),
        GM_addStyle: () => {},
        GM_notification: () => {},
        GM_getValue: (key, defaultValue) => (gmStore.has(key) ? gmStore.get(key) : defaultValue),
        GM_setValue: (key, value) => gmStore.set(key, value),
        GM_xmlhttpRequest: undefined,
        GM: {},
        URL,
        URLSearchParams,
        TextEncoder,
        TextDecoder,
        Intl,
        structuredClone,
        performance: { now: () => 0 },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox;
    sandbox.unsafeWindow = sandbox;
    createContext(sandbox);
    runInContext(instrumentedSource, sandbox, { filename: 'mwiTools.js' });
    const feedMessage = (payload) => sandbox.__mwiToolsFeedMessage(typeof payload === 'string' ? payload : JSON.stringify(payload));
    return { ...sandbox.__mwiToolsTestHooks, sandbox, gmStore, localStorage, feedMessage };
}
