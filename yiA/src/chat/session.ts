/**
 * Web 会话：chat-cli 同款无头会话，供 web-server 复用（runtime/chats/<session>.jsonl 连续）。
 * 与 chat-cli 的差别：会话常驻内存（不每条消息建/销毁 agent），多轮更快。
 * 支持多会话（Web 会话切换/新建；缺省 "web"），按 session id 缓存。
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createYiaHeadlessSession, disposeYiaHeadlessSession } from "./session-factory.ts";
import { getAssistantReply } from "./reply.ts";
import type { Logger } from "../logger.ts";

interface WebSession {
  root: string;
  prompt(text: string): Promise<string>;
  dispose(): Promise<void>;
}

/** 会话 id 白名单（防路径注入；与 chat-cli sessionFileFor 同规则） */
function safeId(session: string): string {
  return session.replace(/[^\w-]/g, "").slice(0, 64) || "web";
}

const cache = new Map<string, WebSession>();

/** 卸载某个会话的缓存实例（删除会话文件前调用，防内存里旧上下文复活） */
export function disposeSession(session = "web"): void {
  const sid = safeId(session);
  const s = cache.get(sid);
  cache.delete(sid);
  void s?.dispose();
}

/** 切模型时释放此运行时的缓存；下条消息从归档恢复历史并采用新默认模型。 */
export async function disposeWebSessions(root: string): Promise<void> {
  const sessions: WebSession[] = [];
  for (const [key, session] of cache) {
    if (session.root !== root) continue;
    cache.delete(key);
    sessions.push(session);
  }
  await Promise.all(sessions.map((session) => session.dispose()));
}

export async function webChat(text: string, root: string, agentDir: string, logger: Logger, session = "web"): Promise<string> {
  const sid = safeId(session);
  let s = cache.get(sid);
  if (!s) {
    const file = join(root, "runtime", "chats", `${sid}.jsonl`);
    const reused = existsSync(file);
    // 关键：sessionManager 必须传进 createAgentSession，否则会话落在 pi 默认目录、不续档
    const sessionManager = reused ? SessionManager.open(file) : SessionManager.create(root);
    const session = await createYiaHeadlessSession(root, agentDir, sessionManager);
    s = {
      root,
      async prompt(t: string) {
        await session.prompt(t);
        // 首次新建：把 pi 默认目录的会话文件复制到映射路径
        if (!reused && session.sessionFile) {
          mkdirSync(dirname(file), { recursive: true });
          copyFileSync(session.sessionFile, file);
        }
        return getAssistantReply(session.agent.state.messages);
      },
      dispose() { return disposeYiaHeadlessSession(session); },
    };
    cache.set(sid, s);
    logger.info("web 会话建立", { session: sid, reused });
  }
  return s.prompt(text);
}
