// 產生 Tampermonkey 殼腳本（stub）：只含各腳本的標頭，加一行 @require file:// 指向本資料夾內的原始檔。
// 路徑由本檔案所在位置自動推導，換機器或搬資料夾後重跑一次即可：node GenerateStubs.js
// 產物在 tampermonkey-stubs/（含機器絕對路徑，不進 git）。
const fs = require("fs");
const path = require("path");

const sourceDirectory = __dirname;
const outputDirectory = path.join(sourceDirectory, "tampermonkey-stubs");
fs.mkdirSync(outputDirectory, { recursive: true });

const scriptFiles = ["level.js", "maze.js", "mooket2.js", "mwiCombat.js", "mwiTools.js", "profit.js", "uiEnhace.js"];

for (const scriptFile of scriptFiles) {
    const source = fs.readFileSync(path.join(sourceDirectory, scriptFile), "utf8");
    const headerMatch = source.match(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/);
    if (!headerMatch) {
        console.error("no userscript header found:", scriptFile);
        continue;
    }
    // 拿掉 @updateURL/@downloadURL，避免 GreasyFork 自動更新蓋掉本地補丁
    const headerLines = headerMatch[0]
        .split("\n")
        .filter((line) => !/^\/\/ @(updateURL|downloadURL)/.test(line));

    const outputLines = [];
    for (const line of headerLines) {
        if (/^\/\/ @name(:[\w-]+)?\s/.test(line)) {
            outputLines.push(line.replace(/\s*$/, "") + " (local)");
        } else if (/^\/\/ ==\/UserScript==/.test(line)) {
            outputLines.push("// @require      file://" + path.join(sourceDirectory, scriptFile));
            outputLines.push(line.replace(/\s*$/, ""));
        } else {
            outputLines.push(line.replace(/\s*$/, ""));
        }
    }
    const outputPath = path.join(outputDirectory, scriptFile.replace(/\.js$/, ".stub.user.js"));
    fs.writeFileSync(outputPath, outputLines.join("\n") + "\n");
    console.log("wrote", outputPath);
}
