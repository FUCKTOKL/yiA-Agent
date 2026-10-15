import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAssistantReply, formatReplyError, EMPTY_REPLY_MESSAGE } from "../src/chat/reply.ts";
import { createYiaServer } from "../src/server/server.ts";
import { Logger } from "../src/logger.ts";

const unsupported = "Codex error: The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.";

test("回复提取：保留本轮文字与换行，跳过思考内容", () => {
  const reply = getAssistantReply([
    { role: "user", content: "问题" },
    { role: "assistant", content: [{ type: "thinking", thinking: "不应显示" }, { type: "text", text: "第一段\n第二段" }], stopReason: "stop" },
  ]);
  assert.equal(reply, "第一段\n第二段");
});

test("模型错误：账号不支持型号时明确报错，部分文字也不能冒充成功", () => {
  assert.throws(() => getAssistantReply([
    { role: "assistant", content: [{ type: "text", text: "未完成的回复" }], stopReason: "error", errorMessage: unsupported },
  ]), /ChatGPT 账号不支持模型 gpt-5\.5/);
});

test("空回复/只有思考/本轮没有新回复：不能返回空串或复用上一轮答案", () => {
  for (const content of [[], [{ type: "text", text: " \n " }], [{ type: "thinking", thinking: "思考" }]]) {
    assert.throws(() => getAssistantReply([{ role: "assistant", content }]), { message: EMPTY_REPLY_MESSAGE });
  }
  assert.throws(() => getAssistantReply([
    { role: "assistant", content: [{ type: "text", text: "上一轮答案" }] }, { role: "user", content: "新问题" },
  ]), { message: EMPTY_REPLY_MESSAGE });
});

test("中断与套餐到期都作为失败处理", () => {
  assert.throws(() => getAssistantReply([{ role: "assistant", stopReason: "aborted", content: [] }]), /已中断/);
  assert.throws(() => getAssistantReply([{ role: "assistant", stopReason: "error", errorMessage: "429 GLM Coding Plan 套餐已到期" }]), /套餐已到期/);
});

test("错误展示先隐藏凭据，再限制长度", () => {
  const error = new Error('Authorization: Bearer abc.secret.jwt; api_key="hidden-key", access_token="hidden-access", refresh_token="hidden-refresh", access="hidden-oauth", key="hidden-keyvalue"; sk-sensitivevalue');
  const safe = formatReplyError(error);
  for (const secret of ["abc.secret.jwt", "hidden-key", "hidden-access", "hidden-refresh", "hidden-oauth", "hidden-keyvalue", "sk-sensitivevalue"]) assert.ok(!safe.includes(secret));
  assert.ok(formatReplyError("x".repeat(1000)).length <= 500);
});

async function setup(t: { after(fn: () => Promise<void>): void }) {
  const root = mkdtempSync(join(tmpdir(), "yia-reply-test-"));
  const server = createYiaServer({ root, logger: new Logger(join(root, "logs")), chat: async (text) => {
    if (text === "empty") return "   ";
    if (text === "unsupported") return getAssistantReply([{ role: "assistant", content: [], stopReason: "error", errorMessage: unsupported }]);
    return "正常回复";
  } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r, reject) => server.close((e) => e ? reject(e) : r())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const chat = async (text: string) => (await fetch(base + "/api/chat", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }),
  })).text();
  return { root, base, chat };
}

test("真实 HTTP/SSE：错误、空返回不发 done，失败后能继续发消息", async (t) => {
  const app = await setup(t);
  for (const prompt of ["empty", "unsupported"]) {
    const stream = await app.chat(prompt);
    assert.match(stream, /event: error/);
    assert.doesNotMatch(stream, /event: done/);
    assert.match(stream, prompt === "empty" ? /没有返回可显示的回复/ : /ChatGPT 账号不支持/);
  }
  assert.match(await app.chat("hello"), /event: done/);
});

test("历史中失败的模型回复，刷新后仍能读到明确原因", async (t) => {
  const app = await setup(t);
  const dir = join(app.root, "runtime", "chats");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "failed.jsonl"), JSON.stringify({ type: "message", message: {
    role: "assistant", content: [], errorMessage: unsupported, stopReason: "error",
  } }) + "\n");
  const { msgs } = await (await fetch(app.base + "/api/chat/history?session=failed")).json();
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].error, true);
  assert.match(msgs[0].text, /ChatGPT 账号不支持模型/);
});
