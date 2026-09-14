/**
 * yiA 记忆工具：注册给 LLM 调用的四个工具。
 *
 * - remember：存储一条记忆，自动关联相关旧条目（双向链接）
 * - recall：按关键词检索 L2 知识库
 * - refine：修改既有条目（正文/标题/标签）
 * - update_profile：更新 L1 用户画像
 *
 * 异常规范（PRD §10.2）：每个 execute 都 try/catch，
 * 错误信息作为结果返回给模型，不允许异常穿透中断 agent 循环。
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Logger } from "../logger.ts";
import type { L1Store, Section } from "../memory/l1/profile.ts";
import type { L2Store } from "../memory/l2/store.ts";
import { SECTIONS } from "../memory/l1/profile.ts";

export interface ToolDeps {
  l1: L1Store;
  l2: L2Store;
  logger: Logger;
}

/** 向 Pi 注册全部记忆工具 */
export function registerMemoryTools(pi: ExtensionAPI, deps: ToolDeps): void {
  const { l1, l2, logger } = deps;
  const fail = (e: unknown) => {
    logger.error("工具执行失败", { error: String(e) });
    return { content: [{ type: "text", text: `工具执行出错：${String(e)}` }], details: {}, isError: true };
  };

  // ---- 存（自动关联） ----
  pi.registerTool({
    name: "remember",
    label: "记住",
    description: "存储一条记忆（信息、灵感、待办、知识点）。一句话即可，自动生成标题并关联相关旧记忆。",
    parameters: Type.Object({
      content: Type.String({ description: "要记住的内容" }),
      title: Type.Optional(Type.String({ description: "可选标题，默认取内容首行" })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "可选标签" })),
    }),
    async execute(_toolCallId, params) {
      try {
        const started = Date.now();
        const e = l2.save(params.content, params.title, params.tags ?? []);
        logger.info("remember 完成", { id: e.id, ms: Date.now() - started });
        const links = e.links.length ? `，关联 [${e.links.join("] [")}]` : "";
        return {
          content: [{ type: "text", text: `已记住 [${e.id}] ${e.title}${e.tags.length ? ` (${e.tags.join(", ")})` : ""}${links}` }],
          details: {},
        };
      } catch (e) {
        return fail(e);
      }
    },
  });

  // ---- 取 ----
  pi.registerTool({
    name: "recall",
    label: "回忆",
    description: "按关键词检索已存储的记忆（L2 知识库）。回答关于过去内容的问题前先调用。",
    parameters: Type.Object({
      query: Type.String({ description: "检索关键词，留空则返回最新记忆" }),
      limit: Type.Optional(Type.Number({ description: "返回条数，默认 5" })),
    }),
    async execute(_toolCallId, params) {
      try {
        const results = l2.search(params.query, params.limit ?? 5);
        if (results.length === 0) {
          return { content: [{ type: "text", text: "没有找到相关记忆。" }], details: {} };
        }
        // Markdown 输出，模型可引用条目 id 作为来源；附关联列表
        const text = results
          .map(
            (e) =>
              `## [${e.id}] ${e.title}${e.tags.length ? ` (${e.tags.join(", ")})` : ""}\n` +
              `创建: ${e.created}` +
              (e.links.length ? `｜关联: ${e.links.join(", ")}` : "") +
              `\n${e.content}`
          )
          .join("\n\n");
        return { content: [{ type: "text", text }], details: {} };
      } catch (e) {
        return fail(e);
      }
    },
  });

  // ---- 改（refine） ----
  pi.registerTool({
    name: "refine",
    label: "精炼",
    description: "修改一条既有记忆的内容/标题/标签（保留 id 与创建时间）。先 recall 拿到 id 再调用。",
    parameters: Type.Object({
      id: Type.String({ description: "要修改的记忆条目 id" }),
      content: Type.Optional(Type.String({ description: "新内容（不传则保持原内容）" })),
      title: Type.Optional(Type.String({ description: "新标题（不传则保持原标题）" })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "新标签（不传则保持原标签）" })),
    }),
    async execute(_toolCallId, params) {
      try {
        const e = l2.refine(params.id, params);
        if (!e) {
          return { content: [{ type: "text", text: `未找到条目 ${params.id}，可先 recall 确认 id。` }], details: {} };
        }
        logger.info("refine 完成", { id: e.id });
        return { content: [{ type: "text", text: `已更新 [${e.id}] ${e.title}` }], details: {} };
      } catch (e) {
        return fail(e);
      }
    },
  });

  // ---- L1 画像 ----
  pi.registerTool({
    name: "update_profile",
    label: "更新画像",
    description: `更新用户画像。section 取值：${SECTIONS.join(" / ")}。列表区块可 append 追加。`,
    parameters: Type.Object({
      section: Type.String({ description: `画像区块：${SECTIONS.join(" / ")}` }),
      content: Type.String({ description: "要写入的内容（一句话或一项）" }),
      append: Type.Optional(Type.Boolean({ description: "列表区块是否追加而非替换，默认 false" })),
    }),
    async execute(_toolCallId, params) {
      try {
        if (!SECTIONS.includes(params.section as Section)) {
          return {
            content: [{ type: "text", text: `section 必须是：${SECTIONS.join(" / ")}` }],
            details: {},
          };
        }
        const p = l1.update(params.section as Section, params.content, params.append ?? false);
        logger.info("update_profile 完成", { section: params.section });
        return {
          content: [{ type: "text", text: `画像已更新（${params.section}）。当前画像：\n${JSON.stringify(p, null, 2)}` }],
          details: {},
        };
      } catch (e) {
        return fail(e);
      }
    },
  });
}
