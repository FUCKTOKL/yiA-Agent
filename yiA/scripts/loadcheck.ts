// 验证 yiA 扩展能被 Pi 正确加载并注册工具（不调用 LLM）
// 注意：与 chat-cli 一致使用 yiA 独立 agent 目录（runtime/agent），
// 不碰用户个人的 ~/.pi/agent
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

// 代码在 <root>/yiA/scripts/，项目根为上两级；加载器在根的 .pi/extensions/
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const loader = new DefaultResourceLoader({
  cwd: projectRoot,
  agentDir: join(projectRoot, "runtime", "agent"),
  additionalExtensionPaths: [join(projectRoot, ".pi/extensions/yia.ts")],
});
await loader.reload();

const { session, extensionsResult } = await createAgentSession({
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(),
});

const errs = extensionsResult.errors;
if (errs.length) {
  console.error("扩展加载失败:", JSON.stringify(errs, null, 2));
  process.exit(1);
}
const tools = session.agent.state.tools.map((t) => t.name);
for (const want of ["remember", "recall", "list_books", "search_books", "read_book_passage"]) {
  if (!tools.includes(want)) throw new Error(`工具未注册: ${want}`);
}
session.dispose();
console.log("yiA 扩展加载 ✓ (记忆工具 + 书架/全文检索/原文阅读工具已注册)");
