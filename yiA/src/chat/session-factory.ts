import {
  createAgentSession,
  createMcpExtension,
  DefaultResourceLoader,
  type AgentSession,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

/**
 * 无头入口（微信/Web）共用的 Pi 会话工厂。
 * SDK 不会像 Pi CLI 一样自动装载 MCP；显式注册后，runtime/agent/mcp.json
 * 中 exposure=direct 的天气工具才会进入模型工具面。
 */
export async function createYiaHeadlessSession(root: string, agentDir: string, sessionManager: SessionManager) {
  // createMcpExtension 的默认配置加载器从环境取 agentDir，SDK options 不会自动同步它。
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const settingsManager = SettingsManager.create(root, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    // 无头会话没有交互式项目信任确认，显式加载 yiA 的核心扩展。
    additionalExtensionPaths: [join(root, ".pi", "extensions", "yia.ts")],
    extensionFactories: [createMcpExtension()],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: root,
    agentDir,
    sessionManager,
    settingsManager,
    resourceLoader,
  });
  // 触发 session_start：连接 runtime/agent/mcp.json 中的 MCP 服务器。
  await session.bindExtensions({});
  return session;
}

/** AgentSession.dispose 不触发 session_shutdown；显式通知 MCP 断开 stdio 子进程。 */
export async function disposeYiaHeadlessSession(session: AgentSession): Promise<void> {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
}
