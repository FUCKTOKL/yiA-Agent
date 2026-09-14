/**
 * L3 会话记忆（PRD F1）：Pi 会话 JSONL 的全文索引，支持跨对话检索。
 *
 * - 数据源：<agentDir>/sessions/<项目会话目录>/*.jsonl（只索引本项目会话，
 *   避免把其他项目的编码对话混进"第二大脑"）
 * - 索引：runtime/l3/index.db，SQLite FTS5 全文索引
 * - 分词：复用 L2 的中英混排分词器（CJK 二元组），索引里存的是
 *   "分词后用空格连接"的文本，查询同样先分词再用 OR 组合——
 *   这样 FTS5 默认的 unicode61 分词器就能正确命中中文 bigram
 * - 增量：按文件大小判断变化，变了就整文件重建（会话文件小，成本低）
 *   ponytail: 单文件数 MB 后改为按行偏移追加
 */
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tokenize } from "../l2/tokenizer.ts";

/** 门控阈值：候选行至少命中的查询词数（不足则视为噪声不返回）。
 *  单词查询放宽为 1。ponytail: 经验值，tests/l3.test.ts 有边界用例 */
export const L3_MIN_TERM_HITS = 2;

export interface L3Hit {
  text: string;    // 原文（用于注入/展示）
  role: string;    // user / assistant
  ts: string;      // 消息时间
  session: string; // 会话文件名（含日期，可作引用来源）
  score: number;   // bm25 分（越小越相关）
}

export class L3Store {
  private db: DatabaseSync;
  private readonly sessionsDir: string;

  constructor(dbPath: string, sessionsDir: string) {
    this.sessionsDir = sessionsDir;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    // text/session/role/ts 只存不索引（UNINDEXED），tokens 才参与全文匹配
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta(file TEXT PRIMARY KEY, size INTEGER NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS msgs USING fts5(
        tokens, text UNINDEXED, session UNINDEXED, role UNINDEXED, ts UNINDEXED
      );
    `);
  }

  /** 由项目根目录推算本项目在 Pi 中的会话目录（Pi 用 cwd 替换 / 为 - 命名） */
  static sessionsDirFor(projectRoot: string, agentDir: string): string {
    return join(agentDir, "sessions", projectRoot.replaceAll("/", "-"));
  }

  /**
   * 增量同步会话文件到索引。返回 {files, msgs} 供日志记录。
   * 异常处理：单个文件解析失败跳过该文件（记 warn 由调用方处理）。
   */
  sync(onWarn?: (msg: string) => void): { files: number; msgs: number } {
    let files = 0;
    let msgs = 0;
    let jsonl: string[] = [];
    try {
      jsonl = readdirSync(this.sessionsDir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return { files: 0, msgs: 0 }; // 目录不存在（还没有会话）不算错误
    }

    for (const name of jsonl) {
      const file = join(this.sessionsDir, name);
      const size = statSync(file).size;
      const known = this.db
        .prepare("SELECT size FROM meta WHERE file = ?")
        .get(file) as { size: number } | undefined;
      if (known?.size === size) continue; // 未变化，跳过

      try {
        const n = this.reindex(file, name);
        files++;
        msgs += n;
      } catch (e) {
        onWarn?.(`L3 跳过损坏的会话文件 ${name}: ${String(e)}`);
      }
    }
    return { files, msgs };
  }

  /** 整文件重建索引，返回索引的消息数 */
  private reindex(file: string, name: string): number {
    const rows: unknown[][] = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // 跳过残缺行（写入中途崩溃等）
      }
      if (entry?.type !== "message") continue;
      const msg = entry.message ?? {};
      if (msg.role !== "user" && msg.role !== "assistant") continue;
      // 只取文本部分（图片等跳过）
      const text = (Array.isArray(msg.content) ? msg.content : [])
        .filter((c: any) => c?.type === "text" && typeof c.text === "string")
        .map((c: any) => c.text)
        .join("\n")
        .trim();
      if (!text) continue;
      rows.push([tokenize(text).join(" "), text, name, msg.role, entry.timestamp ?? ""]);
    }

    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM msgs WHERE session = ?").run(name);
      const ins = this.db.prepare(
        "INSERT INTO msgs(tokens, text, session, role, ts) VALUES (?, ?, ?, ?, ?)"
      );
      for (const r of rows) ins.run(...(r as [string, string, string, string, string]));
      this.db
        .prepare(
          "INSERT INTO meta(file, size) VALUES (?, ?) ON CONFLICT(file) DO UPDATE SET size = excluded.size"
        )
        .run(file, statSync(file).size);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return rows.length;
  }

  /**
   * 门控检索（F1.4）：FTS5 取候选 → 覆盖率门控（命中的查询词数不足则丢弃）。
   * 返回按相关性排序的前 limit 条。
   */
  search(query: string, limit = 3): L3Hit[] {
    const qTokens = Array.from(new Set(tokenize(query)));
    if (qTokens.length === 0) return [];

    // FTS5 查询串：词元加引号防注入语法，OR 组合保证宽松召回
    const ftsQuery = qTokens.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
    let candidates: any[];
    try {
      candidates = this.db
        .prepare(
          "SELECT text, session, role, ts, bm25(msgs) AS score FROM msgs WHERE tokens MATCH ? ORDER BY score LIMIT ?"
        )
        .all(ftsQuery, limit * 3) as any[];
    } catch {
      return []; // 查询语法异常等，按无结果处理
    }

    // 覆盖率门控：单词查询要求命中 1 个，多词要求至少 L3_MIN_TERM_HITS 个
    const need = Math.min(L3_MIN_TERM_HITS, qTokens.length);
    return candidates
      .filter((c) => {
        const hit = new Set(tokenize(c.text));
        return qTokens.filter((t) => hit.has(t)).length >= need;
      })
      .slice(0, limit)
      .map((c) => ({
        text: c.text as string,
        role: c.role as string,
        ts: c.ts as string,
        session: c.session as string,
        score: c.score as number,
      }));
  }

  /** 关闭数据库连接（session_shutdown 时调用） */
  close(): void {
    try {
      this.db.close();
    } catch {
      // 重复关闭等，忽略
    }
  }
}
