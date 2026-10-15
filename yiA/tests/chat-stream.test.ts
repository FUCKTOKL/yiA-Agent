import test from "node:test";
import assert from "node:assert/strict";

const { api } = await import(new URL("../web/js/api.js", import.meta.url).href);
type Event = { event: string; data: Record<string, unknown> };
const frame = (event: string, data: object) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function response(text: string): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
    controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });
}

test("聊天 SSE：分块中文与 CRLF 消息能完整显示", async (t) => {
  const text = "中文回复\n包含 <原样文字>";
  t.mock.method(globalThis, "fetch", async () => response((frame("start", {}) + frame("done", { text })).replaceAll("\n", "\r\n")));
  const events: Event[] = [];
  await api.chat("问题", (event: string, data: Record<string, unknown>) => events.push({ event, data }));
  assert.equal(events.at(-1)?.event, "done");
  assert.equal(events.at(-1)?.data.text, text);
});

test("聊天 SSE：空的成功消息转换成错误，不再出现空白气泡", async (t) => {
  t.mock.method(globalThis, "fetch", async () => response(frame("done", { text: "  " })));
  const events: Event[] = [];
  await api.chat("问题", (event: string, data: Record<string, unknown>) => events.push({ event, data }));
  assert.equal(events.at(-1)?.event, "error");
  assert.match(String(events.at(-1)?.data.error), /没有返回可显示的回复/);
});

test("聊天 SSE：没有完成消息就断开时明确报错", async (t) => {
  t.mock.method(globalThis, "fetch", async () => response(frame("start", {})));
  const events: Event[] = [];
  await api.chat("问题", (event: string, data: Record<string, unknown>) => events.push({ event, data }));
  assert.equal(events.at(-1)?.event, "error");
  assert.match(String(events.at(-1)?.data.error), /连接已中断/);
});

test("聊天 SSE：损坏 JSON 和非对象数据不会让页面停在思考中", async (t) => {
  for (const packet of ['event: done\ndata: {broken\n\n', 'event: done\ndata: null\n\n']) {
    t.mock.method(globalThis, "fetch", async () => response(packet));
    const events: Event[] = [];
    await api.chat("问题", (event: string, data: Record<string, unknown>) => events.push({ event, data }));
    assert.equal(events.at(-1)?.event, "error");
    t.mock.restoreAll();
  }
});

test("聊天 SSE：网络流异常转换为错误", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({ start(controller) {
    controller.error(new Error("模拟网络中断"));
  } })));
  const events: Event[] = [];
  await api.chat("问题", (event: string, data: Record<string, unknown>) => events.push({ event, data }));
  assert.equal(events.at(-1)?.event, "error");
  assert.match(String(events.at(-1)?.data.error), /网络中断/);
});

test("共用 SSE：微信换绑 done 不要求聊天文本，仍能正常完成", async (t) => {
  t.mock.method(globalThis, "fetch", async () => response(frame("done", { account: "test-bot" })));
  const events: Event[] = [];
  await api.sse("/api/wechat/rebind/qr", {}, (event: string, data: Record<string, unknown>) => events.push({ event, data }));
  assert.equal(events.at(-1)?.event, "done");
  assert.equal(events.at(-1)?.data.account, "test-bot");
});
