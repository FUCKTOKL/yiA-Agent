/**
 * L2 单测：自动关联（双向链接）+ refine
 * 覆盖：M2 必测项——关联建立、双向、门槛以下不建链、refine 保留 id
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { L2Store, LINK_COVERAGE } from "../src/memory/l2/store.ts";
import { bm25Rank } from "../src/memory/l2/bm25.ts";

const dir = mkdtempSync(join(tmpdir(), "yia-l2-"));
const store = new L2Store(dir);

test("自动关联：内容相近的条目建立双向链接", () => {
  const a = store.save("张三的生日是 3 月 5 日，记得准备礼物", "张三生日", ["人物"]);
  const b = store.save("张三的生日快到了，需要提前一周订蛋糕", "生日提醒");
  // 两条都在讲"张三的生日"，应互相链接
  assert.ok(b.links.includes(a.id), "新条目应链接旧条目");
  const aNow = store.all().find((e) => e.id === a.id)!;
  assert.ok(aNow.links.includes(b.id), "旧条目应反向链接新条目");
});

test("门槛以下不建链：无关内容互不关联", () => {
  const c = store.save("React 19 的编译器模式显著减少了手写 memo", "前端笔记");
  const d = store.save("牙医预约改到下周四下午", "待办");
  assert.deepEqual(c.links, [], "无关条目不应有链接");
  assert.deepEqual(d.links, [], "无关条目不应有链接");
});

test("门槛边界：强相关覆盖率明显高于门槛，无关条目为零", () => {
  store.save("学习 TypeScript 的类型体操技巧", "TS 笔记");
  const hits = bm25Rank(store.all(), "TypeScript 类型体操", 5);
  assert.ok(hits.length > 0 && hits[0].coverage >= LINK_COVERAGE, "强相关应过门槛");
  const miss = bm25Rank(store.all(), "量子物理 宇宙射线", 5);
  assert.equal(miss.length, 0, "无关应无命中");
});

test("refine：修改内容但保留 id 与创建时间", () => {
  const e = store.save("原始内容待精炼", "待精炼");
  const updated = store.refine(e.id, { content: "精炼后的内容", tags: ["已整理"] });
  assert.ok(updated);
  assert.equal(updated!.id, e.id, "id 不变");
  assert.equal(updated!.created, e.created, "创建时间不变");
  assert.equal(updated!.content, "精炼后的内容");
  assert.deepEqual(updated!.tags, ["已整理"]);
  const reread = store.all().find((x) => x.id === e.id)!;
  assert.equal(reread.content, "精炼后的内容", "改动已落盘");
});

test("refine 不存在的 id 返回 null", () => {
  assert.equal(store.refine("不存在的id", { content: "x" }), null);
});

after(() => rmSync(dir, { recursive: true, force: true }));
