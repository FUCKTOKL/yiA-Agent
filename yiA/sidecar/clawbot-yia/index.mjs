/**
 * yiA CLI 后端插件（跑在 OpenClaw Gateway 进程内，WSL 直连方案）。
 *
 * 职责：把 model ref `yia-cli/yia` 映射到 node 直调 chat-cli——
 * 每条微信消息 spawn 一次，stdin 传消息文本，stdout 读 JSON 回复。
 * 会话连续性：OpenClaw 传 {sessionId}，yiA 映射为 runtime/chats/<id>.jsonl。
 *
 * 必须用 definePluginEntry 契约注册（普通对象导出不会被调用 register）。
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

// 项目根自动推导：插件位于 <root>/yiA/sidecar/clawbot-yia/（跨平台，无硬编码路径）
// 环境变量 YIA_ROOT 可覆盖（多实例部署时用）
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
const PROJECT_ROOT = process.env.YIA_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function buildYiaBackend() {
  return {
    id: "yia-cli",
    liveTest: {
      defaultModelRef: "yia-cli/yia",
      defaultImageProbe: false,
      defaultMcpProbe: false,
    },
    config: {
      command: "node",
      args: [
        "--experimental-strip-types",
        `${PROJECT_ROOT}/yiA/scripts/chat-cli.ts`,
      ],
      // 会话 id 作为脚本参数，stdin 传消息（--session 在 base args 后由 sessionArgs 追加）
      sessionArgs: ["--session", "{sessionId}"],
      sessionMode: "always",
      output: "json",
      input: "stdin",
      serialize: true, // 同一会话串行，避免并发写同一会话文件
    },
  };
}

export default definePluginEntry({
  id: "yia-cli",
  name: "yiA CLI Backend",
  description: "Run yiA second-brain (WSL) as a text backend",
  register(api) {
    api.registerCliBackend(buildYiaBackend());
  },
});
