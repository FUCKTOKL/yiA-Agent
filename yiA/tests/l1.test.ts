/**
 * L1 画像单测：node --test 自动发现
 * 覆盖：默认空画像、读写往返、append 去重、replace、区块校验容错
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { L1Store } from "../src/memory/l1/profile.ts";

const dir = mkdtempSync(join(tmpdir(), "yia-l1-"));
const file = join(dir, "profile.json");

test("空画像默认值", () => {
  const s = new L1Store(file);
  const p = s.read();
  assert.equal(p.identity, "");
  assert.deepEqual(p.preferences, []);
  assert.deepEqual(p.ongoing, []);
  assert.deepEqual(p.facts, []);
});

test("identity 替换 + 列表 append 去重", () => {
  const s = new L1Store(file);
  s.update("identity", "独立开发者");
  s.update("preferences", "回复用中文", true);
  s.update("preferences", "回复用中文", true); // 重复应去重
  s.update("preferences", "简洁", true);
  const p = new L1Store(file).read(); // 新实例验证落盘
  assert.equal(p.identity, "独立开发者");
  assert.deepEqual(p.preferences, ["回复用中文", "简洁"]);
});

test("列表 replace 模式", () => {
  const s = new L1Store(file);
  s.update("ongoing", "A 项目", true);
  s.update("ongoing", "只做 B", false); // 替换
  assert.deepEqual(s.read().ongoing, ["只做 B"]);
});

test("文件损坏时返回空画像不崩", () => {
  writeFileSync(file, "{broken json");
  const p = new L1Store(file).read();
  assert.equal(p.identity, "");
});

after(() => rmSync(dir, { recursive: true, force: true }));
