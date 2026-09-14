// L2 自检：node --experimental-strip-types src/memory/l2/selfcheck.ts
// （或 npm test）覆盖：分词、frontmatter 往返、BM25 召回排序
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { L2Store } from "./store.ts";
import { tokenize } from "./tokenizer.ts";

// 1) 分词：拉丁词 + 中文二元组
const t = tokenize("WSL 装好 Node，验证 pi 环境环境");
if (!t.includes("wsl") || !t.includes("node")) throw new Error("拉丁分词失败");
if (!t.includes("环境") || !t.includes("验证")) throw new Error("CJK 二元组失败");

// 2) 存取 + 检索：写入临时目录，验证 frontmatter 往返与 BM25 排序
const dir = mkdtempSync(join(tmpdir(), "yia-l2-"));
const store = new L2Store(dir);
store.save("张三的生日是 3 月 5 日", undefined, ["人物"]);
store.save("React 19 用了 Vite 6 构建", "前端笔记", ["前端"]);
store.save("下周三要去看牙医", "待办", ["健康"]);

const hit = store.search("生日 张三");
if (hit[0]?.content.includes("3 月 5 日") !== true) throw new Error("BM25 未召回正确条目");
if (hit[0].tags[0] !== "人物") throw new Error("tags 往返失败");

// 3) 无命中时应返回空
const miss = store.search("量子物理");
if (miss.length !== 0) throw new Error("不应有召回");

// 4) 空查询返回最新优先
const latest = store.search("");
if (latest.length !== 3 || latest[0].title !== "待办") throw new Error("空查询应返回最新优先");

rmSync(dir, { recursive: true, force: true });
console.log("L2 selfcheck ✓ (3 entries, tokenize + BM25 + roundtrip)");
