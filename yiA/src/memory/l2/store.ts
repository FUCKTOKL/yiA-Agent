/**
 * L2 知识库存储层：人类可读的 Markdown 条目 + BM25 检索 + 自动关联。
 *
 * 存储形态（runtime/l2/entries/<id>.md）：
 * ```
 * ---
 * id: 20260911-a1b2c3        ← 时间戳 + 随机后缀，全局唯一
 * title: "条目标题"
 * tags: ["标签1","标签2"]
 * links: ["20260911-xxxxxx"]  ← 自动关联的条目 id（双向）
 * created: "2026-09-11T12:00:00.000Z"
 * ---
 * 正文内容（自由 Markdown）……
 * ```
 *
 * 检索保留内存索引；目录变化时刷新。所有写入先取得跨进程锁并重读最新数据，
 * 用临时文件原子替换 Markdown，避免旧缓存覆盖其他通道的修改。
 * ponytail: 冷启动首次 all() 需读全部文件（万条约数秒）；过慢时加 index.json 持久化。
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { buildDoc, rankDocs } from "./bm25.ts";
import type { Doc, ScoredEntry } from "./bm25.ts";

/** 一条 L2 记忆条目（解析后的结构化形式） */
export interface L2Entry {
  id: string;
  title: string;
  tags: string[];
  links: string[];   // 关联条目 id（双向链接）
  created: string;   // ISO 时间
  content: string;   // 正文
  path: string;      // 对应 md 文件的绝对路径
  version: string;   // 文件内容指纹，用于拒绝过期网页编辑
}

export class MemoryConflictError extends Error {
  constructor() {
    super("这条记忆已被其他通道修改，请重新打开最新内容后再保存。您的编辑尚未覆盖原文。");
    this.name = "MemoryConflictError";
  }
}

/** 自动关联门槛：查询词元覆盖率（BM25 无关规模的 0~1 值）不低于此才建链。
 *  校准：相关对 ≈0.24，无关 = 0。ponytail: 噪声多时调高 */
export const LINK_COVERAGE = 0.15;

/** 匹配文件头部的 frontmatter 块（--- 包裹的元数据） */
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n/;

export class L2Store {
  /** 条目目录：<项目根>/runtime/l2/entries/ */
  readonly dir: string;
  /** 内存索引缓存：null 表示尚未从磁盘加载 */
  private docs: Doc[] | null = null;
  private directoryStamp: bigint | undefined;
  private revision = "";
  private writing = false;

  constructor(projectRoot: string) {
    this.dir = join(projectRoot, "runtime", "l2", "entries");
    mkdirSync(this.dir, { recursive: true }); // 首次使用时自动创建
  }

  /**
   * 存一条记忆并自动关联（F1.2）：
   * 用新条目内容检索旧条目，覆盖率达标的建立双向链接。
   */
  save(content: string, title?: string, tags: string[] = []): L2Entry {
    return this.withWriteLock(() => {
      const entry = this.write({
        id: newId(),
        title: title?.trim() || content.trim().split("\n")[0].slice(0, 50),
        tags,
        links: [],
        created: new Date().toISOString(),
        content: content.trim(),
      });

      const others = (this.docs ?? []).filter((d) => d.entry.id !== entry.id);
      const related = rankDocs(others, `${entry.title} ${entry.content}`, 2)
        .filter((r) => r.coverage >= LINK_COVERAGE)
        .map((r) => r.id);
      if (related.length > 0) {
        this.setLinks(entry.id, related);
        for (const d of this.docs ?? []) {
          if (related.includes(d.entry.id) && !d.entry.links.includes(entry.id)) {
            this.setLinks(d.entry.id, [...d.entry.links, entry.id]);
          }
        }
      }
      return this.byId(entry.id)!;
    });
  }

  /**
   * refine（F1.6 基础）：修改既有条目的正文/标题/标签，保留 id 与创建时间。
   * 返回更新后的条目；id 不存在返回 null。
   */
  refine(id: string, patch: { content?: string; title?: string; tags?: string[]; expectedVersion?: string }): L2Entry | null {
    return this.withWriteLock(() => {
      const old = this.byId(id);
      if (!old) return null;
      if (patch.expectedVersion !== undefined && patch.expectedVersion !== old.version) throw new MemoryConflictError();
      return this.write({
        ...old,
        content: patch.content?.trim() ?? old.content,
        title: patch.title?.trim() || old.title,
        tags: patch.tags ?? old.tags,
      });
    });
  }

  /** 读取全部条目，按创建时间倒序（新→旧） */
  all(): L2Entry[] {
    this.ensureFresh();
    return (this.docs as Doc[]).map((d) => d.entry);
  }

  /** 强制重读磁盘（Web 场景：对话经 agent 写入新条目，长驻进程的内存索引会过期） */
  reload(): void {
    this.loadFromDisk();
  }

  /** 按 id 查条目；不存在返回 null */
  byId(id: string): L2Entry | null {
    this.ensureFresh();
    return (this.docs as Doc[]).find((d) => d.entry.id === id)?.entry ?? null;
  }

  /** 删除条目：移除文件 + 清除其他条目 links 里对本 id 的反向引用（防悬空链接） */
  delete(id: string): boolean {
    return this.withWriteLock(() => {
      if (!this.byId(id)) return false;
      for (const e of this.all()) {
        if (e.links.includes(id)) this.setLinks(e.id, e.links.filter((l) => l !== id));
      }
      try {
        rmSync(join(this.dir, `${id}.md`));
      } catch {
        return false;
      }
      this.docs = (this.docs as Doc[]).filter((d) => d.entry.id !== id);
      return true;
    });
  }

