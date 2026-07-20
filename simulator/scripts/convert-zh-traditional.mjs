// 把 zh 語系檔的「值」從簡體轉為繁體中文（鍵名不動，與 en 的鍵名對照測試不受影響）。
// UI 文案用台灣用語轉換（twp），遊戲物品/行動名稱用純字元轉換（tw）避免改動專有名詞。
// 重新執行 sync-official-translations 後需要再跑一次本腳本：npm run convert-zh-traditional
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import path from "path";
import * as OpenCC from "opencc-js";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uiConverter = OpenCC.Converter({ from: "cn", to: "twp" });
const nameConverter = OpenCC.Converter({ from: "cn", to: "tw" });

function convertJsonValues(value, converter) {
    if (typeof value === "string") {
        return converter(value);
    }
    if (Array.isArray(value)) {
        return value.map((entry) => convertJsonValues(entry, converter));
    }
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [key, convertJsonValues(entry, converter)])
        );
    }
    return value;
}

function convertFile(relativePath, converter, indent) {
    const filePath = path.join(rootDirectory, relativePath);
    const raw = readFileSync(filePath, "utf8");
    const hasByteOrderMark = raw.charCodeAt(0) === 0xfeff;
    const data = JSON.parse(hasByteOrderMark ? raw.slice(1) : raw);
    const converted = convertJsonValues(data, converter);
    const output = (hasByteOrderMark ? "﻿" : "") + JSON.stringify(converted, null, indent) + "\n";
    writeFileSync(filePath, output);
    console.log("converted", relativePath);
}

convertFile("locales/zh/common.json", uiConverter, 4);
convertFile("locales/zh/translation.official.generated.json", nameConverter, 2);

// 同步更新 manifest 內記錄的 zh 譯文檔雜湊，維持完整性測試通過
const manifestPath = path.join(rootDirectory, "locales/official-translation-source.generated.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const zhContent = readFileSync(path.join(rootDirectory, "locales/zh/translation.official.generated.json"), "utf8");
manifest.resources.zh.sha256 = createHash("sha256").update(zhContent).digest("hex");
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log("updated manifest zh sha256");
