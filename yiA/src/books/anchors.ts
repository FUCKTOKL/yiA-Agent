/** 阅读定位与检索文字分离；旧片段只回填已有出处，不猜测页码/字符位置。 */
export type BookAnchor =
  | { kind: "pdf"; page: number; offset?: number }
  | { kind: "epub"; section: number; path?: string; offset?: number }
  | { kind: "text"; line: number; endLine: number; offset?: number }
  | { kind: "unknown" };
export const normalizeBookText = (text: string) => text.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
export function legacyAnchor(location: string): BookAnchor {
  let m = location.match(/^PDF 第 ([1-9]\d*) 页$/);
  if (m) return { kind: "pdf", page: Number(m[1]) };
  m = location.match(/^EPUB 第 ([1-9]\d*) 节/);
  if (m) return { kind: "epub", section: Number(m[1]) };
  m = location.match(/^第 ([1-9]\d*)[–-]([1-9]\d*) 行$/);
  if (m) return { kind: "text", line: Number(m[1]), endLine: Number(m[2]) };
  return { kind: "unknown" };
}
export function readAnchor(raw: string, location: string): BookAnchor {
  let a: Record<string, unknown>;
  try { a = JSON.parse(raw); } catch { throw new Error("书籍定位数据损坏，请从备份恢复。"); }
  if (!a || typeof a !== "object") throw new Error("书籍定位数据损坏，请从备份恢复。");
  if (!a.kind) return legacyAnchor(location);
  const positive = (n: unknown) => Number.isSafeInteger(n) && Number(n) > 0;
  if (a.offset !== undefined && (!Number.isSafeInteger(a.offset) || Number(a.offset) < 0)) throw new Error("书籍定位偏移不正确。");
  if (a.kind === "unknown" || (a.kind === "pdf" && positive(a.page)) || (a.kind === "epub" && positive(a.section) && (a.path === undefined || typeof a.path === "string")) || (a.kind === "text" && positive(a.line) && positive(a.endLine) && Number(a.endLine) >= Number(a.line))) {
    // SAFETY: 上面的分支校验了 BookAnchor 各变体需要的属性和数值范围。
    return a as BookAnchor;
  }
  throw new Error("书籍定位信息不正确。");
}
