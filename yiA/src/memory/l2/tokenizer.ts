/**
 * 分词器：中英混排文本切词，供 BM25 检索使用。
 *
 * 策略（简单但对中英混合场景够用）：
 * - 拉丁字母/数字：连续串作为一个词，统一转小写（如 "Node"、"vite"）
 * - 中文：按 CJK 连续段切成「二元组」（bigram），例如 "环境配置" → ["环境", "境配", "配置"]
 *   二元组是中文无空格分词的经典近似，避免引入 jieba 等分词依赖。
 */

/** 把一段文本切分为检索用词元数组 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();

  // 1) 拉丁词与数字（版本号、英文标识符等）
  for (const word of lower.match(/[a-z0-9]+/g) ?? []) {
    tokens.push(word);
  }

  // 2) 中文二元组
  for (const run of lower.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) {
      tokens.push(run); // 单字直接作为词元
    } else {
      for (let i = 0; i < run.length - 1; i++) {
        tokens.push(run.slice(i, i + 2));
      }
    }
  }

  return tokens;
}
