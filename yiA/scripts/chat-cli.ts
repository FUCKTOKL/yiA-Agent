/**
 * chat-cli（M4 入站大脑入口）：OpenClaw 的 yia-cli CLI 后端每条微信消息
 * 调本脚本一次（Windows Gateway → wsl.exe → node 本文件）。
 *
 * 协议（与 sidecar/clawbot-yia 插件的 config 对应）：
 * - 输入：stdin = 用户消息文本；--session <id> = OpenClaw 会话 id
 * - 输出：stdout 一个 JSON：{ "result": "<回复>", "session_id": "<同 id>" }
 *   （OpenClaw output:"json" 解析器提取文本与 session id）
 *
 * 会话持久化：--session id 映射到 runtime/chats/<id>.jsonl，
 * 首次创建、后续复用（SessionManager.open），微信多轮对话连续。
 *
 * 运行环境：WSL 内、项目根为 cwd（由插件 args 保证），扩展/记忆全部可用。
 */
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

/** 项目根：脚本位于 <root>/yiA/scripts/，上两级即根（不依赖 Gateway 的启动 cwd） */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** yiA 独立 agent 目录：配置/凭据/模型目录/会话全部隔离在项目内，
 *  与用户个人的 pi agent（~/.pi/agent）完全无关（关键决策：yiA 运行时独立）。 */
const AGENT_DIR = join(ROOT, "runtime", "agent");

// 标记消息来源：微信里建的提醒默认推微信（见 reminder-tools defaultChannel）
process.env.YIA_CHANNEL = "wechat";

/** 解析命令行 --session <id>（简单场景不引依赖） */
function parseArgs(argv: string[]): { sessionId: string | null } {
  let sessionId: string | null = null;
  const i = argv.indexOf("--session");
  if (i >= 0 && argv[i + 1]) sessionId = argv[i + 1];
  return { sessionId };
}

/** OpenClaw 会话 id → yiA 会话文件路径（防路径注入：只留安全字符） */
export function sessionFileFor(sessionId: string, root: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "default";
  return join(root, "runtime", "chats", `${safe}.jsonl`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function main(): Promise<void> {
  const root = ROOT;
  const { sessionId } = parseArgs(process.argv.slice(2));
  const prompt = await readStdin();
  if (!prompt) {
    console.log(JSON.stringify({ result: "", session_id: sessionId ?? "" }));
    return;
  }

  // 会话连续性：已有映射文件则复用；否则新建，结束后把会话文件落到映射路径
  // （SessionManager.create 只能建到 pi 默认会话目录，所以首次结束后复制过来）
  const file = sessionFileFor(sessionId ?? "default", root);
  const reused = sessionId !== null && existsSync(file);
  const sessionManager = reused ? SessionManager.open(file) : SessionManager.create(root);

  const { session } = await createAgentSession({
    cwd: root,
    agentDir: AGENT_DIR, // 独立 agent 目录：模型/凭据/默认设置均从 runtime/agent/ 读
    sessionManager,
  });

  await session.prompt(prompt);
  if (sessionId && !reused && session.sessionFile) {
    mkdirSync(dirname(file), { recursive: true });
    copyFileSync(session.sessionFile, file);
  }

  // 取最后一条 assistant 文本作为回复
  const msgs = session.agent.state.messages;
  const last = [...msgs].reverse().find((m) => m.role === "assistant");
  const text = last
    ? (Array.isArray(last.content) ? last.content : [])
        .filter((c: any) => c?.type === "text")
        .map((c: any) => c.text)
        .join("\n")
    : "";

  session.dispose();
  console.log(JSON.stringify({ result: text, session_id: sessionId ?? "default" }));
}

// 仅作为入口运行时才启动（供单测导入 sessionFileFor）
const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry && entry === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    // 兜底：任何异常都返回可发送的文本，绝不让 Gateway 收到空回复静默
    console.log(JSON.stringify({ result: `（yiA 处理出错：${String(e).slice(0, 200)}）`, session_id: "" }));
  });
}
