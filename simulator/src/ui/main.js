import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import router from "./router/index.js";
import { initI18n } from "./i18n/i18n.js";
import "./styles.css";

// 部署新版後，還開著的舊分頁去抓舊 hash 的動態 chunk 會 404，
// 導致「Failed to fetch dynamically imported module」。
// 偵測到這種錯誤時自動重新整理一次載入新版；10 秒內只重載一次，避免無限迴圈。
const CHUNK_RELOAD_STORAGE_KEY = "mwi.chunkReload.at";

function reloadForStaleChunk() {
    let lastReloadAt = 0;
    try {
        lastReloadAt = Number(sessionStorage.getItem(CHUNK_RELOAD_STORAGE_KEY) || 0);
    } catch (error) {
        lastReloadAt = 0;
    }
    if (Date.now() - lastReloadAt < 10000) {
        return false;
    }
    try {
        sessionStorage.setItem(CHUNK_RELOAD_STORAGE_KEY, String(Date.now()));
    } catch (error) {
        // sessionStorage 不可用時仍然重載，僅失去防迴圈保護
    }
    window.location.reload();
    return true;
}

window.addEventListener("vite:preloadError", (event) => {
    if (reloadForStaleChunk()) {
        event.preventDefault();
    }
});

router.onError((error) => {
    const message = String(error?.message || "");
    if (/Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(message)) {
        reloadForStaleChunk();
    }
});

async function bootstrap() {
    await initI18n();

    const app = createApp(App);
    app.use(createPinia());
    app.use(router);
    app.mount("#app");
}

bootstrap();
