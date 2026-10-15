import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendWechatReminder } from "../scripts/scheduler-daemon.ts";
import { JobStore } from "../src/scheduler/job-store.ts";
import { ReminderRunner } from "../src/scheduler/runner.ts";
import { Logger } from "../src/logger.ts";

test("守护真实发送链：缺配置、禁用、HTTP/业务失败都保留任务，恢复后只完成一次", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "yia-delivery-"));
  const logger = new Logger(join(root, "logs"));
  const store = new JobStore(join(root, "jobs.json"), join(root, "runs.jsonl"));
  const job = store.add({ title: "测试提醒", at: new Date(Date.now() - 1000).toISOString(), channel: "wechat" });
  const runner = new ReminderRunner(store, (_job, text) => sendWechatReminder(root, text, logger), logger);
  assert.equal((await runner.check()).length, 0);
  assert.equal(store.byId(job.id)!.status, "pending", "没有推送通道不算完成");

  let status = 500, ok = false, calls = 0;
  const accounts: string[] = [];
  const gateway = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    accounts.push(JSON.parse(raw).args.accountId);
    calls++;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok, error: ok ? undefined : "模拟推送失败" }));
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => gateway.close((e) => e ? reject(e) : resolve())));
  const address = gateway.address();
  assert.ok(address && typeof address !== "string");
  mkdirSync(join(root, "runtime", "config"), { recursive: true });
  const config = {
    enabled: false, gatewayUrl: `http://127.0.0.1:${address.port}`, gatewayToken: "test-only",
    targetPeer: "test@im.wechat", account: "old-bot",
  };
  const saveConfig = () => writeFileSync(join(root, "runtime", "config", "wechat.json"), JSON.stringify(config));
  saveConfig();
  assert.equal((await runner.check()).length, 0);
  assert.equal(calls, 0, "停用时不发送");
  config.enabled = true;
  saveConfig();
  assert.equal((await runner.check()).length, 0, "HTTP 失败");
  assert.equal(store.byId(job.id)!.status, "pending");
  status = 200;
  assert.equal((await runner.check()).length, 0, "HTTP 200 但业务拒绝");
  assert.equal(store.byId(job.id)!.status, "pending");
  ok = true;
  config.account = "new-bot";
  saveConfig();
  assert.equal((await runner.check()).length, 1);
  assert.equal(store.byId(job.id)!.status, "done");
  assert.equal(accounts.at(-1), "new-bot", "恢复时读取最新推送配置");
  assert.equal((await runner.check()).length, 0, "成功后不再重复发送");
  assert.equal(calls, 3);
});