  /**
   * 关键词检索：BM25 打分取前 limit 条。
   * 查询为空时直接返回最新 limit 条（浏览最近记忆）。
   */
  search(query: string, limit = 5): ScoredEntry[] {
    this.ensureFresh();
    if (!query.trim()) {
      return (this.docs as Doc[])
        .slice(0, limit)
        .map((d) => ({ ...d.entry, score: 0, coverage: 0 }));
    }
    return rankDocs(this.docs as Doc[], query, limit);
  }

  /** SQLite 仅用作跨进程互斥锁；记忆仍存 Markdown，不做数据迁移。 */
  private withWriteLock<T>(operation: () => T): T {
    const lock = new DatabaseSync(join(dirname(this.dir), "write-lock.db"));
    let locked = false;
    try {
      lock.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE");
      locked = true;
      // 前后各换一次标记，读取者即使撞上写入中间也会在下次调用刷新。
      writeFileSync(join(dirname(this.dir), "revision"), randomUUID(), "utf8");
      this.loadFromDisk();
      this.writing = true;
      return operation();
    } finally {
      this.writing = false;
      this.docs = null;
      try {
        if (locked) writeFileSync(join(dirname(this.dir), "revision"), randomUUID(), "utf8");
      } finally {
        try {
          if (locked) lock.exec("ROLLBACK");
        } finally {
          lock.close();
        }
      }
    }
  }

  private readRevision(): string {
    try {
      return readFileSync(join(dirname(this.dir), "revision"), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw e;
    }
  }

  private ensureFresh(): void {
    if (this.writing) return;
    // 版本标记不依赖文件系统时间精度；目录时间额外捕获手工新增/删除及中断写入。
    if (this.docs === null || this.revision !== this.readRevision() ||
        this.directoryStamp !== statSync(this.dir, { bigint: true }).mtimeNs) this.loadFromDisk();
  }

  /** 扫描前记版本：若扫描期间其他进程更新，下次读取仍会刷新。 */
  private loadFromDisk(): void {
    this.revision = this.readRevision();
    this.directoryStamp = statSync(this.dir, { bigint: true }).mtimeNs;
    this.docs = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".md")) continue;
      const entry = this.parse(join(this.dir, f));
      if (entry) this.docs.push(buildDoc(entry));
    }
    // 按创建时间倒序（新→旧）
    this.docs.sort((a, b) => b.entry.created.localeCompare(a.entry.created));
  }

  /** 直接覆写某个条目的 links 字段（重写文件，frontmatter 会规整化） */
  private setLinks(id: string, links: string[]): void {
    const entry = this.byId(id);
    if (entry) this.write({ ...entry, links });
  }

  /** 按条目字段完整重写文件并同步内存索引（save/refine/setLinks 共用） */
  private write(e: Omit<L2Entry, "path" | "version">): L2Entry {
    const head = [
      "---",
      `id: ${e.id}`,
      `title: ${JSON.stringify(e.title)}`,
      `tags: ${JSON.stringify(e.tags)}`,
      `links: ${JSON.stringify(e.links)}`,
      `created: ${e.created}`,
      "---",
      "",
    ].join("\n");
    const raw = head + e.content + "\n";
    const path = join(this.dir, `${e.id}.md`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, raw, { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
    const entry: L2Entry = { ...e, path, version: createHash("sha256").update(raw).digest("hex") };

    // 同步内存索引：存在则原位替换，否则插到最前（新条目创建时间最新）
    if (this.docs === null) {
      this.loadFromDisk();
      return this.byId(e.id)!;
    }
    const doc = buildDoc(entry);
    const i = this.docs.findIndex((d) => d.entry.id === e.id);
    if (i >= 0) this.docs[i] = doc;
    else this.docs.unshift(doc);
    return entry;
  }

  /** 解析单个 md 文件为条目；文件损坏/被删则返回 null 跳过 */
  private parse(file: string): L2Entry | null {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      return null;
    }
    const m = raw.match(FRONTMATTER_RE);
    if (!m) return null;

    // 逐行拆 "key: value"，值再用 safeJson 解码（兼容手工编辑）
    const meta: Record<string, string> = {};
    for (const line of m[1].split("\n")) {
      const i = line.indexOf(": ");
      if (i > 0) meta[line.slice(0, i)] = line.slice(i + 2);
    }

    return {
      id: meta.id ?? file,
      title: safeJsonString(meta.title) ?? "(untitled)",
      tags: safeJsonArray(meta.tags),
      links: safeJsonArray(meta.links),
      created: meta.created ?? "",
      content: raw.slice(m[0].length).trim(), // frontmatter 之后是正文
      path: file,
      version: createHash("sha256").update(raw).digest("hex"),
    };
  }
}

/** 生成条目 id：日期时间 + 随机后缀，可读且几乎不冲突 */
function newId(): string {
  return (
    new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14) +
    "-" +
    Math.random().toString(36).slice(2, 8)
  );
}

/** 解出 JSON 字符串值；非 JSON 时原样返回（兼容手工编辑的 frontmatter） */
function safeJsonString(s: string | undefined): string | null {
  if (s === undefined) return null;
  try {
    const v = JSON.parse(s);
    return typeof v === "string" ? v : null;
  } catch {
    return s;
  }
}

/** 解出 JSON 字符串数组；异常时返回空数组 */
function safeJsonArray(s: string | undefined): string[] {
  if (s === undefined) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
