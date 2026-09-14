/**
 * 提醒工具（PRD F2.1/F2.4）：自然语言建提醒的时间换算由 LLM 完成——
 * 模型结合 ContextPack 注入的"当前时间"把"周四下午3点"算成 ISO 8601，
 * 工具只做校验（必须是可解析的未来时间）与存储。不自己写日期解析器。
 *
 * - set_reminder：新建提醒
 * - list_reminders：事项清单（待触发任务）
 * - cancel_reminder：取消
 *
 * 异常规范（PRD §10.2）：execute 全部 try/catch，错误返回文本不穿透。
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Logger } from "../logger.ts";
import type { JobStore } from "../scheduler/job-store.ts";

/** 默认推送渠道按消息来源：微信里建的提醒默认推微信（chat-cli 会设
 *  YIA_CHANNEL=wechat），TUI 里建的默认 tui。显式传 channel 则优先。 */
export function defaultChannel(): "wechat" | "tui" {
  return process.env.YIA_CHANNEL === "wechat" ? "wechat" : "tui";
}

export interface ReminderDeps {
  store: JobStore;
  logger: Logger;
}

export function registerReminderTools(pi: ExtensionAPI, deps: ReminderDeps): void {
  const { store, logger } = deps;
  const fail = (e: unknown) => {
    logger.error("提醒工具执行失败", { error: String(e) });
    return { content: [{ type: "text", text: `工具执行出错：${String(e)}` }], details: {}, isError: true };
  };

  // ---- 建 ----
  pi.registerTool({
    name: "set_reminder",
    label: "设提醒",
    description:
      "创建定时提醒。at 必须是 ISO 8601 本地时间（如 2026-09-11T15:00:00+08:00），由你结合系统注入的「当前时间」把用户的自然语言换算出来。" +
      "repeatDays 表示每 N 天重复（如每天=1，每周=7），一次性提醒则不传。",
    parameters: Type.Object({
      title: Type.String({ description: "提醒内容（一句话，到点原样展示给用户）" }),
      at: Type.String({ description: "触发时间，ISO 8601（含时区偏移），必须是未来时间" }),
      repeatDays: Type.Optional(Type.Number({ description: "每 N 天重复；缺省一次性" })),
      channel: Type.Optional(Type.String({ description: "回推渠道：tui（默认）/ wechat（M4 起可用）" })),
    }),
    async execute(_toolCallId, params) {
      try {
        const t = Date.parse(params.at);
        if (Number.isNaN(t)) {
          return { content: [{ type: "text", text: "at 不是合法时间，请按 ISO 8601 重新换算（结合当前时间）。" }], details: {} };
        }
        if (t <= Date.now()) {
          return { content: [{ type: "text", text: "at 是过去时间，请结合「当前时间」重新换算后重试。" }], details: {} };
        }
        if (params.repeatDays !== undefined && (!Number.isFinite(params.repeatDays) || params.repeatDays < 1)) {
          return { content: [{ type: "text", text: "repeatDays 必须 ≥ 1（天）。" }], details: {} };
        }
        const job = store.add({
          title: params.title,
          at: params.at,
          repeatDays: params.repeatDays,
          channel: params.channel === "wechat" || params.channel === "tui"
            ? params.channel
            : defaultChannel(),
        });
        logger.info("set_reminder 完成", { id: job.id, at: job.at });
        return {
          content: [{
            type: "text",
            text: `已设置提醒 [${job.id}]：${job.title}\n触发时间：${new Date(job.at).toLocaleString("zh-CN")}` +
              (job.repeatDays ? `（每 ${job.repeatDays} 天重复）` : ""),
          }],
          details: {},
        };
      } catch (e) {
        return fail(e);
      }
    },
  });

  // ---- 查（事项清单 F2.4） ----
  pi.registerTool({
    name: "list_reminders",
    label: "看提醒",
    description: "列出全部待触发的提醒/事项（按时间升序）。",
    parameters: Type.Object({}),
    async execute() {
      try {
        const jobs = store.pending();
        if (jobs.length === 0) {
          return { content: [{ type: "text", text: "当前没有待触发的提醒。" }], details: {} };
        }
        const text = jobs
          .map((j) => `- [${j.id}] ${new Date(j.at).toLocaleString("zh-CN")}${j.repeatDays ? `（每 ${j.repeatDays} 天）` : ""}${j.channel === "wechat" ? " [微信]" : ""}：${j.title}`)
          .join("\n");
        return { content: [{ type: "text", text }], details: {} };
      } catch (e) {
        return fail(e);
      }
    },
  });

  // ---- 取消 ----
  pi.registerTool({
    name: "cancel_reminder",
    label: "取消提醒",
    description: "取消一条待触发的提醒（先 list_reminders 拿 id）。",
    parameters: Type.Object({
      id: Type.String({ description: "提醒任务 id" }),
    }),
    async execute(_toolCallId, params) {
      try {
        const ok = store.cancel(params.id);
        logger.info("cancel_reminder", { id: params.id, ok });
        return {
          content: [{ type: "text", text: ok ? `已取消 [${params.id}]` : `未找到待触发的任务 [${params.id}]` }],
          details: {},
        };
      } catch (e) {
        return fail(e);
      }
    },
  });
}
