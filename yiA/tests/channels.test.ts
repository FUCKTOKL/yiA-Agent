/**
 * M4 渠道层单测：微信配置加载、ClawbotSender（fake Gateway）、注册表降级、
 * chat-cli 会话映射（防路径注入）
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelRegistry, type ChannelSender } from "../src/channels/registry.ts";
import { ClawbotSender } from "../src/channels/clawbot/sender.ts";
import { loadWechatConfig } from "../src/channels/wechat-config.ts";
import { sessionFileFor } from "../scripts/chat-cli.ts";
import { Logger } from "../src/logger.ts";

const dir = mkdtempSync(join(tmpdir(), "yia-chan-"));
const logger = new Logger(join(dir, "logs"));

// ---- 配置加载 ----
test("wechat.json：缺失/损坏返回 null，合法则往返", () => {
  assert.equal(loadWechatConfig(dir), null, "配置不存在应禁用微信渠道");
  mkdirSync(join(dir, "runtime", "config"), { recursive: true });
  const file = join(dir, "runtime", "config", "wechat.json");
  writeFileSync(file, "{broken");
  assert.equal(loadWechatConfig(dir), null, "损坏应禁用而不崩");
  writeFileSync(
    file,
    JSON.stringify({ enabled: true, gatewayUrl: "http://1.2.3.4:18789", gatewayToken: "t", targetPeer: "me@im.wechat" })
  );
  const cfg = loadWechatConfig(dir)!;
  assert.equal(cfg.gatewayUrl, "http://1.2.3.4:18789");
  assert.equal(cfg.targetPeer, "me@im.wechat");
  assert.equal(cfg.channel, "openclaw-weixin", "缺省渠道名");
});

// ---- ClawbotSender（注入 fake fetch，不开真端口）----
function fakeSender(response: { status: number; body: object }): { sender: ClawbotSender; calls: any[] } {
  const calls: any[] = [];
  const sender = new ClawbotSender(
    { enabled: true, gatewayUrl: "http://gw:18789", gatewayToken: "secret", channel: "openclaw-weixin", account: "bot-1", targetPeer: "me@im.wechat" },
    logger,
    (async (_url: any, init: any) => {
      calls.push({ url: _url, init });
      return new Response(JSON.stringify(response.body), { status: response.status });
    }) as typeof fetch,
  );
  return { sender, calls };
}

test("ClawbotSender：POST /tools/invoke，带 Bearer 与 message 工具参数", async () => {
  const { sender, calls } = fakeSender({ status: 200, body: { ok: true } });
  await sender.send("peer@im.wechat", "开会啦");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://gw:18789/tools/invoke");
  assert.equal(calls[0].init.headers.authorization, "Bearer secret");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.tool, "message");
  assert.equal(body.args.action, "send");
  assert.equal(body.args.channel, "openclaw-weixin");
  assert.equal(body.args.accountId, "bot-1"); // 多账号防歧义：必须带 accountId
  assert.equal(body.args.target, "peer@im.wechat");
  assert.equal(body.args.message, "开会啦");
});

test("ClawbotSender：目标为空时用配置里的 targetPeer", async () => {
  const { sender, calls } = fakeSender({ status: 200, body: { ok: true } });
  await sender.send("", "hi");
  assert.equal(JSON.parse(calls[0].init.body).args.target, "me@im.wechat");
});

test("ClawbotSender：HTTP 500 与业务 ok:false 都抛错（触发降级）", async () => {
  const a = fakeSender({ status: 500, body: { error: "boom" } });
  await assert.rejects(a.sender.send("x@im.wechat", "hi"));
  const b = fakeSender({ status: 200, body: { ok: false, error: "未配对" } });
  await assert.rejects(b.sender.send("x@im.wechat", "hi"));
});

// ---- 注册表降级 ----
test("registry：微信失败自动降级到 TUI，双败才抛错", async () => {
  const reg = new ChannelRegistry(logger);
  const sent: string[] = [];
  const bad: ChannelSender = { send: async () => { throw new Error("gateway down"); }, available: async () => true };
  const good: ChannelSender = { send: async (_to, text) => { sent.push(text); }, available: async () => true };
  reg.register("wechat", bad);
  reg.register("tui", good);
  const used = await reg.send("wechat", "me", "提醒：喝水");
  assert.equal(used, "tui", "应降级到 tui");
  assert.deepEqual(sent, ["提醒：喝水"]);
  // 双败
  const reg2 = new ChannelRegistry(logger);
  reg2.register("wechat", bad);
  reg2.register("tui", { send: async () => { throw new Error("tui down"); }, available: async () => true });
  await assert.rejects(reg2.send("wechat", "me", "x"));
});

// ---- chat-cli 会话映射 ----
test("sessionFileFor：会话 id 消毒，防路径注入", () => {
  const f = sessionFileFor("abc-123", "/root");
  assert.equal(f, join("/root", "runtime", "chats", "abc-123.jsonl"));
  const evil = sessionFileFor("../../.pi/agent/auth", "/root");
  assert.ok(!evil.includes(".."), "路径穿越字符应被清除");
  assert.equal(sessionFileFor("///", "/root"), join("/root", "runtime", "chats", "default.jsonl"));
});

after(() => rmSync(dir, { recursive: true, force: true }));
