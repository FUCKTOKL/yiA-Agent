/**
 * 性能基准（docs/测试方案.md §3）：1 万条记忆，recall P95 < 1s。
 * 运行：cd yiA && npm run bench
 *
 * 语料直接写文件生成（绕开 save 的自动关联，那是 O(n) 每条的生成期成本，
 * 不属于被测的检索路径）；随后分别测冷加载（首次读盘建索引）与热检索。
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { L2Store } from "../src/memory/l2/store.ts";

const N = 10_000; // 条目数
const Q = 100;    // 查询次数

const dir = mkdtempSync(join(tmpdir(), "yia-bench-"));
const entriesDir = join(dir, "runtime", "l2", "entries");
mkdirSync(entriesDir, { recursive: true });
console.log(`生成 ${N} 条假数据…`);

// 中英混合假语料，覆盖真实分布
const words = ["项目", "会议", "部署", "接口", "性能", "测试", "设计", "文档",
  "memory", "server", "scheduler", "react", "node", "sqlite"];
const rand = (n: number) => Math.floor(Math.random() * n);
for (let i = 0; i < N; i++) {
  const body = Array.from({ length: 20 }, () => words[rand(words.length)]).join(" ");
  writeFileSync(
    join(entriesDir, `gen-${String(i).padStart(6, "0")}.md`),
    `---\nid: gen-${i}\ntitle: ${JSON.stringify(body.slice(0, 30))}\ntags: ["t${rand(10)}"]\nlinks: []\ncreated: 2026-09-11T10:00:00.${String(i).padStart(3, "0")}Z\n---\n${body}\n`,
    "utf8"
  );
}

// ---- 冷加载：首次访问触发全量读盘 + 建索引 ----
const store = new L2Store(dir);
let t0 = performance.now();
store.all();
const coldMs = performance.now() - t0;
console.log(`冷加载（读 ${N} 文件建索引）: ${coldMs.toFixed(0)}ms`);

// ---- 热检索：纯内存 BM25 ----
console.log(`跑 ${Q} 次热检索…`);
const times: number[] = [];
for (let i = 0; i < Q; i++) {
  const q = [words[rand(words.length)], words[rand(words.length)]].join(" ");
  t0 = performance.now();
  store.search(q, 5);
  times.push(performance.now() - t0);
}
times.sort((a, b) => a - b);
const p = (x: number) => times[Math.min(times.length - 1, Math.floor(times.length * x))].toFixed(1);
console.log(`热检索  min=${p(0)}ms  p50=${p(0.5)}ms  p95=${p(0.95)}ms  max=${p(1)}ms`);

if (Number(p(0.95)) >= 1000) {
  console.error("❌ 热 P95 超过 1s 基线");
  process.exit(1);
}
if (coldMs >= 1000) {
  console.warn(`⚠️ 冷加载 ${coldMs.toFixed(0)}ms 超 1s（首条 recall 才会感知）；过慢时按 store.ts ponytail 注释加 index.json`);
}
console.log("✅ 热检索 P95 < 1s，性能达标");

rmSync(dir, { recursive: true, force: true });
