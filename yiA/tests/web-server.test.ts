/** Web 服务器 API 冒烟测试：工厂注入临时 root（不碰真实 runtime、不调模型） */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createYiaServer } from "../src/server/server.ts";
import { Logger } from "../src/logger.ts";

const root = mkdtempSync(join(tmpdir(), "yia-web-test-"));
mkdirSync(join(root, "runtime", "scheduler"), { recursive: true });
mkdirSync(join(root, "runtime", "l2", "entries"), { recursive: true });
writeFileSync(join(root, "runtime", "scheduler", "jobs.json"), "[]");
writeFileSync(join(root, "runtime", "l2", "entries", "20260914120000-aaaa1.md"),
  `---\nid: 20260914120000-aaaa1\ntitle: "条目一"\ntags: ["测试"]\nlinks: []\ncreated: "2026-09-14T12:00:00+08:00"\n---\n内容一`);
writeFileSync(join(root, "runtime", "l2", "entries", "20260914120100-bbbb2.md"),
  `---\nid: 20260914120100-bbbb2\ntitle: "条目二"\ntags: ["测试"]\nlinks: ["20260914120000-aaaa1"]\ncreated: "2026-09-14T12:01:00+08:00"\n---\n内容二`);

const server = createYiaServer({ root, logger: new Logger(join(root, "logs")), chat: async (t) => `回声：${t}` });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const j = async (path: string, init?: any) => {
  const res = await fetch(base + path, init);
  return { status: res.status, body: await res.json() };
};

test("GET /api/memory 返回全部条目", async () => {
  const { status, body } = await j("/api/memory");
  assert.equal(status, 200);
  assert.equal(body.entries.length, 2);
});

test("GET /api/memory?q= 走 BM25 检索", async () => {
  const { body } = await j("/api/memory?q=内容一");
  assert.ok(body.entries.some((e: any) => e.id === "20260914120000-aaaa1"));
});

test("DELETE /api/memory/:id 删除并清反向引用", async () => {
  const { status } = await j("/api/memory/20260914120000-aaaa1", { method: "DELETE" });
  assert.equal(status, 200);
  // 条目二的 links 里不应再引用已删条目
  const raw = readFileSync(join(root, "runtime", "l2", "entries", "20260914120100-bbbb2.md"), "utf8");
  assert.ok(!raw.includes("aaaa1"), "反向引用已清除");
  const { status: s2 } = await j("/api/memory/20260914120000-aaaa1", { method: "DELETE" });
  assert.equal(s2, 404);
});

test("POST /api/reminders 校验过去时间拒绝", async () => {
  const { status } = await j("/api/reminders", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "过去", at: "2020-01-01T00:00:00Z", channel: "wechat" }),
  });
  assert.equal(status, 400);
});

test("POST /api/reminders 建任务 + DELETE 取消", async () => {
  const at = new Date(Date.now() + 3600_000).toISOString();
  const { status, body } = await j("/api/reminders", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "web 建的", at, channel: "wechat" }),
  });
  assert.equal(status, 200);
  const { body: list } = await j("/api/reminders");
  assert.ok(list.pending.some((x: any) => x.title === "web 建的"));
  const { status: s2 } = await j(`/api/reminders/${body.job.id}`, { method: "DELETE" });
  assert.equal(s2, 200);
});

test("POST /api/chat SSE（注入假 chat，不打模型）", async () => {
  const res = await fetch(base + "/api/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hi" }),
  });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("content-type")!.includes("text/event-stream"));
});

test("未知 API 404 带错误文本", async () => {
  const { status, body } = await j("/api/nope");
  assert.equal(status, 404);
  assert.ok(body.error.includes("/api/nope"));
});

test("清理：关闭服务器与临时目录", async () => {
  server.close();
  rmSync(root, { recursive: true, force: true }); // 测试临时目录（mkdtemp 创建，非用户数据）
});
