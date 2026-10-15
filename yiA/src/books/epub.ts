import { posix } from "node:path";
import { crc32 } from "node:zlib";
import { DOMParser, type Document, type Element } from "@xmldom/xmldom";
import { fromBufferPromise } from "yauzl";
import { BookError, MAX_BOOK_CHARS, MAX_BOOK_SECTIONS } from "./store.ts";

export function decodeBookText(data: Uint8Array): string {
  if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder("utf-16le", { fatal: true }).decode(data);
  if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder("utf-16be", { fatal: true }).decode(data);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(data); }
  catch { return new TextDecoder("gb18030", { fatal: true }).decode(data); }
}
export function bookXml(text: string, html = false): Document {
  return new DOMParser({ onError: level => { if (level !== "warning") throw new BookError("EPUB 的目录或正文格式不正确。", 422); } })
    .parseFromString(text, html ? "text/html" : "application/xml");
}
export const bookElements = (doc: Document, name: string): Element[] => Array.from(doc.getElementsByTagName("*")).filter(e => e.localName === name);
export function epubText(doc: Document): string {
  const out: string[] = [];
  const walk = (node: import("@xmldom/xmldom").Node, depth: number) => {
    if (depth > 200) throw new BookError("EPUB 正文嵌套过深，无法安全解析。", 422);
    if (node.nodeType === 3 || node.nodeType === 4) { out.push(node.nodeValue ?? ""); return; }
    const name = (node as Element).localName?.toLowerCase();
    if (["script", "style", "head", "nav", "noscript"].includes(name ?? "")) return;
    const block = /^(p|div|section|article|h[1-6]|br|li|tr|blockquote|pre|hr)$/.test(name ?? "");
    if (block) out.push("\n");
    for (const child of Array.from(node.childNodes)) walk(child, depth + 1);
    if (block) out.push("\n");
  };
  walk(bookElements(doc, "body")[0] ?? doc, 0);
  return out.join("").replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
export function epubPath(base: string, href: string): string {
  if (/^[a-z][\w+.-]*:/i.test(href) || href.startsWith("/") || href.includes("\\")) throw new BookError("EPUB 含不支持的外部正文路径。", 422);
  let decoded: string;
  try { decoded = decodeURIComponent(href.split("#")[0]); }
  catch { throw new BookError("EPUB 目录路径编码不正确。", 422); }
  const path = posix.normalize(posix.join(posix.dirname(base), decoded));
  if (path.startsWith("../") || path.startsWith("/") || path === ".." || path.includes("\0")) throw new BookError("EPUB 目录路径越界。", 422);
  return path;
}
/** 按需读取 ZIP，不落地展开；导入只读文本，阅读资源只取指定的一项。 */
export async function epubFiles(source: Uint8Array, wanted?: string): Promise<Map<string, Buffer>> {
  const zip = await fromBufferPromise(Buffer.from(source.buffer, source.byteOffset, source.byteLength), { lazyEntries: true, autoClose: false, validateEntrySizes: true });
  const files = new Map<string, Buffer>();
  let expanded = 0;
  try {
    if (zip.entryCount > 10000) throw new BookError("EPUB 包含过多文件。", 413);
    for await (const entry of zip.eachEntry()) {
      if (wanted !== undefined ? entry.fileName !== wanted : !/(?:^mimetype$|\.(?:xml|opf|xhtml|html|htm)$)/i.test(entry.fileName)) continue;
      if (entry.isEncrypted()) throw new BookError("不支持加密或受 DRM 保护的 EPUB，请先提供可读取的版本。", 422);
      if (entry.uncompressedSize > 16 * 1024 * 1024 || expanded + entry.uncompressedSize > 40 * 1024 * 1024) throw new BookError("EPUB 解压后的文字过大，已停止读取。", 413);
      const stream = await zip.openReadStreamPromise(entry), parts: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > 16 * 1024 * 1024 || expanded + size > 40 * 1024 * 1024) { stream.destroy(); throw new BookError("EPUB 解压后的内容过大，已停止读取。", 413); }
        parts.push(chunk);
      }
      const bytes = Buffer.concat(parts);
      if (crc32(bytes) !== entry.crc32) throw new BookError("EPUB 文件校验失败，文件可能已经损坏。", 422);
      if (files.has(entry.fileName)) throw new BookError("EPUB 包含重复文件路径。", 422);
      files.set(entry.fileName, bytes); expanded += size;
    }
  } finally { zip.close(); }
  return files;
}
export interface EpubChapter { path: string; title: string; text: string; html: string; }
export interface EpubBook { title: string; author: string; chapters: EpubChapter[]; }
export async function readEpub(source: Uint8Array): Promise<EpubBook> {
  const files = new Map([...await epubFiles(source)].map(([path, bytes]) => [path, decodeBookText(bytes)]));
  if (files.get("mimetype")?.trim() !== "application/epub+zip") throw new BookError("这不是有效的 EPUB 电子书。", 422);
  const container = files.get("META-INF/container.xml");
  const opfPath = container && bookElements(bookXml(container), "rootfile")[0]?.getAttribute("full-path");
  if (!opfPath || !files.has(opfPath)) throw new BookError("EPUB 缺少有效的书籍目录。", 422);
  const opf = bookXml(files.get(opfPath)!);
  const manifest = new Map(bookElements(opf, "item").map(e => [e.getAttribute("id"), e]));
  const spine = bookElements(opf, "itemref").map(e => {
    const item = manifest.get(e.getAttribute("idref"));
    if (!item) throw new BookError("EPUB 阅读顺序引用了不存在的正文。", 422);
    return item;
  });
  const extra = [...manifest.values()].filter(e => /(?:xhtml|html)/.test(e.getAttribute("media-type") ?? "") && !spine.includes(e) && !(e.getAttribute("properties") ?? "").split(/\s+/).includes("nav"));
  const docs = [...spine, ...extra];
  if (!spine.length) throw new BookError("EPUB 没有可读取的阅读顺序。", 422);
  if (docs.length > MAX_BOOK_SECTIONS) throw new BookError("EPUB 超过 2000 节的读取上限。", 413);
  let chars = 0;
  const chapters = docs.map((item, i) => {
    const path = epubPath(opfPath, item.getAttribute("href") ?? ""), html = files.get(path);
    if (html === undefined) throw new BookError("EPUB 缺少正文，或正文格式暂不支持。", 422);
    const doc = bookXml(html, true), text = epubText(doc);
    const title = (bookElements(doc, "h1")[0] ?? bookElements(doc, "h2")[0] ?? bookElements(doc, "title")[0])?.textContent?.trim().slice(0, 100) || `第 ${i + 1} 节`;
    chars += text.length;
    if (chars > MAX_BOOK_CHARS) throw new BookError("EPUB 正文超过 500 万字的读取上限。", 413);
    return { path, html, text, title };
  });
  return { title: bookElements(opf, "title")[0]?.textContent ?? "", author: bookElements(opf, "creator").map(e => e.textContent).join("、"), chapters };
}
