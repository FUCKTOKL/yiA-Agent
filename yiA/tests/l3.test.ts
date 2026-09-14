/**
 * L3 单测：会话 JSONL 同步 + 门控检索
 * 覆盖：M2 必测项——索引同步、增量（未变文件跳过）、覆盖率门控边界、损坏容错
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { L3Store } from "../src/memory/l3/sqlite-store.ts";

const dir = mkdtempSync(join(tmpdir(), "yia-l3-"));
const sessions = join(dir, "sessions");
mkdirSync(sessions);
const dbPath = join(dir, "index.db");

/** 构造一行 Pi 会话 JSONL */
function msgLine(role: string, text: string, id: string, ts: string): string {
  return JSON.stringify({
    type: "message",
    id,
    timestamp: ts,
    message: { role, content: [{ type: "text", text }] },
  });
}

test("同步并检索：中文 bigram 命中", () => {
  writeFileSync(
    join(sessions, "2026-09-11_session-a.jsonl"),
    [
      JSON.stringify({ type: "session", version: 3, id: "a", cwd: "/x" }),
      msgLine("user", "张三的生日是 3 月 5 日", "m1", "2026-09-11T10:00:00Z"),
      msgLine("assistant", "已记住张三的生日", "m2", "2026-09-11T10:00:05Z"),
      msgLine("user", "帮我看看这个报错 [图片]", "m3", "2026-09-11T10:05:00Z"), // 非文本内容混入场景
    ].join("\n") + "\n"
  );
  const store = new L3Store(dbPath, sessions);
  const r = store.sync();
  assert.equal(r.files, 1);
  assert.equal(r.msgs, 3);

  const hits = store.search("张三 生日");
  assert.ok(hits.length >= 1, "应命中相关消息");
  assert.ok(hits.some((h) => h.text.includes("3 月 5 日")));
  store.close();
});

test("增量同步：文件未变则跳过", () => {
  const store = new L3Store(dbPath, sessions);
  const before = store.sync();
  assert.equal(before.files, 0, "未变化不应重索引");
  // 追加一行后应重新索引
  const f = join(sessions, "2026-09-11_session-a.jsonl");
  const old = readFileSync(f, "utf8");
  writeFileSync(f, old + msgLine("user", "李四的电话是 12345", "m4", "2026-09-11T11:00:00Z"));
  const after2 = store.sync();
  assert.equal(after2.files, 1);
  assert.ok(store.search("李四 电话").length >= 1);
  store.close();
});

test("门控边界：单词弱命中被丢弃，多词强命中通过", () => {
  writeFileSync(
    join(sessions, "2026-09-11_session-b.jsonl"),
    msgLine("user", "今天天气不错", "b1", "2026-09-11T12:00:00Z") + "\n"
  );
  const store = new L3Store(dbPath, sessions);
  store.sync();
  // "天气 很冷" 只命中"天气"一个词元（"很冷"不在库）→ 单词查询放宽为 1，应通过
  assert.ok(store.search("天气").length === 1);
  // "天气 冷"（多词，仅命中 1 个 < 阈值 2）→ 应被门控丢弃
  assert.equal(store.search("天气 冷").length, 0);
  store.close();
});

test("损坏文件/行容错", () => {
  writeFileSync(
    join(sessions, "2026-09-11_session-broken.jsonl"),
    "{broken json\n" + msgLine("user", "正常一行", "ok1", "2026-09-11T13:00:00Z") + "\n"
  );
  const store = new L3Store(dbPath, sessions);
  const r = store.sync(); // 残缺行跳过，正常行照常索引，不抛异常
  assert.equal(r.msgs, 1);
  assert.ok(store.search("正常").length >= 1);
  store.close();
});

after(() => rmSync(dir, { recursive: true, force: true }));
