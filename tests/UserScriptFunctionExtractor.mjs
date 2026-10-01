// 從大型 Tampermonkey 腳本裡單獨取出「不依賴腳本內其他變數」的函式來測（整支腳本載入太多瀏覽器依賴）
// 用大括號配對找函式結尾：函式內的字串 / 正規表達式不能有不成對的大括號
import { readFileSync } from 'node:fs';

export function extractFunctionSource(source, functionName) {
    const startIndex = source.indexOf(`function ${functionName}(`);
    if (startIndex === -1) throw new Error(`找不到函式 ${functionName}`);
    const bodyStartIndex = source.indexOf('{', source.indexOf(')', startIndex));
    let depth = 0;
    for (let index = bodyStartIndex; index < source.length; index++) {
        if (source[index] === '{') depth++;
        if (source[index] === '}') depth--;
        if (depth === 0) return source.slice(startIndex, index + 1);
    }
    throw new Error(`函式 ${functionName} 的大括號沒有成對`);
}

/**
 * 一次取出多個互相呼叫的函式，放在同一個作用域
 * @param {string} scriptPath - 腳本路徑
 * @param {string[]} functionNames - 要取出的函式名稱
 * @param {string} preludeSource - 先執行的程式（例如補上函式用到的常數）
 * @returns {Object} - { 函式名稱: 函式 }
 */
export function loadFunctionsFromScript(scriptPath, functionNames, preludeSource = '') {
    const source = readFileSync(scriptPath, 'utf8');
    const functionSources = functionNames.map(functionName => extractFunctionSource(source, functionName));
    return new Function(`${preludeSource}\n${functionSources.join('\n')}\nreturn { ${functionNames.join(', ')} };`)();
}

export function loadFunctionFromScript(scriptPath, functionName) {
    return loadFunctionsFromScript(scriptPath, [functionName])[functionName];
}
