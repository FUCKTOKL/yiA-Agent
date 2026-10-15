import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMemoryTools } from "../src/agent/tools.ts";
import { L1Store } from "../src/memory/l1/profile.ts";
import { L2Store } from "../src/memory/l2/store.ts";
import { Logger } from "../src/logger.ts";

type CapturedTool = {
  name: string;
  parameters: { required?: string[] };
  execute(id: string, params: Record<string, unknown>): Promise<{ content: { text?: string }[]; isError?: boolean }>;
};

test("模型记忆工具：recall 返回版本，refine 拒绝旧版本，重读后可更新", async () => {
  const root = mkdtempSync(join(tmpdir(), "yia-memory-tools-"));
  const l2 = new L2Store(root);
  const entry = l2.save("模型工具原文", "模型工具标题");
  const tools = new Map<string, CapturedTool>();
  const pi = { registerTool: (tool: CapturedTool) => { tools.set(tool.name, tool); } } as unknown as ExtensionAPI;
  registerMemoryTools(pi, {
    l2, l1: new L1Store(join(root, "profile.json")), logger: new Logger(join(root, "logs")),
  });
  const recall = tools.get("recall")!, refine = tools.get("refine")!;
  assert.ok(refine.parameters.required?.includes("expectedVersion"));
  const recalled = await recall.execute("recall-1", { query: "模型工具" });
  assert.ok(recalled.content[0].text?.includes(`版本: ${entry.version}`));
  new L2Store(root).refine(entry.id, { content: "网页刚改的新正文" });
  const conflict = await refine.execute("refine-1", {
    id: entry.id, expectedVersion: entry.version, content: "模型基于旧原文生成的修改",
  });
  assert.equal(conflict.isError, true);
  assert.match(conflict.content[0].text!, /已被.*修改/);
  assert.equal(l2.byId(entry.id)!.content, "网页刚改的新正文");
  const fresh = l2.byId(entry.id)!;
  const success = await refine.execute("refine-2", {
    id: entry.id, expectedVersion: fresh.version, title: "读到新版后修改标题",
  });
  assert.notEqual(success.isError, true);
  assert.equal(l2.byId(entry.id)!.title, "读到新版后修改标题");
  assert.equal(l2.byId(entry.id)!.content, "网页刚改的新正文");
});
