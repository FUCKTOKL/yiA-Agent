/** 独立书籍库：原文件、原文片段与 FTS5 索引在同一事务中落盘，不混入 L2。 */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tokenize } from "../memory/l2/tokenizer.ts";

export const MAX_BOOK_BYTES = 50 * 1024 * 1024;
export const MAX_BOOK_CHARS = 5_000_000;
export const MAX_BOOK_SECTIONS = 2_000;
export const BOOK_ID = /^bk_[a-f0-9]{24}$/;
export type BookFormat = "pdf" | "epub" | "txt" | "md";
export class BookError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.name = "BookError"; this.status = status; }
}
export interface BookSection { text: string; location: string; }
export interface ParsedBook {
  title: string; author: string; sections: BookSection[]; sectionCount: number; warnings: string[];
}
export interface Book {
  id: string; title: string; author: string; format: BookFormat; sourceName: string;
  byteSize: number; charCount: number; sectionCount: number; passageCount: number;
  createdAt: string; warnings: string[];
}
export interface BookHit {
  bookId: string; title: string; author: string; passage: number; location: string; text: string; warnings: string[];
}
export interface BookPassage { passage: number; location: string; text: string; }

export function bookFileName(name: string): { name: string; format: BookFormat } {
  const base = name.replaceAll("\\", "/").split("/").pop()?.replace(/[\x00-\x1f\x7f]/g, "").trim() ?? "";
  const ext = base.match(/\.([a-z]+)$/i)?.[1].toLowerCase();
  if (!base || base.length > 240 || !ext || !["pdf", "epub", "txt", "md", "markdown"].includes(ext)) {
    throw new BookError("请选择 PDF、EPUB、TXT 或 Markdown 文件。", 415);
  }
  return { name: base, format: (ext === "markdown" ? "md" : ext) as BookFormat };
}
export const bookHash = (source: Uint8Array) => createHash("sha256").update(source).digest("hex");
function warningList(raw: string): string[] {
  try {
    const warnings = JSON.parse(raw);
    if (!Array.isArray(warnings) || warnings.some(w => typeof w !== "string")) throw new Error("invalid warnings");
    return warnings;
  } catch { throw new BookError("书籍元数据损坏，请从备份恢复，不要删除数据库。", 503); }
}
const bookRow = (row: unknown): Book => {
  const r = row as Omit<Book, "warnings"> & { warnings: string };
  return { ...r, warnings: warningList(r.warnings) };
};

/** 1200 字一段，重叠 160 字；不跨 PDF 页/EPUB 章节，以免出处失真。 */
function chunks(section: BookSection): { text: string; location: string }[] {
  const out: { text: string; location: string }[] = [];
  const text = section.text.replace(/\r\n?/g, "\n");
  let line = 1;
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 1200, text.length);
    if (end < text.length) {
      const line = text.lastIndexOf("\n", end);
      if (line > start + 700) end = line + 1;
      if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    }
    const part = text.slice(start, end).trim();
    const location = section.location === "文字原文"
      ? `第 ${line}–${line + text.slice(start, end).split("\n").length - 1} 行`
      : section.location;
    if (part) out.push({ text: part, location });
    if (end === text.length) break;
    let next = end - 160;
    if (/[\uDC00-\uDFFF]/.test(text[next])) next++;
    line += text.slice(start, next).split("\n").length - 1;
    start = next;
  }
  return out;
}

function indexTokens(text: string): string {
  const normalized = text.normalize("NFKC").replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, "$1");
  // 单字也入索引，否则中文单字查询无法命中连续正文中的那个字。
  return [...tokenize(normalized), ...(normalized.match(/[\u4e00-\u9fff]/g) ?? [])].join(" ");
}

