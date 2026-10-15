import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createYiaServer, type YiaServerDeps } from "../src/server/server.ts";
import { loadModelCatalog } from "../src/server/model-catalog.ts";
import { Logger } from "../src/logger.ts";

const choices = [
  { provider: "openai-codex", id: "gpt-5.5", name: "GPT-5.5" },
  { provider: "zai-coding-cn", id: "glm-5.3", name: "GLM-5.3" },
  { provider: "first", id: "shared", name: "同名模型 A" },
  { provider: "second", id: "shared", name: "同名模型 B" },
];

async function setup(t: { after(fn: () => Promise<void>): void }, overrides: Partial<YiaServerDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), "yia-model-settings-"));
  const agentDir = join(root, "runtime", "agent");
  mkdirSync(agentDir, { recursive: true });
  const file = join(agentDir, "settings.json");
  writeFileSync(file, JSON.stringify({ defaultProvider: "zai-coding-cn", defaultModel: "glm-5.3", theme: "light", packages: ["keep-this"] }));
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": { type: "oauth", access: "must-not-return-this-secret" } }));
  let resets = 0;
  const server = createYiaServer({ root, logger: new Logger(join(root, "logs")), modelCatalog: async () => choices,
    resetChatSessions: async () => { resets++; }, ...overrides });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r, reject) => server.close((e) => e ? reject(e) : r())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const request = async (path: string, data?: object) => {
    const res = await fetch(base + path, data ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) } : undefined);
    return { status: res.status, body: await res.json() };
  };
  return { root, agentDir, file, base, request, resets: () => resets };
}

test("模型设置清单带服务商，且不返回凭据", async (t) => {
  const app = await setup(t);
  const { status, body } = await app.request("/api/login");
  assert.equal(status, 200);
  assert.deepEqual(body.models, choices);
  assert.equal(body.defaultProvider, "zai-coding-cn");
  assert.equal(body.auth["openai-codex"], "oauth");
  assert.ok(!JSON.stringify(body).includes("must-not-return-this-secret"));
});

test("跨服务商切换：成对保存配置，释放旧会话，保留其他设置与历史", async (t) => {
  const app = await setup(t);
  mkdirSync(join(app.root, "runtime", "chats"));
  const history = join(app.root, "runtime", "chats", "web.jsonl");
  writeFileSync(history, "keep-history\n");
  const { status, body } = await app.request("/api/model", { provider: "openai-codex", model: "gpt-5.5" });
  assert.equal(status, 200);
  assert.equal(body.provider, "openai-codex");
  const saved = JSON.parse(readFileSync(app.file, "utf8"));
  assert.equal(saved.defaultProvider, "openai-codex");
  assert.equal(saved.defaultModel, "gpt-5.5");
  assert.equal(saved.theme, "light");
  assert.deepEqual(saved.packages, ["keep-this"]);
  assert.equal(app.resets(), 1);
  assert.equal(readFileSync(history, "utf8"), "keep-history\n");
  const reread = await app.request("/api/login");
  assert.equal(reread.body.defaultModel, "gpt-5.5");
});

test("未知/供应商错配/同名模型被拒绝，旧命令的唯一模型名仍可使用", async (t) => {
  const app = await setup(t);
  for (const patch of [{ model: "nonexistent" }, { model: "shared" }, { provider: "zai-coding-cn", model: "gpt-5.5" }, {}]) {
    assert.equal((await app.request("/api/model", patch)).status, 400);
  }
  assert.equal(app.resets(), 0);
  assert.equal(JSON.parse(readFileSync(app.file, "utf8")).defaultModel, "glm-5.3");
  assert.equal((await app.request("/api/model", { model: "gpt-5.5" })).status, 200);
  assert.equal(JSON.parse(readFileSync(app.file, "utf8")).defaultProvider, "openai-codex");
});

test("回复过程中拒绝切模型，不打断当前会话", async (t) => {
  let finish!: () => void, started!: () => void;
  const gate = new Promise<void>((r) => { finish = r; });
  const running = new Promise<void>((r) => { started = r; });
  const app = await setup(t, { chat: async () => { started(); await gate; return "已完成"; } });
  const reply = fetch(app.base + "/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "测试" }) });
  try {
    await running;
    assert.equal((await app.request("/api/model", { provider: "openai-codex", model: "gpt-5.5" })).status, 409);
    assert.equal(app.resets(), 0);
  } finally {
    finish();
    await (await reply).text();
  }
});

test("模型切换等待旧会话关闭，期间不接受新的模型回复", async (t) => {
  let finish!: () => void, started!: () => void;
  const gate = new Promise<void>((r) => { finish = r; });
  const resetting = new Promise<void>((r) => { started = r; });
  const app = await setup(t, { resetChatSessions: async () => { started(); await gate; }, chat: async () => "无需调用模型" });
  const save = app.request("/api/model", { provider: "openai-codex", model: "gpt-5.5" });
  try {
    await resetting;
    assert.equal(JSON.parse(readFileSync(app.file, "utf8")).defaultModel, "glm-5.3", "关闭完成前不修改配置");
    assert.equal((await app.request("/api/chat", { text: "正在切换时的新消息" })).status, 429);
  } finally {
    finish();
    assert.equal((await save).status, 200);
  }
  assert.equal(JSON.parse(readFileSync(app.file, "utf8")).defaultModel, "gpt-5.5");
});

test("会话释放失败时不改默认模型，用户可重试", async (t) => {
  const app = await setup(t, { resetChatSessions: async () => { throw new Error("模拟会话关闭失败"); } });
  assert.equal((await app.request("/api/model", { provider: "openai-codex", model: "gpt-5.5" })).status, 500);
  assert.equal(JSON.parse(readFileSync(app.file, "utf8")).defaultModel, "glm-5.3");
});

test("真实模型目录从指定运行时读取，不依赖个人 Pi 配置", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "yia-model-catalog-"));
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "test-key-not-used-for-network" } }));
  const models = await loadModelCatalog(agentDir);
  assert.ok(models.some((m) => m.provider === "openai"));
  assert.ok(models.every((m) => typeof m.provider === "string" && typeof m.id === "string" && typeof m.name === "string"));
});
