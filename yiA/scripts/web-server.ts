/**
 * yiA Web 服务器（M6.1）：给 web/ 前端补上 REST + SSE 后端。
 * 修复"前端按钮点不动"的根因——此前只有静态原型，无 API。
 *
 * 设计（ponytail）：
 * - node stdlib http，零新依赖；仅监听 127.0.0.1（个人助理，本机使用，不做鉴权）
 * - 数据层全复用（L2Store/JobStore/ClawbotSender/loadWechatConfig）
 * - 对话复用 chat-cli 的会话机制（runtime/chats/web.jsonl 连续）
 * - SSE：start → done/error（prompt 完成后一次性给全文，流式增量 M6.2 再说）
 *
 * 启动：npm run web（或 node --experimental-strip-types yiA/scripts/web-server.ts）
 */
import http from "node:http";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, resolve } from "node:path";
import net from "node:net";
import { homedir } from "node:os";
import { L2Store } from "../src/memory/l2/store.ts";
import { L1Store } from "../src/memory/l1/profile.ts";
import { L3Store } from "../src/memory/l3/sqlite-store.ts";
import { JobStore } from "../src/scheduler/job-store.ts";
import { ClawbotSender } from "../src/channels/clawbot/sender.ts";
import { loadWechatConfig } from "../src/channels/wechat-config.ts";
import { runCapture, logoutAllWeixinAccounts, bindCurrentAccount, validWechatPeer } from "../src/channels/weixin-ops.ts";
import { execFileSync, spawn } from "node:child_process";
import { sessionFileFor } from "./chat-cli.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const AGENT_DIR = join(ROOT, "runtime", "agent");
const WEB_DIR = join(ROOT, "yiA", "web");
const PORT = Number(process.env.YIA_WEB_PORT ?? 3777);
const WEB_SESSION = "web";

// 数据层单例（与 daemon/扩展共用同一份 runtime 数据）
const l2 = new L2Store(ROOT);
const l1 = new L1Store(join(ROOT, "runtime", "l1", "profile.json"));
const l3 = new L3Store(join(ROOT, "runtime", "l3", "index.db"), L3Store.sessionsDirFor(ROOT, join(homedir(), ".pi", "agent")));
const jobs = new JobStore(join(ROOT, "runtime/scheduler/jobs.json"), join(ROOT, "runtime/scheduler/runs.jsonl"));
const wcfg = loadWechatConfig(ROOT);
const wechat = wcfg ? new ClawbotSender(wcfg, { info: () => {}, error: () => {}, warn: () => {} } as any) : null;

/** 对话互斥：同一时刻只跑一条（agent 会话非并发安全，M6.1 够用） */
let chatBusy = false;

// ---------- 工具 ----------
function json(res: http.ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}
function fail(res: http.ServerResponse, error: string, status = 400): void {
  json(res, { error }, status);
}
function sse(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** TCP 探活 Gateway（比起子进程跑 openclaw gateway status 快一个量级） */
function probeGateway(urlStr: string): Promise<string> {
  return new Promise((resolve) => {
    try {
      const u = new URL(urlStr);
      const s = net.connect({ host: u.hostname, port: Number(u.port || 80) }, () => { s.destroy(); resolve("online"); });
      s.setTimeout(1500, () => { s.destroy(); resolve("offline"); });
      s.on("error", () => resolve("offline"));
    } catch { resolve("offline"); }
  });
}

/** daemon 探活：Linux 查 systemd；Windows 看 runs.jsonl 近 5 分钟有无活动 */
function daemonState(): string {
  if (process.platform === "win32") {
    try {
      const st = statSync(join(ROOT, "runtime/scheduler/runs.jsonl"));
      return Date.now() - st.mtimeMs < 5 * 60_000 ? "online" : "offline";
    } catch { return "offline"; }
  }
  try {
    return execFileSync("systemctl", ["--user", "is-active", "yia-scheduler"], { timeout: 3000 }).toString().trim() === "active" ? "online" : "offline";
  } catch { return "offline"; }
}

/** 会话历史 → 前端格式 [{who, text, t}]（可指定 session，缺省 web） */
function chatHistory(sessionId = "web"): { who: string; text: string; t: string }[] {
  const file = sessionFileFor(sessionId, ROOT);
  if (!existsSync(file)) return [];
  const out: { who: string; text: string; t: string }[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line);
      if (d.type !== "message" || !d.message) continue;
      const role = d.message.role;
      if (role !== "user" && role !== "assistant") continue;
      const text = (Array.isArray(d.message.content) ? d.message.content : [])
        .filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
      if (text) out.push({ who: role === "user" ? "user" : "ai", text, t: d.timestamp ?? "" });
    } catch { /* 跳过坏行 */ }
  }
  return out.slice(-50);
}

