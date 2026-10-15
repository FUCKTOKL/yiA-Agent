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
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { extname, join, resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import net from "node:net";

import { L2Store, MemoryConflictError } from "../memory/l2/store.ts";
import { JobStore } from "../scheduler/job-store.ts";
import { L1Store } from "../memory/l1/profile.ts";
import { loadWechatConfig, type WechatConfig } from "../channels/wechat-config.ts";
import { ClawbotSender } from "../channels/clawbot/sender.ts";
import { runCapture, logoutAllWeixinAccounts, bindCurrentAccount, validWechatPeer, gatewayCtl } from "../channels/weixin-ops.ts";
import { Logger } from "../logger.ts";
import { loadModelCatalog, type ModelChoice } from "./model-catalog.ts";
import { EMPTY_REPLY_MESSAGE, formatReplyError } from "../chat/reply.ts";
import { createBookRoutes } from "./book-routes.ts";

export interface YiaServerDeps {
  root: string;
  logger: Logger;
  /** 依赖注入（单测用假实现）；缺省用真实 chat 会话工厂 */
  chat?: (text: string) => Promise<string>;
  agentDir?: string;
  modelCatalog?: () => Promise<ModelChoice[]>;
  resetChatSessions?: () => Promise<void>;
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
  const l1 = new L1Store(join(root, "runtime", "l1", "profile.json")); // 注意：实际路径在 l1/ 子目录
  const wcfg: WechatConfig | null = loadWechatConfig(root);
  const wechat = wcfg ? new ClawbotSender(wcfg, logger) : null;
  const webDir = resolve(root, "yiA", "web");
  const agentDir = deps.agentDir ?? join(root, "runtime", "agent");
  const modelCatalog = deps.modelCatalog ?? (() => loadModelCatalog(agentDir));
  const bookRoutes = createBookRoutes(root, logger);

  const json = (res: any, code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };
  const body = (req: any): Promise<any> =>
    new Promise((r) => { let b = ""; req.on("data", (c: Buffer) => (b += c)); req.on("end", () => { try { r(b ? JSON.parse(b) : {}); } catch { r(null); } }); });
  const sse = (res: any, event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  /** 同一时刻只跑一条对话（agent 会话非并发安全） */
  let chatBusy = false;

  /** pi 会话 jsonl → 前端格式 [{who,text,t}]（多会话共用） */
  const historyOf = (sid: string): { who: string; text: string; t: string; error?: boolean }[] => {
    const file = join(root, "runtime", "chats", `${sid}.jsonl`);
    const out: { who: string; text: string; t: string; error?: boolean }[] = [];
    if (!existsSync(file)) return out;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        if (d.type !== "message" || !d.message) continue;
        const role = d.message.role;
        if (role !== "user" && role !== "assistant") continue;
        const text = (Array.isArray(d.message.content) ? d.message.content : [])
          .filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
        const failed = role === "assistant" && (d.message.errorMessage || d.message.stopReason === "error" || d.message.stopReason === "aborted");
        if (failed) out.push({ who: "ai", text: formatReplyError(d.message.errorMessage || (d.message.stopReason === "aborted" ? "这次回复已中断，请重新发送。" : EMPTY_REPLY_MESSAGE)), t: d.timestamp ?? "", error: true });
        else if (text) out.push({ who: role === "user" ? "user" : "ai", text, t: d.timestamp ?? "" });
      } catch { /* 跳过损坏行 */ }
    }
    return out.slice(-40);
  };

  const server = createServer(async (req, res) => {
    let path = "/";
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      path = decodeURIComponent(url.pathname);
      // ── API ──
      if (path.startsWith("/api/")) {
        if (path === "/api/books" || path.startsWith("/api/books/")) return await bookRoutes.handle(req, res, url);
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
          // search 返回的即是展平条目（含 score 字段，前端不敏感）；无 q 时全量；
          // created 从 id 时间戳兑底（search 的 Doc 不带 createdAt，前端 yaml 展示用）
          const raw: any[] = q ? l2.search(q, 50) : l2.all();
          const entries = raw.map((e) => ({ ...e, created: e.createdAt ?? `${e.id.slice(0, 8)} ${e.id.slice(8, 14)}` }));
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
            if (typeof patch?.expectedVersion !== "string") return json(res, 400, { error: "请刷新页面，重新打开记忆后再保存。" });
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

        // ── 换绑向导（Web 版 /wechat，与 TUI 同一套 weixin-ops）──
        if (path === "/api/wechat/rebind/logout" && req.method === "POST") {
          const moved = await logoutAllWeixinAccounts();
          return json(res, 200, { ok: true, moved });
        }
        if (path === "/api/wechat/rebind/qr" && req.method === "POST") {
          // SSE：扫码登录，流式转发二维码。终端 QR 带 ANSI 转义码且与日志行交织，
          // 直接透传会“格式崩溃”——剥转义 + 只保留最后一个连续 QR 块（█▀▄ 组成）
          const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
          /** 半块字符 QR → 模块矩阵 → SVG（矩形横向合并）。
           *  字符渲染在浏览器里列宽不一致（空格与 █▀▄ 回退字体不同）致码畸变扫不出，
           *  SVG 每模块正方形像素级精确，与字体无关。▀=上半黑 ▄=下半黑 █=全黑 */
          const qrToSvg = (block: string): string | null => {
            const lines = block.split("\n").map((l) => l.replace(/\s+$/, ""));
            if (lines.length < 4) return null;
            const w = Math.max(...lines.map((l) => l.length));
            const rows: boolean[][] = [];
            for (const l of lines) {
              const top: boolean[] = [], bot: boolean[] = [];
              for (let x = 0; x < w; x++) {
                const c = l[x] ?? " ";
                top.push(c === "▀" || c === "█");
                bot.push(c === "▄" || c === "█");
              }
              rows.push(top, bot);
            }
            const h = rows.length, s = 4, quiet = 4; // 每模块 4px，静区 4 模块（QR 规范）
            let rects = "";
            for (let y = 0; y < h; y++) {
              let x = 0;
              while (x < w) {
                if (rows[y][x]) {
                  let x2 = x; while (x2 + 1 < w && rows[y][x2 + 1]) x2++;
                  rects += `<rect x="${(x + quiet) * s}" y="${(y + quiet) * s}" width="${(x2 - x + 1) * s}" height="${s}"/>`;
                  x = x2 + 1;
                } else x++;
              }
            }
            const W = (w + quiet * 2) * s, H = (h + quiet * 2) * s;
            return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="240" style="background:#fff;display:block"><g fill="#000">${rects}</g></svg>`;
          };
          const extractQr = (text: string): string => {
            const lines = stripAnsi(text).split("\n").map((l) => l.replace(/\s+$/, ""));
            const isQr = (l: string) => l.length > 10 && /^[█▀▄ ]+$/.test(l);
            let best: string[] = [], cur: string[] = [];
            for (const l of lines) {
              if (isQr(l)) cur.push(l);
              else { if (cur.length > best.length) best = cur; cur = []; }
            }
            if (cur.length > best.length) best = cur;
            return best.length >= 4 ? best.join("\n") : lines.slice(-8).join("\n"); // 没码时给末尾状态行
          };
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
          sse(res, "start", {});
          const p = spawn("openclaw", ["channels", "login", "--channel", "openclaw-weixin"], { env: process.env });
          let raw = "";
          const push = () => {
            const text = extractQr(raw);
            const svg = qrToSvg(text);
            sse(res, "qr", svg ? { svg, text } : { text });
          };
          p.stdout.on("data", (d: Buffer) => { raw = (raw + d.toString()).slice(-20000); push(); });
          p.stderr.on("data", (d: Buffer) => { raw = (raw + d.toString()).slice(-20000); push(); });
          p.on("close", async (code: number | null) => {
            if (code === 0) {
              const account = await bindCurrentAccount(join(root, "runtime/config/wechat.json"));
              sse(res, "done", { account });
            } else {
              sse(res, "error", { error: `登录进程退出（码 ${code}）` });
            }
            res.end();
          });
          p.on("error", (e: Error) => { sse(res, "error", { error: String(e) }); res.end(); });
          return;
        }
        if (path === "/api/wechat/rebind/pairing" && req.method === "GET") {
          const r = await runCapture("openclaw", ["pairing", "list", "openclaw-weixin"]);
          return json(res, 200, { text: r.out.trim() });
        }
        if (path === "/api/wechat/rebind/approve" && req.method === "POST") {
          const p = await body(req);
          if (!p?.code?.trim()) return json(res, 400, { error: "code 必填" });
          const r = await runCapture("openclaw", ["pairing", "approve", "openclaw-weixin", String(p.code).trim()]);
          return json(res, 200, { ok: r.code === 0, text: r.out.trim() });
        }
        if (path === "/api/wechat/rebind/target" && req.method === "POST") {
          const p = await body(req);
          if (!p?.peer || !validWechatPeer(String(p.peer))) return json(res, 400, { error: "微信 id 格式不对（应为 o…@im.wechat，可从配对列表或网关日志获取）" });
          const file = join(root, "runtime/config/wechat.json");
          const cfg = JSON.parse(readFileSync(file, "utf8"));
          cfg.targetPeer = String(p.peer).trim();
          writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", "utf8");
          return json(res, 200, { ok: true });
        }
        if (path === "/api/wechat/rebind/restart" && req.method === "POST") {
          await gatewayCtl("restart");
          return json(res, 200, { ok: true });
        }

        // ── 自定义背景：持久化到 runtime/web/，任意浏览器/刷新都继承 ──
        if (path === "/api/bg" && req.method === "GET") {
          const metaF = join(root, "runtime", "web", "bg.json");
          if (!existsSync(metaF)) return json(res, 404, { error: "no bg" });
          const meta = JSON.parse(readFileSync(metaF, "utf8"));
          res.writeHead(200, { "content-type": meta.type, "cache-control": "no-cache" });
          return createReadStream(join(root, "runtime", "web", "bg.img")).pipe(res);
        }
        if (path === "/api/bg" && req.method === "POST") {
          const type = String(req.headers["content-type"] ?? "");
          if (!/^image\/(png|jpe?g|webp|gif)$/.test(type)) return json(res, 400, { error: "仅支持 png/jpg/webp/gif" });
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const c of req) { size += (c as Buffer).length; if (size > 10 * 1024 * 1024) { req.destroy(); return json(res, 413, { error: "图片超过 10MB" }); } chunks.push(c as Buffer); }
          if (!size) return json(res, 400, { error: "空 body" });
          mkdirSync(join(root, "runtime", "web"), { recursive: true });
          writeFileSync(join(root, "runtime", "web", "bg.img"), Buffer.concat(chunks));
          writeFileSync(join(root, "runtime", "web", "bg.json"), JSON.stringify({ type, at: new Date().toISOString() }));
          return json(res, 200, { ok: true });
        }
        if (path === "/api/bg" && req.method === "DELETE") {
          for (const f of ["bg.img", "bg.json"]) {
            const p = join(root, "runtime", "web", f);
            if (existsSync(p)) rmSync(p);
          }
          return json(res, 200, { ok: true });
        }

        // ── 模型接入（Web 版 /login）：查看当前接入 + 更新 API key + 切默认模型 ──
        if (path === "/api/login" && req.method === "GET") {
          let auth: Record<string, unknown> = {};
          const authFile = join(agentDir, "auth.json");
          if (existsSync(authFile)) {
            const raw = JSON.parse(readFileSync(authFile, "utf8")) as Record<string, { type?: string }>;
            auth = Object.fromEntries(Object.keys(raw).map((p) => [p, raw[p]?.type ?? "api_key"]));
          }
          let settings: any = {};
          const settingsFile = join(agentDir, "settings.json");
          if (existsSync(settingsFile)) settings = JSON.parse(readFileSync(settingsFile, "utf8"));
          const models = await modelCatalog();
          return json(res, 200, { auth, defaultModel: settings.defaultModel ?? "", defaultProvider: settings.defaultProvider ?? "", models });
        }
        if (path === "/api/login" && req.method === "POST") {
          const p = await body(req);
          const authFile = join(agentDir, "auth.json");
          if (!p?.provider || !p?.key || String(p.key).length < 8) return json(res, 400, { error: "需要 provider 与 key（≥8 字符）" });
          const auth = existsSync(authFile) ? JSON.parse(readFileSync(authFile, "utf8")) : {};
          auth[String(p.provider)] = { type: "api_key", key: String(p.key) };
          writeFileSync(authFile, JSON.stringify(auth, null, 2) + "\n", "utf8");
          return json(res, 200, { ok: true, note: "新会话生效" });
        }
        if (path === "/api/model" && req.method === "POST") {
          const p = await body(req);
          if (typeof p?.model !== "string" || !p.model.trim()) return json(res, 400, { error: "请选择模型。" });
          if (chatBusy) return json(res, 409, { error: "请等当前回复结束后再切换模型。" });
          chatBusy = true;
          try {
            const choices = (await modelCatalog()).filter((m) => m.id === p.model && (!p.provider || m.provider === p.provider));
            if (choices.length !== 1) return json(res, 400, { error: "模型不可用或存在同名模型，请重新选择服务商与模型。" });
            const selected = choices[0];
            // 在修改配置前关闭旧 Web 会话；历史文件不删，下条消息按新模型恢复。
            if (deps.resetChatSessions) await deps.resetChatSessions();
            else await (await import("../chat/session.ts")).disposeWebSessions(root);
            mkdirSync(agentDir, { recursive: true });
            const settingsFile = join(agentDir, "settings.json");
            const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, "utf8")) : {};
            settings.defaultProvider = selected.provider;
            settings.defaultModel = selected.id;
            const temporary = `${settingsFile}.${randomUUID()}.tmp`;
            try {
              writeFileSync(temporary, JSON.stringify(settings, null, 2) + "\n", "utf8");
              renameSync(temporary, settingsFile);
            } finally {
              rmSync(temporary, { force: true });
            }
            return json(res, 200, { ok: true, provider: selected.provider, model: selected.id, note: "已保存，网页与微信的下一条消息使用此模型，聊天记录保留。" });
          } finally {
            chatBusy = false;
          }
        }

        // 删除会话（本地历史归档；微信侧不受影响）：删文件 + 卸载内存缓存
        m = path.match(/^\/api\/sessions\/([\w-]+)$/);
        if (m && req.method === "DELETE") {
          const file = join(root, "runtime", "chats", m[1] + ".jsonl");
          if (!resolve(file).startsWith(join(root, "runtime", "chats"))) return json(res, 400, { error: "非法会话 id" });
          (await import("../chat/session.ts")).disposeSession(m[1]); // 防内存里旧上下文复活
          if (!existsSync(file)) return json(res, 404, { error: `会话不存在：${m[1]}` });
          rmSync(file);
          return json(res, 200, { ok: true });
        }

        // ── 会话列表（对话页右岛）：首条用户消息命名，剥离通道噪声头 ──
        if (path === "/api/sessions" && req.method === "GET") {
          const dir = join(root, "runtime", "chats");
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
                  const clean = text.replace(/Conversation info:[\s\S]*?```\n/, "").replace(/^⟦[^⟧]*⟧\s*/, "").replace(/^\[[\w :,+GMT-]*\]\s*/, "").replace(/[\n\r]/g, " ").trim();
                  count++;
                  if (!title && clean) title = clean.slice(0, 26);
                } catch { /* 坏行跳过 */ }
              }
              out.push({ id, title: title || "（无标题）", count, lastTs, src: id === "web" || id.startsWith("web-") ? "web" : "wechat" });
            }
          }
          out.sort((a, b) => (a.lastTs < b.lastTs ? 1 : -1));
          return json(res, 200, { sessions: out });
        }

        if (path === "/api/chat/history" && req.method === "GET") {
          const sid = url.searchParams.get("session")?.replace(/[^\w-]/g, "").slice(0, 64) || "web";
          return json(res, 200, { msgs: historyOf(sid) });
        }
        if (path === "/api/chat" && req.method === "POST") {
          const { text, session } = await body(req);
          if (!text) return json(res, 400, { error: "text 不能为空" });
          if (chatBusy) return json(res, 429, { error: "上一条还在处理中" });
          chatBusy = true;
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
          sse(res, "start", { ok: true });
          try {
            const sid = typeof session === "string" ? session.replace(/[^\w-]/g, "").slice(0, 64) || "web" : "web";
            const reply = deps.chat
              ? await deps.chat(text)
              : await (await import("../chat/session.ts")).webChat(text, root, deps.agentDir ?? join(root, "runtime", "agent"), logger, sid);
            if (typeof reply !== "string" || !reply.trim()) throw new Error(EMPTY_REPLY_MESSAGE);
            sse(res, "done", { text: reply });
          } catch (e) {
            sse(res, "error", { error: formatReplyError(e) });
          } finally {
            chatBusy = false;
            res.end();
          }
          return;
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
      if (!res.headersSent) json(res, e instanceof MemoryConflictError ? 409 : e instanceof URIError ? 400 : 500, { error: e instanceof URIError ? "请求地址编码不正确。" : String(e).slice(0, 500) });
      else res.end();
    }
  });
  server.once("close", bookRoutes.close);
  return server;
}
