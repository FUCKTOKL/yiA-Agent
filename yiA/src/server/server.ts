/**
 * yiA Web 服务器（M6）：零依赖 HTTP + SSE，把 runtime/ 的能力暴露给 web 前端。
 *
 * 设计约束（AGENTS.md）：
 * - 只绑 127.0.0.1（个人工具，无鉴权；不要暴露到局域网）
 * - 复用既有模块：L2Store / JobStore / ClawbotSender / chat 无头会话（chat-cli 同款）
 * - 工厂模式：createYiaServer() 只建不启，入口在 scripts/web-server.ts（单测可注入临时 root）
 * - 错误处理：所有 handler 异常捕获后返回 500 + 错误文本（不吞错，前端等宽原样展示）
 *
 * API（全部 JSON / SSE）：
 *   GET  /api/status            → { memCount, pendingRems, daemon, gateway }
 *   GET  /api/context           → ContextPack 摘要（对话页折叠条）
 *   GET  /api/memory?q=         → { entries: [...], }（q 空则全部，含 links/tags 供图谱）
 *   POST /api/memory/:id        → refine { title?, content?, tags? }
 *   DELETE /api/memory/:id      → 删除（清反向引用）
 *   GET  /api/reminders         → jobs（pending 在前 + 近期已触发）
 *   POST /api/reminders         → { title, at(ISO), channel, repeatDays? }
 *   DELETE /api/reminders/:id   → cancel
 *   GET  /api/wechat            → 通道状态（token 脱敏）
 *   POST /api/wechat/test       → 发测试消息
 *   GET  /api/chat/history      → web 会话最近消息
 *   POST /api/chat              → SSE：event: start → event: done(全文)
 *   /*                          → 静态文件 yiA/web/
 */
import { createServer, type Server } from "node:http";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import net from "node:net";

import { L2Store } from "../memory/l2/store.ts";
import { JobStore } from "../scheduler/job-store.ts";
import { L1Store } from "../memory/l1/profile.ts";
import { loadWechatConfig, type WechatConfig } from "../channels/wechat-config.ts";
import { ClawbotSender } from "../channels/clawbot/sender.ts";
import { Logger } from "../logger.ts";

