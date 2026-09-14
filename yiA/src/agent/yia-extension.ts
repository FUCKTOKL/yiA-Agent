/**
 * yiA 扩展工厂（项目唯一入口）。
 *
 * 这是与 Pi SDK 集成的入口：导出一个默认工厂函数，
 * Pi 启动时通过 jiti 加载本文件并调用工厂，拿到 ExtensionAPI 后完成：
 *   1. 初始化三层记忆（L1 画像 / L2 知识库 / L3 会话索引）与统一日志
 *   2. 注册 remember / recall / refine / update_profile 四个工具
 *   3. session_start 时增量同步 L3 会话索引
 *   4. 每轮对话前注入 yiA 记忆规范 + ContextPack（画像 + 门控召回）
 *
 * Pi 内核零改动，只用公开 ExtensionAPI —— 项目关键决策，勿推翻。
 * 异常规范（PRD §10.2）：工厂内的初始化不得抛出——加载失败要降级，
 * 不能拖垮 pi 启动。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { Logger } from "../logger.ts";
import { L1Store } from "../memory/l1/profile.ts";
import { L2Store } from "../memory/l2/store.ts";
import { L3Store } from "../memory/l3/sqlite-store.ts";
import { JobStore } from "../scheduler/job-store.ts";
import { buildContextPack } from "../memory/context-pack.ts";
import { registerMemoryTools } from "./tools.ts";
import { registerReminderTools } from "./reminder-tools.ts";
import { registerYiaCommands } from "./commands.ts";
import { YIA_MEMORY_PROMPT } from "./system-prompt.ts";

/** 推算项目根目录：本文件位于 <root>/yiA/src/agent/，上三级即项目根。
 *  （代码在 yiA/ 子目录，数据 runtime/ 留在项目根，便于整体备份）
 *  推算失败（理论上 jiti 均支持 import.meta.url）则退回启动目录。 */
function projectRoot(): string {
  try {
    return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  } catch {
    return process.cwd();
  }
}

export default function (pi: ExtensionAPI) {
  const root = projectRoot();

  // ---- 初始化（全部 try/catch 降级，不拖垮 pi 启动） ----
  const logger = new Logger(join(root, "runtime", "logs"));
  const l1 = new L1Store(join(root, "runtime", "l1", "profile.json"));
  const l2 = new L2Store(root);
  let l3: L3Store | null = null;
  try {
    l3 = new L3Store(
      join(root, "runtime", "l3", "index.db"),
      L3Store.sessionsDirFor(root, join(homedir(), ".pi", "agent"))
    );
  } catch (e) {
    logger.error("L3 初始化失败，会话检索降级为不可用", { error: String(e) });
  }

  // 1) 注册记忆工具 + 提醒工具
  const jobs = new JobStore(
    join(root, "runtime", "scheduler", "jobs.json"),
    join(root, "runtime", "scheduler", "runs.jsonl")
  );
  registerMemoryTools(pi, { l1, l2, logger });
  registerReminderTools(pi, { store: jobs, logger });
  // M5 自定义命令：/reminder /wechat /brain
  registerYiaCommands(pi, { root, jobs, l2 });

  // 2) 会话开始时增量同步 L3 索引；会话结束关闭 L3 连接
  //    注意：提醒触发已收归 scheduler-daemon（systemd 常驻），
  //    会话内不再启动 ReminderRunner（防双发，2026-09-12 复盘后决策）
  pi.on("session_start", async () => {
    if (l3) {
      try {
        const r = l3.sync((m) => logger.warn(m));
        if (r.files > 0) logger.info("L3 会话索引同步", r);
      } catch (e) {
        logger.error("L3 同步失败", { error: String(e) });
      }
    }
  });

  pi.on("session_shutdown", async () => {
    l3?.close();
  });

  // 3) 每轮开始前：记忆规范 + ContextPack（当前时间 + 画像 + L2/L3 门控召回）
  //    L3 不可用时用空检索替身降级（画像与 L2 照常工作）
  pi.on("before_agent_start", async (event) => {
    try {
      const pack = buildContextPack(event.prompt, { l1, l2, l3: l3 ?? NO_L3 });
      return { systemPrompt: event.systemPrompt + YIA_MEMORY_PROMPT + pack };
    } catch (e) {
      logger.error("ContextPack 构建失败，本轮跳过注入", { error: String(e) });
      return { systemPrompt: event.systemPrompt + YIA_MEMORY_PROMPT };
    }
  });
}

/** L3 不可用时的空检索替身（search 永远返回空） */
const NO_L3: { search: () => [] } = { search: () => [] };
