import { createApp } from 'vue';
import { createPinia } from 'pinia';
import '@fontsource/chakra-petch/latin-400.css';
import '@fontsource/chakra-petch/latin-500.css';
import '@fontsource/chakra-petch/latin-600.css';
import '@fontsource/chakra-petch/latin-700.css';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import App from './App.vue';
import router from './router/index.js';
import { initI18n } from './i18n/i18n.js';
import { initializeTheme } from './composables/useTheme.js';
import { validateSpecialMarketFeeRateHrids } from '../services/marketPriceService.js';
import { scheduleEnginePrewarm } from '../services/enginePrewarm.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './components/ui/table/index.js';
import { NativeSelect } from './components/ui/native-select/index.js';
import './styles.css';

// 本 repo 本地補丁：部署新版後，還開著的舊分頁去抓舊 hash 的動態 chunk 會 404，
// 導致「Failed to fetch dynamically imported module」。
// 偵測到這種錯誤時自動重新整理一次載入新版；10 秒內只重載一次，避免無限迴圈。
const CHUNK_RELOAD_STORAGE_KEY = 'mwi.chunkReload.at';
const STALE_CHUNK_ERROR_PATTERN =
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i;

function reloadForStaleChunk() {
  let lastReloadAt = 0;
  try {
    lastReloadAt = Number(sessionStorage.getItem(CHUNK_RELOAD_STORAGE_KEY) || 0);
  } catch {
    lastReloadAt = 0;
  }
  if (Date.now() - lastReloadAt < 10000) {
    return false;
  }
  try {
    sessionStorage.setItem(CHUNK_RELOAD_STORAGE_KEY, String(Date.now()));
  } catch {
    // sessionStorage 不可用時仍然重載，僅失去防迴圈保護
  }
  window.location.reload();
  return true;
}

window.addEventListener('vite:preloadError', (event) => {
  if (reloadForStaleChunk()) {
    event.preventDefault();
  }
});

router.onError((error) => {
  if (STALE_CHUNK_ERROR_PATTERN.test(String(error?.message || ''))) {
    reloadForStaleChunk();
  }
});

// 本 repo 本地補丁：網站鎖定繁體中文（語言切換按鈕已拿掉）。
// 以前切過英文的使用者，啟動時把偏好改回中文，i18n 與 store 都會讀到 zh。
function lockLanguageToChinese() {
  try {
    localStorage.setItem('i18nextLng', 'zh');
  } catch {
    // localStorage 不可用時 i18n 本來就用預設語言（zh）
  }
}

async function bootstrap() {
  lockLanguageToChinese();
  initializeTheme();
  validateSpecialMarketFeeRateHrids();
  await initI18n();

  const app = createApp(App);
  app.use(createPinia());
  app.use(router);
  app.component('Table', Table);
  app.component('TableBody', TableBody);
  app.component('TableCell', TableCell);
  app.component('TableHead', TableHead);
  app.component('TableHeader', TableHeader);
  app.component('TableRow', TableRow);
  app.component('NativeSelect', NativeSelect);
  app.mount('#app');

  // 挂载完成后在空闲时间预热 wasm 引擎与 worker bundle（幂等；等待 load 事件，
  // 不与首屏资源竞争带宽）。目的：把首次点击「开始模拟」的冷启动开销
  // 挪到用户还在配置队伍的空闲时间预付，详见 enginePrewarm.js。
  scheduleEnginePrewarm();
}

bootstrap();