// ---------- API 处理 ----------
async function handleApi(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const u = new URL(req.url ?? "/", "http://localhost");
  const path = u.pathname;
  const method = req.method ?? "GET";

  // ---- 状态 ----
  if (path === "/api/status" && method === "GET") {
    return json(res, {
      daemon: daemonState(),
      gateway: wcfg ? await probeGateway(wcfg.gatewayUrl) : "offline",
      memCount: l2.all().length,
      pendingRems: jobs.pending().length,
    });
  }

  // ---- ContextPack（前端契约：结构化字段 now/profile/recent/reminders，非拼接文本） ----
  if (path === "/api/context" && method === "GET") {
    const prof = l1.read();
    return json(res, {
      now: new Date().toLocaleString("zh-CN", { hour12: false }),
      profile: Object.fromEntries(["identity", "preferences", "ongoing", "facts"].map((k) => [k, (prof as any)[k] ?? []])),
      recent: l2.all().slice(-5).reverse().map((e) => ({ id: e.id, title: e.title })),
      reminders: jobs.pending().map((j) => ({ id: j.id, at: j.at, title: j.title, channel: j.channel })),
    });
  }

  // ---- 记忆（前端契约：{ entries: [...] }，字段 created 对齐前端 yaml 展示） ----
  if (path === "/api/memory" && method === "GET") {
    const q = u.searchParams.get("q")?.trim() ?? "";
    // search 返回平铺的 {…条目字段, score, coverage}，与 all() 同构，直接用
    const hits: any[] = q ? l2.search(q, 20) : l2.all();
    const entries = hits.map((e: any) => ({ id: e.id, title: e.title, content: e.content, tags: e.tags, links: e.links, created: e.createdAt ?? `${e.id.slice(0, 8)} ${e.id.slice(8, 14)}` }));
    return json(res, { entries });
  }
  let m = path.match(/^\/api\/memory\/([\w-]+)$/);
  if (m && method === "POST") {
    const patch = await readBody(req);
    const entry = l2.refine(m[1], patch);
    return entry ? json(res, { ok: true, entry }) : fail(res, "条目不存在", 404);
  }
  if (m && method === "DELETE") {
    return json(res, { ok: l2.delete(m[1]) });
  }

  // ---- 提醒 ----
  if (path === "/api/reminders" && method === "GET") {
    const all = jobs.all();
    return json(res, {
      pending: all.filter((j) => j.status === "pending"),
      done: all.filter((j) => j.status !== "pending").slice(-20).reverse(),
    });
  }
  if (path === "/api/reminders" && method === "POST") {
    const p = await readBody(req);
    if (!p.title || !p.at) return fail(res, "title 和 at 必填");
    if (new Date(p.at).getTime() <= Date.now()) return fail(res, "at 必须是未来时间");
    const job = jobs.add({ title: String(p.title), at: String(p.at), channel: p.channel === "wechat" ? "wechat" : "tui" });
    return json(res, { ok: true, job });
  }
  m = path.match(/^\/api\/reminders\/([\w-]+)$/);
  if (m && method === "DELETE") {
    return json(res, { ok: jobs.cancel(m[1]) });
  }

  // ---- 微信 ----
  if (path === "/api/wechat" && method === "GET") {
    return json(res, {
      enabled: !!wcfg?.enabled,
      account: wcfg?.account ?? "",
      gateway: wcfg ? await probeGateway(wcfg.gatewayUrl) : "offline",
      targetPeer: wcfg?.targetPeer ?? "",
      tokenConfigured: !!wcfg?.gatewayToken,
    });
  }
  if (path === "/api/wechat/test" && method === "POST") {
    if (!wechat) return fail(res, "未配置微信（runtime/config/wechat.json）");
    try {
      await wechat.send("", "yiA Web 测试推送 ✅");
      return json(res, { ok: true });
    } catch (e) { return fail(res, `推送失败：${String(e).slice(0, 200)}`, 502); }
  }

  // ---- 换绑向导（Web 版 /wechat）：分步接口，前端驱动 ----
  if (path === "/api/wechat/rebind/logout" && method === "POST") {
    const moved = await logoutAllWeixinAccounts();
    return json(res, { ok: true, moved });
  }
  if (path === "/api/wechat/rebind/qr" && method === "POST") {
    // SSE：扫码登录，流式转发终端二维码（qrcode-terminal 输出的 ASCII 块）
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    sse(res, "start", {});
    const p = spawn("openclaw", ["channels", "login", "--channel", "openclaw-weixin"], { env: process.env });
    let buf = "";
    p.stdout.on("data", (d: Buffer) => {
      buf = (buf + d.toString()).split("\n").slice(-40).join("\n"); // 只保留末尾帧（QR 会刷新）
      sse(res, "qr", { text: buf });
    });
    p.stderr.on("data", (d: Buffer) => sse(res, "qr", { text: d.toString().slice(-800) }));
    p.on("close", async (code: number | null) => {
      if (code === 0) {
        const account = await bindCurrentAccount(join(ROOT, "runtime/config/wechat.json"));
        sse(res, "done", { account });
      } else {
        sse(res, "error", { error: `登录进程退出（码 ${code}）` });
      }
      res.end();
    });
    p.on("error", (e: Error) => { sse(res, "error", { error: String(e) }); res.end(); });
    return;
  }
  if (path === "/api/wechat/rebind/pairing" && method === "GET") {
    const r = await runCapture("openclaw", ["pairing", "list", "openclaw-weixin"]);
    return json(res, { text: r.out.trim() });
  }
  if (path === "/api/wechat/rebind/approve" && method === "POST") {
    const { code } = await readBody(req);
    if (!code?.trim()) return fail(res, "code 必填");
    const r = await runCapture("openclaw", ["pairing", "approve", "openclaw-weixin", String(code).trim()]);
    return json(res, { ok: r.code === 0, text: r.out.trim() });
  }
  if (path === "/api/wechat/rebind/target" && method === "POST") {
    const { peer } = await readBody(req);
    if (!peer || !validWechatPeer(String(peer))) return fail(res, "微信 id 格式不对（应为 o…@im.wechat，可从配对列表或网关日志获取）");
    const file = join(ROOT, "runtime/config/wechat.json");
    const cfg = JSON.parse(readFileSync(file, "utf8"));
    cfg.targetPeer = String(peer).trim();
    writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", "utf8");
    return json(res, { ok: true });
  }
  if (path === "/api/wechat/rebind/restart" && method === "POST") {
    const { gatewayCtl } = await import("../src/channels/weixin-ops.ts");
    await gatewayCtl("restart");
    return json(res, { ok: true });
  }

  // ---- 会话列表（对话页右岛）：runtime/chats/*.jsonl，标题取首条用户消息 ----
  if (path === "/api/sessions" && method === "GET") {
    const dir = join(ROOT, "runtime/chats");
    const out: { id: string; title: string; count: number; lastTs: string; src: string }[] = [];
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".jsonl")) continue;
        const id = f.replace(".jsonl", "");
        let title = "", count = 0, lastTs = "";
        for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
          if (!line.trim()) continue;
          try {
            const d = JSON.parse(line);
            if (d.timestamp) lastTs = d.timestamp;
            if (d.type !== "message" || d.message?.role !== "user") continue;
            const text = (Array.isArray(d.message.content) ? d.message.content : [])
              .filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
            // 去掉微信通道注入的 ContextPack 噪声头，取真实用户语句
            const clean = text.replace(/Conversation info:[\s\S]*?```\n/, "").replace(/^⟦[^⟧]*⟧\s*/, "").replace(/^\[[\w :,+GMT-]*\]\s*/, "").replace(/[\n\r]/g, " ").trim();
            count++;
            if (!title && clean) title = clean.slice(0, 26);
          } catch { /* 坏行跳过 */ }
        }
        out.push({ id, title: title || "（无标题）", count, lastTs, src: id === "web" || id.startsWith("web-") ? "web" : "wechat" });
      }
    }
    out.sort((a, b) => (a.lastTs < b.lastTs ? 1 : -1));
    return json(res, { sessions: out });
  }

  // ---- 对话（SSE，可指定 session；缺省 web） ----
  if (path === "/api/chat" && method === "POST") {
    const { text, session } = await readBody(req);
    if (!text?.trim()) return fail(res, "text 必填");
    if (chatBusy) return fail(res, "上一条还在处理中", 429);
    chatBusy = true;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    sse(res, "start", {});
    try {
      // 与 chat-cli 相同机制：会话文件连续复用
      const sessionId = typeof session === "string" && /^[\w-]{1,64}$/.test(session) ? session : "web";
      const file = sessionFileFor(sessionId, ROOT);
      const reused = existsSync(file);
      const sessionManager = reused ? SessionManager.open(file) : SessionManager.create(ROOT);
      const { session } = await createAgentSession({ cwd: ROOT, agentDir: AGENT_DIR, sessionManager });
      await session.prompt(String(text));
      if (!reused && session.sessionFile) {
        mkdirSync(dirname(file), { recursive: true });
        copyFileSync(session.sessionFile, file);
      }
      const msgs = session.agent.state.messages;
      const last = [...msgs].reverse().find((x) => x.role === "assistant");
      const reply = last && Array.isArray((last as any).content)
        ? (last as any).content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("")
        : "";
      sse(res, "done", { text: reply || "（无回复）" });
    } catch (e) {
      sse(res, "error", { error: String(e).slice(0, 300) });
    } finally {
      chatBusy = false;
      res.end();
    }
    return;
  }

  if (path === "/api/chat/history" && method === "GET") {
    const sid = u.searchParams.get("session");
    const sessionId = sid && /^[\w-]{1,64}$/.test(sid) ? sid : "web";
    return json(res, { msgs: chatHistory(sessionId) });
  }

  fail(res, "未知接口", 404);
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

// ---------- 静态文件 ----------
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
};
function serveStatic(path: string, res: http.ServerResponse): boolean {
  const rel = path === "/" ? "index.html" : path.slice(1).replace(/\.\./g, ""); // 防目录穿越
  const file = join(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR) || !existsSync(file)) return false;
  res.writeHead(200, { "content-type": MIME[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream" });
  res.end(readFileSync(file));
  return true;
}

// ---------- 主机 ----------
const server = http.createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://localhost");
  if (u.pathname.startsWith("/api/")) {
    handleApi(req, res).catch((e) => { try { fail(res, String(e).slice(0, 200), 500); } catch { /* 已写头 */ } });
    return;
  }
  if (!serveStatic(u.pathname, res)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("404");
  }
});
const isEntry = (() => {
  try { return resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url); } catch { return false; }
})();

if (isEntry) {
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`yiA Web 已启动：http://127.0.0.1:${PORT}（仅本机可访问；Ctrl+C 停止）`);
  });
}
