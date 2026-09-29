// 從大型 Tampermonkey 腳本裡單獨取出一個「不依賴外部變數」的函式來測（整支腳本載入太多瀏覽器依賴）
// 用大括號配對找函式結尾：函式內的字串 / 正規表達式不能有不成對的大括號
import { readFileSync } from 'node:fs';

export function extractFunctionSource(source, functionName) {
    const startIndex = source.indexOf(`function ${functionName}(`);
    if (startIndex === -1) throw new Error(`找不到函式 ${functionName}`);
    const bodyStartIndex = source.indexOf('{', startIndex);
    let depth = 0;
    for (let index = bodyStartIndex; index < source.length; index++) {
        if (source[index] === '{') depth++;
        if (source[index] === '}') depth--;
        if (depth === 0) return source.slice(startIndex, index + 1);
    }
    throw new Error(`函式 ${functionName} 的大括號沒有成對`);
}

export function loadFunctionFromScript(scriptPath, functionName) {
    const functionSource = extractFunctionSource(readFileSync(scriptPath, 'utf8'), functionName);
    return new Function(`${functionSource}\nreturn ${functionName};`)();
}
