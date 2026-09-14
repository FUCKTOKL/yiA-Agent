/**
 * Web 会话：chat-cli 同款无头会话，供 web-server 复用（web.jsonl 连续）。
 * 与 chat-cli 的差别：会话常驻内存（不每条消息建/销毁 agent），多轮更快；
 * 每轮结束后把 pi 会话文件同步到 runtime/chats/web.jsonl（与其他通道同一套归档格式）。
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { Logger } from "../logger.ts";

interface WebSession {
  prompt(text: string): Promise<string>;
  dispose(): void;
}

let cached: WebSession | null = null;

export async function webChat(text: string, root: string, agentDir: string, logger: Logger): Promise<string> {
  if (!cached) {
    const file = join(root, "runtime", "chats", "web.jsonl");
    const reused = existsSync(file);
    const sessionManager = reused ? SessionManager.open(file) : SessionManager.create(root);
    const { session } = await createAgentSession({ cwd: root, agentDir });
    cached = {
      async prompt(t: string) {
        await session.prompt(t);
        // 同步归档（首次新建时 pi 的会话文件在默认目录，复制到映射路径）
        if (!reused && session.sessionFile) {
          mkdirSync(dirname(file), { recursive: true });
          copyFileSync(session.sessionFile, file);
        }
        const msgs = session.agent.state.messages;
        const last = [...msgs].reverse().find((mm) => mm.role === "assistant");
        return (Array.isArray(last?.content) ? last!.content : [])
          .filter((c: any) => c?.type === "text")
          .map((c: any) => c.text)
          .join("\n");
      },
      dispose() { session.dispose(); cached = null; },
    };
    logger.info("web 会话建立", { reused });
  }
  return cached.prompt(text);
}
