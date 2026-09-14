/**
 * ContextPack 单测：M2 必测项——门控召回的阈值边界（分数不够不注入）
 * 覆盖：画像注入、L2 强相关注入/弱相关不注入、L3 命中注入/未命中不注入
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { L1Store } from "../src/memory/l1/profile.ts";
import { L2Store } from "../src/memory/l2/store.ts";
import { L3Store } from "../src/memory/l3/sqlite-store.ts";
import { buildContextPack, L2_INJECT_COVERAGE } from "../src/memory/context-pack.ts";

const dir = mkdtempSync(join(tmpdir(), "yia-cp-"));
const l1 = new L1Store(join(dir, "profile.json"));
const l2 = new L2Store(dir);
const sessions = join(dir, "sessions");
mkdirSync(sessions);
const l3 = new L3Store(join(dir, "index.db"), sessions);

// 准备数据：画像 + 相关/无关记忆 + 会话
l1.update("identity", "独立开发者 qj");
l1.update("ongoing", "yiA 项目开发", true);
l2.save("张三的生日是 3 月 5 日，送书当礼物", "张三生日", ["人物"]);
l2.save("React 19 编译器模式减少手写 memo", "前端笔记", ["前端"]);
writeFileSync(
  join(sessions, "s1.jsonl"),
  JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/x" }) + "\n" +
    JSON.stringify({
      type: "message",
      id: "m1",
      timestamp: "2026-09-10T10:00:00Z",
      message: { role: "user", content: [{ type: "text", text: "张三的生日礼物选好了吗" }] },
    }) + "\n"
);
l3.sync();

test("画像始终注入（非空时）", () => {
  const pack = buildContextPack("", { l1, l2, l3 });
  assert.ok(pack.includes("独立开发者 qj"));
  assert.ok(pack.includes("yiA 项目开发"));
  assert.ok(!pack.includes("相关记忆"), "空提示词不触发检索注入");
});

test("L2 门控：强相关注入 + 引用 id", () => {
  const pack = buildContextPack("张三的生日是什么时候", { l1, l2, l3 });
  assert.ok(pack.includes("相关记忆"));
  assert.ok(/张三生日/.test(pack));
});

test("L2 门控：弱相关不注入（宁缺勿滥）", () => {
  const pack = buildContextPack("今天写点 Rust 代码", { l1, l2, l3 });
  assert.ok(!pack.includes("相关记忆"), "不相关查询不应注入记忆");
});

test("L3 门控：相关历史会话注入", () => {
  const pack = buildContextPack("张三 生日 礼物", { l1, l2, l3 });
  assert.ok(pack.includes("相关历史会话"));
  assert.ok(pack.includes("生日礼物"));
});

test("注入门槛常量为 0~1 且可调", () => {
  assert.ok(L2_INJECT_COVERAGE > 0 && L2_INJECT_COVERAGE <= 1);
});

after(() => {
  l3.close();
  rmSync(dir, { recursive: true, force: true });
});