export class BookStore {
  private db: DatabaseSync;
  private closed = false;
  constructor(root: string) {
    const dir = join(root, "runtime", "books");
    mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(join(dir, "library.db"));
    try {
      this.db.exec(`
        PRAGMA busy_timeout=5000;
        PRAGMA journal_mode=WAL;
        PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS books(
          id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, title TEXT NOT NULL, author TEXT NOT NULL,
          format TEXT NOT NULL, sourceName TEXT NOT NULL, byteSize INTEGER NOT NULL,
          charCount INTEGER NOT NULL, sectionCount INTEGER NOT NULL, passageCount INTEGER NOT NULL,
          createdAt TEXT NOT NULL, warnings TEXT NOT NULL, source BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS passages(
          id INTEGER PRIMARY KEY, bookId TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
          passage INTEGER NOT NULL, location TEXT NOT NULL, text TEXT NOT NULL, tokens TEXT NOT NULL,
          UNIQUE(bookId, passage)
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS book_fts USING fts5(tokens, content='passages', content_rowid='id');
        CREATE TRIGGER IF NOT EXISTS book_passage_add AFTER INSERT ON passages BEGIN
          INSERT INTO book_fts(rowid,tokens) VALUES(new.id,new.tokens);
        END;
        CREATE TRIGGER IF NOT EXISTS book_passage_delete AFTER DELETE ON passages BEGIN
          INSERT INTO book_fts(book_fts,rowid,tokens) VALUES('delete',old.id,old.tokens);
        END;
      `);
    } catch (e) { this.db.close(); throw e; }
  }
  list(): Book[] {
    return this.db.prepare("SELECT id,title,author,format,sourceName,byteSize,charCount,sectionCount,passageCount,createdAt,warnings FROM books ORDER BY createdAt DESC,id").all().map(bookRow);
  }
  get(id: string): Book | undefined {
    const row = this.db.prepare("SELECT id,title,author,format,sourceName,byteSize,charCount,sectionCount,passageCount,createdAt,warnings FROM books WHERE id=?").get(id);
    return row ? bookRow(row) : undefined;
  }
  byHash(hash: string): Book | undefined {
    const row = this.db.prepare("SELECT id,title,author,format,sourceName,byteSize,charCount,sectionCount,passageCount,createdAt,warnings FROM books WHERE hash=?").get(hash);
    return row ? bookRow(row) : undefined;
  }
  add(source: Uint8Array, name: string, parsed: ParsedBook): { book: Book; duplicate: boolean } {
    const file = bookFileName(name), hash = bookHash(source);
    if (!source.length || source.length > MAX_BOOK_BYTES) throw new BookError("文件为空或超过 50 MB。", 413);
    const charCount = parsed.sections.reduce((n, s) => n + s.text.length, 0);
    if (!charCount) throw new BookError("没有提取到可检索的文字；扫描件请先进行文字识别。", 422);
    if (charCount > MAX_BOOK_CHARS || parsed.sectionCount > MAX_BOOK_SECTIONS) throw new BookError("书籍超过 500 万字或 2000 页/章的导入上限。", 413);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const known = this.byHash(hash);
      if (known) { this.db.exec("COMMIT"); return { book: known, duplicate: true }; }
      const parts = parsed.sections.flatMap(chunks);
      if (!parts.length) throw new BookError("文件中没有可检索的正文。", 422);
      const book: Book = {
        id: `bk_${hash.slice(0, 24)}`, title: parsed.title.trim().slice(0, 200) || file.name.replace(/\.[^.]+$/, ""),
        author: parsed.author.trim().slice(0, 200), format: file.format, sourceName: file.name,
        byteSize: source.length, charCount, sectionCount: parsed.sectionCount, passageCount: parts.length,
        createdAt: new Date().toISOString(), warnings: parsed.warnings,
      };
      this.db.prepare("INSERT INTO books VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
        book.id, hash, book.title, book.author, book.format, book.sourceName, book.byteSize,
        book.charCount, book.sectionCount, book.passageCount, book.createdAt, JSON.stringify(book.warnings), source,
      );
      const ins = this.db.prepare("INSERT INTO passages(bookId,passage,location,text,tokens) VALUES(?,?,?,?,?)");
      for (const [i, p] of parts.entries()) ins.run(book.id, i + 1, p.location, p.text, indexTokens(p.text));
      this.db.exec("COMMIT");
      return { book, duplicate: false };
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  search(query: string, bookId?: string, limit = 20): BookHit[] {
    if (query.length > 200) throw new BookError("关键词请控制在 200 字以内。", 400);
    if (bookId && !BOOK_ID.test(bookId)) throw new BookError("书籍编号不正确。", 400);
    const terms = [...new Set(tokenize(query.normalize("NFKC")))];
    if (!terms.length) return [];
    if (terms.length > 64) throw new BookError("关键词太多，请缩小检索范围。", 400);
    // AND 要求所有关键词都出现；引号及参数绑定阻止 FTS/SQL 注入。
    const match = terms.map(t => `"${t}"`).join(" AND ");
    // SAFETY: SELECT 字段来自 NOT NULL 列；warnings 的 JSON 字符串在下方校验后才返回。
    const rows = this.db.prepare(`
      SELECT p.bookId,b.title,b.author,p.passage,p.location,p.text,b.warnings
      FROM book_fts JOIN passages p ON p.id=book_fts.rowid JOIN books b ON b.id=p.bookId
      WHERE book_fts MATCH ? AND (? IS NULL OR p.bookId=?)
      ORDER BY bm25(book_fts),p.bookId,p.passage LIMIT ?
    `).all(match, bookId ?? null, bookId ?? null, Math.max(1, Math.min(50, Math.trunc(limit) || 20))) as unknown as (Omit<BookHit, "warnings"> & { warnings: string })[];
    return rows.map(r => {
      const warnings = warningList(r.warnings), lower = r.text.toLowerCase();
      const positions = terms.map(t => lower.indexOf(t)).filter(i => i >= 0);
      // 全角字/跨行命中无法直接对应原文偏移时，返回完整的一段（上限 1200 字）。
      if (!positions.length) return { ...r, warnings };
      const start = Math.max(0, Math.min(...positions) - 100), end = Math.min(r.text.length, start + 420);
      return { ...r, warnings, text: (start ? "…" : "") + r.text.slice(start, end) + (end < r.text.length ? "…" : "") };
    });
  }
  passage(bookId: string, passage: number): BookPassage | undefined {
    // SAFETY: SELECT 只返回 passage/location/text 的 NOT NULL 列，和 BookPassage 对应。
    return this.db.prepare("SELECT passage,location,text FROM passages WHERE bookId=? AND passage=?").get(bookId, passage) as unknown as BookPassage | undefined;
  }
  original(id: string): Uint8Array | undefined {
    return (this.db.prepare("SELECT source FROM books WHERE id=?").get(id) as { source: Uint8Array } | undefined)?.source;
  }
  delete(id: string): boolean { return Number(this.db.prepare("DELETE FROM books WHERE id=?").run(id).changes) > 0; }
  close(): void { if (!this.closed) { this.db.close(); this.closed = true; } }
}
