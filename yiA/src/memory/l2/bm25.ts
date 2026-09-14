/**
 * BM25 相关性打分：经典排序算法，用于 recall 工具与自动关联的排序。
 *
 * 公式：score(D,Q) = Σ IDF(q) · f(q,D)·(k1+1) / (f(q,D) + k1·(1-b+b·|D|/avgdl))
 * - IDF：词越罕见权重越高
 * - f：词在文档中的频次
 * - |D|/avgdl：文档长度归一化，避免长文本天然占优
 *
 * 注意：BM25 的绝对分数随语料规模变化（IDF 含 N），不能直接做固定阈值门控；
 * 因此额外计算 coverage（查询词元在文档中的命中率，0~1，规模无关），
 * 门控用 coverage，排序用 score。
 */
import type { L2Entry } from "./store.ts";
import { tokenize } from "./tokenizer.ts";

/** BM25 经验参数：k1 控制词频饱和，b 控制长度归一化强度 */
const K1 = 1.5;
const B = 0.75;

/** 带分数的检索结果：score 用于排序，coverage 用于门控 */
export type ScoredEntry = L2Entry & { score: number; coverage: number };

/** 预构建的文档索引（词频表），避免每次检索重复分词 */
export interface Doc {
  entry: L2Entry;
  tf: Map<string, number>;
  len: number;
}

/** 为单个条目构建索引（标题 + 标签 + 正文合并参与检索） */
export function buildDoc(entry: L2Entry): Doc {
  const tokens = tokenize(`${entry.title} ${entry.tags.join(" ")} ${entry.content}`);
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return { entry, tf, len: tokens.length };
}

/** 对已建索引的文档集合检索排序（热路径，纯内存） */
export function rankDocs(docs: Doc[], query: string, limit: number): ScoredEntry[] {
  const N = docs.length || 1;
  const avgdl = docs.reduce((s, d) => s + d.len, 0) / N || 1; // 平均文档长度

  // 查询词元去重；统计每个词的文档频率 df
  const queryTokens = Array.from(new Set(tokenize(query)));
  const df = new Map<string, number>();
  for (const t of queryTokens) {
    df.set(t, docs.filter((d) => d.tf.has(t)).length);
  }

  // 逐文档累加每个查询词的 BM25 得分，并计算覆盖率
  return docs
    .map(({ entry, tf, len }) => {
      let score = 0;
      let matched = 0;
      for (const term of queryTokens) {
        const f = tf.get(term);
        if (!f) continue;
        matched++;
        const docFreq = df.get(term)!;
        const idf = Math.log(1 + (N - docFreq + 0.5) / (docFreq + 0.5));
        score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * len) / avgdl));
      }
      return { ...entry, score, coverage: matched / (queryTokens.length || 1) };
    })
    .filter((e) => e.coverage > 0) // 一个词都没命中的不返回
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** 便捷入口：对原始条目集合检索（内部现建索引，适合一次性/小规模场景） */
export function bm25Rank(entries: L2Entry[], query: string, limit: number): ScoredEntry[] {
  return rankDocs(entries.map(buildDoc), query, limit);
}
