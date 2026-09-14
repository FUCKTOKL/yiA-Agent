/**
 * ContextPack（PRD F1.4 / F1.5 的注入侧）：每轮对话开始前，
 * 把「画像 + 门控召回的相关记忆 + 相关历史会话」压缩成一段文本，
 * 由扩展工厂追加到系统提示词。
 *
 * 门控原则：宁缺勿滥——分数不够不注入，避免噪声污染上下文。
 */
import type { L1Store } from "./l1/profile.ts";
import type { L2Store } from "./l2/store.ts";
import type { L3Store } from "./l3/sqlite-store.ts";

/** L2 注入门槛：词元覆盖率（0~1，规模无关）不低于此值的记忆才进 ContextPack。
 *  校准：相关查询 ≈0.24，无关 = 0。ponytail: 噪声多时调高 */
export const L2_INJECT_COVERAGE = 0.18;

/** 各层注入条数上限 */
const L2_LIMIT = 3;
const L3_LIMIT = 3;
/** 注入的记忆/会话摘录长度上限（字符） */
const SNIPPET_LEN = 200;

export interface MemoryDeps {
  l1: L1Store;
  l2: L2Store;
  /** 只需要 search 能力，便于 L3 不可用时降级 */
  l3: Pick<L3Store, "search">;
}

/**
 * 构建本轮的 ContextPack 文本。
 * 用户提示词为空（如命令触发的 agent 轮）时返回空串，不注入。
 * 任何一层出错都降级为跳过该层（异常规范：注入失败不能影响对话）。
 */
export function buildContextPack(prompt: string, deps: MemoryDeps): string {
  const sections: string[] = [];

  // ---- 0) 当前时间：模型换算"明天/周四下午"等相对时间的基准，始终注入 ----
  sections.push(`### 当前时间
- ${new Intl.DateTimeFormat("zh-CN", { dateStyle: "full", timeStyle: "short" }).format(new Date())}（本地时间，换算相对时间时以此为基准）`);

  // ---- 1) L1 画像（始终注入非空部分，无门控——画像是确定性上下文） ----
  try {
    const p = deps.l1.read();
    const lines: string[] = [];
    if (p.identity) lines.push(`- 身份: ${p.identity}`);
    if (p.preferences.length) lines.push(`- 偏好: ${p.preferences.join("；")}`);
    if (p.ongoing.length) lines.push(`- 常驻事项: ${p.ongoing.join("；")}`);
    if (p.facts.length) lines.push(`- 长期事实: ${p.facts.join("；")}`);
    if (lines.length) sections.push(`### 用户画像\n${lines.join("\n")}`);
  } catch {
    // 画像读取失败就跳过，不注入
  }

  if (!prompt.trim()) return sections.join("\n\n");

  // ---- 2) L2 相关记忆（BM25 门控） ----
  try {
    const hits = deps.l2
      .search(prompt, L2_LIMIT)
      .filter((h) => h.coverage >= L2_INJECT_COVERAGE);
    if (hits.length) {
      const body = hits
        .map((h) => `- [${h.id}] ${h.title}：${snippet(h.content)}`)
        .join("\n");
      sections.push(`### 相关记忆（自动召回）\n${body}`);
    }
  } catch {
    // L2 检索失败跳过
  }

  // ---- 3) L3 相关历史会话（覆盖率门控在 L3Store.search 内部） ----
  try {
    const hits = deps.l3.search(prompt, L3_LIMIT);
    if (hits.length) {
      const body = hits
        .map((h) => `- ${h.ts.slice(0, 10)} ${h.role}（${h.session.slice(0, 19)}）：${snippet(h.text)}`)
        .join("\n");
      sections.push(`### 相关历史会话（自动召回）\n${body}`);
    }
  } catch {
    // L3 检索失败跳过
  }

  if (sections.length === 0) return "";
  return `\n\n## yiA ContextPack（本轮自动注入，非用户消息）\n${sections.join("\n\n")}`;
}

function snippet(text: string): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > SNIPPET_LEN ? s.slice(0, SNIPPET_LEN) + "…" : s;
}
