// 本 repo 本地補丁：網站顯示繁體中文。
// repo 內的中文資源維持上游原樣（簡體），只在 Vite 開發伺服器與 build 載入時轉成繁體——
// 上游測試大量比對簡體字串，原檔不動就不必改測試，同步上游時也不用重新轉換。
// UI 文案用台灣用語轉換（twp），遊戲物品／行動名稱只轉字元（tw），避免改動專有名詞。
// vitest 也會讀 vite.config，測試時不套用（測試要拿到上游原文）。
import * as OpenCC from 'opencc-js';

const uiConverter = OpenCC.Converter({ from: 'cn', to: 'twp' });
const nameConverter = OpenCC.Converter({ from: 'cn', to: 'tw' });

function convertValues(value, converter) {
  if (typeof value === 'string') {
    return converter(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => convertValues(entry, converter));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, convertValues(entry, converter)]));
  }
  return value;
}

// 更新日誌中英並存：只轉 { zh: ... } 欄位與中文日期鍵（「2026年10月26日（v3.2.2）」）
function convertZhFields(value, converter) {
  if (Array.isArray(value)) {
    return value.map((entry) => convertZhFields(entry, converter));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        converter(key),
        key === 'zh' ? convertValues(entry, converter) : convertZhFields(entry, converter),
      ]),
    );
  }
  return value;
}

const TARGETS = [
  { suffix: '/locales/zh/common.json', transform: (data) => convertValues(data, uiConverter) },
  {
    suffix: '/locales/zh/translation.official.generated.json',
    transform: (data) => convertValues(data, nameConverter),
  },
  { suffix: '/patchNote.json', transform: (data) => convertZhFields(data, uiConverter) },
];

// 中文寫死在原始碼裡、且只用於顯示（沒有拿中文做比對）的頁面：整個檔案轉換
const RAW_SOURCE_SUFFIXES = ['/src/ui/pages/GuidePage.vue', '/src/ui/pages/MultiResultsPage.vue'];

export function zhTraditional() {
  return {
    name: 'mwiext-zh-traditional',
    enforce: 'pre',
    apply: () => !process.env.VITEST,
    transform(code, id) {
      const rawId = String(id).replace(/\\/g, '/');
      // .vue 只轉主請求；?vue&type=… 子請求由 plugin-vue 從已轉換的描述檔產生
      if (!rawId.includes('?') && RAW_SOURCE_SUFFIXES.some((suffix) => rawId.endsWith(suffix))) {
        return { code: uiConverter(code), map: null };
      }
      const filePath = rawId.split('?')[0];
      const target = TARGETS.find((entry) => filePath.endsWith(entry.suffix));
      if (!target) {
        return null;
      }
      const source = code.charCodeAt(0) === 0xfeff ? code.slice(1) : code;
      return { code: JSON.stringify(target.transform(JSON.parse(source))), map: null };
    },
  };
}
