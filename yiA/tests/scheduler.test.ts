/**
 * M3 调度器单测
 * 覆盖（docs/测试方案.md M3 必测项）：持久化往返、损坏降级、
 * 到点触发、重复顺延、错过补发、通知失败重试、取消
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore } from "../src/scheduler/job-store.ts";
import { ReminderRunner } from "../src/scheduler/runner.ts";
import { Logger } from "../src/logger.ts";

const dir = mkdtempSync(join(tmpdir(), "yia-sched-"));
const jobsFile = join(dir, "jobs.json");
const runsFile = join(dir, "runs.jsonl");
const logger = new Logger(join(dir, "logs")); // 测试日志落临时目录

/** 未来 N 秒的 ISO 时间 */
const inSec = (s: number) => new Date(Date.now() + s * 1000).toISOString();

test("jobs.json 持久化往返", () => {
  const s = new JobStore(jobsFile, runsFile);
  const j = s.add({ title: "喝水", at: inSec(60), channel: "tui" });
  const s2 = new JobStore(jobsFile, runsFile); // 新实例验证落盘
  const found = s2.byId(j.id);
  assert.ok(found && found.title === "喝水" && found.status === "pending");
});

test("jobs.json 损坏 → 备份 .bak 并从空表降级", () => {
  const f = join(dir, "broken.json");
  writeFileSync(f, "{broken");
  const s = new JobStore(f, runsFile);
  assert.deepEqual(s.all(), []);
  assert.ok(existsSync(f + ".bak"), "原文件应被备份");
});

test("到点触发：check 触发到期任务并记流水、标记完成", async () => {
  const s = new JobStore(jobsFile, runsFile);
  const fired: string[] = [];
  const runner = new ReminderRunner(s, (_j, t) => fired.push(t), logger);
  s.add({ title: "开会", at: inSec(0.05), channel: "tui" }); // 50ms 后到期（未错过）
  await new Promise((r) => setTimeout(r, 100));
  const out = runner.check();
  assert.equal(out.length, 1);
  assert.equal(fired.length, 1);
  assert.match(fired[0], /开会/);
  assert.ok(!fired[0].includes("错过"), "正常触发不带补发标记");
  assert.ok(s.pending().every((j) => j.title !== "开会"), "应标记完成");
  const runs = readFileSync(runsFile, "utf8").trim().split("\n");
  assert.ok(runs.some((l) => l.includes("开会") && l.includes("fired")));
});

test("未到点不触发", () => {
  const s = new JobStore(jobsFile, runsFile);
  const runner = new ReminderRunner(s, (_j, _t) => {}, logger);
  s.add({ title: "未来的事", at: inSec(3600), channel: "tui" });
  assert.equal(runner.check().length, 0);
});

test("重复任务：触发后顺延到下一个未来周期点", () => {
  const s = new JobStore(jobsFile, runsFile);
  const runner = new ReminderRunner(s, (_j, _t) => {}, logger);
  const j = s.add({ title: "吃药", at: inSec(-10), channel: "tui", repeatDays: 1 });
  runner.check();
  const now = s.byId(j.id)!;
  assert.equal(now.status, "pending", "重复任务保持待触发");
  assert.ok(new Date(now.at).getTime() > Date.now(), "at 已顺延到未来");
});

test("错过补发：过期任务触发并标记 missed", () => {
  const s = new JobStore(jobsFile, runsFile);
  const fired: string[] = [];
  const runner = new ReminderRunner(s, (_j, t) => fired.push(t), logger);
  s.add({ title: "错过的事", at: inSec(-3600), channel: "tui" }); // 1 小时前
  runner.check();
  assert.match(fired[0], /错过补发/);
  const runs = readFileSync(runsFile, "utf8").trim().split("\n");
  assert.ok(runs.some((l) => l.includes("missed")));
});

test("通知失败不标记完成（下轮重试）", () => {
  const s = new JobStore(jobsFile, runsFile);
  let shouldThrow = true;
  const runner = new ReminderRunner(s, (_j, _t) => {
    if (shouldThrow) throw new Error("通道故障");
  }, logger);
  const j = s.add({ title: "重试的任务", at: inSec(-1), channel: "tui" });
  assert.equal(runner.check().length, 0);
  assert.equal(s.byId(j.id)!.status, "pending", "失败后保持待触发");
  shouldThrow = false;
  assert.equal(runner.check().length, 1, "下轮重试成功");
});

test("取消任务", () => {
  const s = new JobStore(jobsFile, runsFile);
  const j = s.add({ title: "要取消的", at: inSec(3600), channel: "tui" });
  assert.ok(s.cancel(j.id));
  assert.equal(s.byId(j.id)!.status, "cancelled");
  assert.ok(!s.cancel(j.id), "重复取消返回 false");
});

test("跨进程并发：另一实例新增的任务不被本实例的写操作覆盖（双进程并用场景）", () => {
  const f = join(dir, "conc.json");
  const r = join(dir, "conc-runs.jsonl");
  const a = new JobStore(f, r);
  const jobA = a.add({ title: "A进程的任务", at: inSec(60), channel: "tui" });
  // B 进程在 A 之后启动（加载到含 jobA 的状态），新增自己的任务
  const b = new JobStore(f, r);
  const jobB = b.add({ title: "B进程的任务", at: inSec(90), channel: "tui" });
  // A 进程随后发生写操作（如触发完成/取消）——用旧内存快照整写文件
  a.cancel(jobA.id);
  // 修复目标：B 的任务必须在文件里存活
  const final = new JobStore(f, r);
  assert.ok(final.byId(jobB.id), "A 的写操作不应抹掉 B 新增的任务");
  assert.equal(final.byId(jobA.id)!.status, "cancelled");
});

test("重复触发防护：已完成任务再次 finishOrReschedule 是无操作", () => {
  const f = join(dir, "idem.json");
  const r = join(dir, "idem-runs.jsonl");
  const a = new JobStore(f, r);
  const j = a.add({ title: "一次性", at: inSec(-10), channel: "tui" });
  a.finishOrReschedule(j.id, new Date());
  a.finishOrReschedule(j.id, new Date()); // 模拟另一进程重复 finish，应为无操作
  assert.equal(a.byId(j.id)!.status, "done");
});

after(() => rmSync(dir, { recursive: true, force: true }));
