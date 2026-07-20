import i18next from "i18next";
import zhCommon from "../../../locales/zh/common.json";
import zhTranslation from "../../../locales/zh/translation.official.generated.json";

let initialized = false;

export async function initI18n() {
    if (initialized) {
        return i18next;
    }

    // 網站鎖定繁體中文，只打包 zh 資源；
    // locales/en/ 檔案保留在 repo 供上游同步工具與鍵名對照測試使用，不會進入網站
    await i18next.init({
        lng: "zh",
        fallbackLng: "zh",
        debug: false,
        showSupportNotice: false,
        interpolation: {
            escapeValue: false,
        },
        ns: ["common", "translation"],
        defaultNS: "common",
        fallbackNS: ["translation"],
        resources: {
            zh: {
                common: zhCommon,
                translation: zhTranslation,
            },
        },
    });

    initialized = true;
    return i18next;
}

export default i18next;