export interface YiaServerDeps {
  root: string;
  logger: Logger;
  /** 依赖注入（单测用假实现）；缺省用真实 chat 会话工厂 */
  chat?: (text: string) => Promise<string>;
  agentDir?: string;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

/** 网关端口探活（TCP 连一下就走，不发请求） */
function probeTcp(host: string, port: number, ms = 800): Promise<boolean> {
  return new Promise((r) => {
    const s = net.connect({ host, port });
    const t = setTimeout(() => { s.destroy(); r(false); }, ms);
    s.on("connect", () => { clearTimeout(t); s.destroy(); r(true); });
    s.on("error", () => { clearTimeout(t); r(false); });
  });
}

/** 调度守护状态：Linux 走 systemctl；其他平台/失败返回 unknown（不阻塞页面） */
function daemonStatus(): string {
  try {
    const out = execFileSync("systemctl", ["--user", "is-active", "yia-scheduler"], { timeout: 3000 }).toString().trim();
    return out === "active" ? "online" : out;
  } catch {
    return "unknown";
  }
}

export function createYiaServer(deps: YiaServerDeps): Server {
  const { root, logger } = deps;
  const l2 = new L2Store(root);
  const jobs = new JobStore(
    join(root, "runtime", "scheduler", "jobs.json"),
    join(root, "runtime", "scheduler", "runs.jsonl"),
  );
  const l1 = new L1Store(join(root, "runtime", "profile.json"));
  const wcfg: WechatConfig | null = loadWechatConfig(root);
  const wechat = wcfg ? new ClawbotSender(wcfg, logger) : null;
  const webDir = resolve(root, "yiA", "web");

  const json = (res: any, code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };
  const body = (req: any): Promise<any> =>
    new Promise((r) => { let b = ""; req.on("data", (c: Buffer) => (b += c)); req.on("end", () => { try { r(b ? JSON.parse(b) : {}); } catch { r(null); } }); });

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = decodeURIComponent(url.pathname);
    try {
      // ── API ──
      if (path.startsWith("/api/")) {
        // L2 索引刷新：对话/微信等其他进程会写条目，长驻服务器的内存索引需重读
        // ponytail: 每请求重读整目录，万条内可接受；上万条换 fs.watch 增量
        if (path.startsWith("/api/memory") || path === "/api/status" || path === "/api/context") l2.reload();
        if (path === "/api/status" && req.method === "GET") {
          const gw = wcfg ? await probeTcp(new URL(wcfg.gatewayUrl).hostname, Number(new URL(wcfg.gatewayUrl).port || 80)) : false;
          return json(res, 200, {
            memCount: l2.all().length,
            pendingRems: jobs.pending().length,
            daemon: daemonStatus(),
            gateway: gw ? "online" : "offline",
          });
        }

        if (path === "/api/context" && req.method === "GET") {
          const p = l1.read();
          const rems = jobs.pending().slice(0, 5).map((j) => ({ at: j.at, title: j.title, channel: j.channel }));
          const recent = l2.all().slice(0, 3).map((e) => ({ id: e.id, title: e.title }));
          return json(res, 200, {
            now: new Date().toLocaleString("zh-CN", { hour12: false }),
            profile: p,
            recent,
            reminders: rems,
          });
        }

        if (path === "/api/memory" && req.method === "GET") {
          const q = url.searchParams.get("q")?.trim() ?? "";
          // search 返回的即是展平条目（含 score 字段，前端不敏感）；无 q 时全量
          const entries = q ? l2.search(q, 50) : l2.all();
          return json(res, 200, { entries });
        }
        let m = path.match(/^\/api\/memory\/([\w-]+)$/);
        if (m) {
          if (req.method === "DELETE") {
            const ok = l2.delete(m[1]);
            return ok ? json(res, 200, { ok: true }) : json(res, 404, { error: `条目不存在：${m[1]}` });
          }
          if (req.method === "POST") {
            const patch = await body(req);
            const e = l2.refine(m[1], patch);
            return e ? json(res, 200, { entry: e }) : json(res, 404, { error: `条目不存在：${m[1]}` });
          }
        }

        if (path === "/api/reminders" && req.method === "GET") {
          const all = jobs.all();
          const pending = all.filter((j) => j.status === "pending").sort((a, b) => a.at.localeCompare(b.at));
          const done = all.filter((j) => j.status !== "pending").slice(-20).reverse();
          return json(res, 200, { pending, done });
        }
        if (path === "/api/reminders" && req.method === "POST") {
          const p = await body(req);
          if (!p?.title || !p?.at) return json(res, 400, { error: "需要 title 和 at（ISO 8601）" });
          if (new Date(p.at).getTime() <= Date.now()) return json(res, 400, { error: `at 必须是未来时间：${p.at}` });
          const job = jobs.add({ title: String(p.title), at: String(p.at), channel: p.channel === "tui" ? "tui" : "wechat", ...((p.repeatDays ?? 0) > 0 ? { repeatDays: Number(p.repeatDays) } : {}) });
          return json(res, 200, { job });
        }
        m = path.match(/^\/api\/reminders\/([\w-]+)$/);
        if (m && req.method === "DELETE") {
          const ok = jobs.cancel(m[1]);
          return ok ? json(res, 200, { ok: true }) : json(res, 404, { error: `任务不存在或已完成：${m[1]}` });
        }

        if (path === "/api/wechat" && req.method === "GET") {
          if (!wcfg) return json(res, 200, { enabled: false });
          const gw = await probeTcp(new URL(wcfg.gatewayUrl).hostname, Number(new URL(wcfg.gatewayUrl).port || 80));
          return json(res, 200, {
            enabled: wcfg.enabled,
            gateway: gw ? "online" : "offline",
            account: wcfg.account ?? null,
            targetPeer: wcfg.targetPeer,
            // ponytail: token 永不出网，只给"已配置/未配置"
            tokenConfigured: !!wcfg.gatewayToken,
          });
        }
        if (path === "/api/wechat/test" && req.method === "POST") {
          if (!wechat) return json(res, 400, { error: "微信未配置（runtime/config/wechat.json）" });
          await wechat.send("", "yiA Web 测试消息 ✅（Web UI 通道自检）");
          return json(res, 200, { ok: true, at: new Date().toISOString() });
        }

        if (path === "/api/chat/history" && req.method === "GET") {
          const file = join(root, "runtime", "chats", "web.jsonl");
          const msgs: { who: string; text: string; t: string }[] = [];
          if (existsSync(file)) {
            for (const line of readFileSync(file, "utf8").split("\n")) {
              if (!line.trim()) continue;
              try { msgs.push(JSON.parse(line)); } catch { /* 跳过损坏行 */ }
            }
          }
          return json(res, 200, { msgs: msgs.slice(-40) });
        }
        if (path === "/api/chat" && req.method === "POST") {
          const { text } = await body(req);
          if (!text) return json(res, 400, { error: "text 不能为空" });
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
          res.write(`event: start\ndata: ${JSON.stringify({ ok: true })}\n\n`);
          try {
            const reply = deps.chat
              ? await deps.chat(text)
              : await (await import("../chat/session.ts")).webChat(text, root, deps.agentDir ?? join(root, "runtime", "agent"), logger);
            res.write(`event: done\ndata: ${JSON.stringify({ text: reply })}\n\n`);
          } catch (e) {
            // 错误原样推给前端（产品理念：不吞错）
            res.write(`event: error\ndata: ${JSON.stringify({ error: String(e).slice(0, 500) })}\n\n`);
          }
          return res.end();
        }

        return json(res, 404, { error: `未知 API：${req.method} ${path}` });
      }

      // ── 静态文件（yiA/web/，目录穿越防护）──
      let file = join(webDir, path === "/" ? "index.html" : path);
      if (!resolve(file).startsWith(webDir)) { res.writeHead(403); return res.end("forbidden"); }
      if (!existsSync(file) || extname(file) === "") file = join(webDir, "index.html"); // SPA 回退
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
      createReadStream(file).pipe(res);
    } catch (e) {
      logger.error("web 请求处理失败", { path, error: String(e).slice(0, 300) });
      if (!res.headersSent) json(res, 500, { error: String(e).slice(0, 500) });
      else res.end();
    }
  });
}
