/**
 * Web 前端模块图冒烟：用 DOM 桩在 Node 里加载全部 ES modules，
 * 专防“顶层绑定 null 元素抛错 → 整条 import 链断 → 全页按钮失效”事故
 * （2026-09-14：index.html 漏了 fbToggle，memory.js 顶层 null.onclick 断链）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const webDir = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
const html = readFileSync(join(webDir, "index.html"), "utf8");

/** 极简元素桩：任何属性读写/方法调用都安全 */
const stubEl = () =>
  new Proxy(
    { style: {}, classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } }, dataset: {} },
    {
      get(t, k) {
        if (k in t) return Reflect.get(t, k);
        if (["addEventListener", "insertAdjacentHTML", "scrollIntoView", "focus", "click", "append", "replaceChildren", "setAttribute", "removeAttribute"].includes(String(k))) return () => {};
        if (k === "querySelector" || k === "querySelectorAll" || k === "closest") return () => (k === "querySelectorAll" ? [] : stubEl());
        if (k === "getBoundingClientRect") return () => ({ left: 0, top: 0, width: 100, height: 100 });
        if (k === "value" || k === "textContent" || k === "innerHTML") return "";
        return Reflect.get(t, k);
      },
      set() { return true; },
    },
  );

/** 抓取 html 里全部 id + data-*，模拟 querySelector 精确命中检测 */
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const doc = {
  querySelector(sel: string) {
    const m = sel.match(/^#([a-zA-Z][\w-]*)$/); // 只精检纯 id 选择器
    if (m && !ids.has(m[1])) throw new Error(`模块顶层引用了不存在的 id：${sel}`);
    return stubEl();
  },
  querySelectorAll: () => [],
  addEventListener: () => {},
  createElement: () => stubEl(),
  createTextNode: (text: string) => ({ textContent: text }),
  createElementNS: () => stubEl(),
  body: stubEl(),
};
globalThis.Option = function (text = "", value = "") {
  return Object.assign(stubEl(), { textContent: text, value });
} as unknown as typeof Option;
globalThis.document = doc as unknown as Document;
globalThis.window = { addEventListener: () => {}, location: { reload() {} } } as unknown as Window & typeof globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {} } as unknown as Storage;
globalThis.fetch = async () => new Response(JSON.stringify({ entries: [], msgs: [], pending: [], done: [], enabled: false, models: [], auth: {}, sessions: [], books: [] }));
globalThis.requestAnimationFrame = () => 0;

test("index.html 覆盖全部 js 顶层引用的 id（防断链复发）", () => {
  for (const f of ["app.js", "chat.js", "memory.js", "reminders.js", "wechat.js", "status.js", "models.js", "dialogs.js", "books.js"]) {
    const src = readFileSync(join(webDir, "js", f), "utf8");
    // 顶层模块作用域的纯 id 引用（含字符串模板外的调用点）
    for (const m of src.matchAll(/\$\("#([a-zA-Z][\w-]*)"\)/g)) {
      assert.ok(ids.has(m[1]), `${f} 引用的 #${m[1]} 在 index.html 中不存在`);
    }
  }
});

test("全部模块可在 DOM 桩下加载（顶层无异常）", async () => {
  await import(join(webDir, "js", "app.js"));
});
