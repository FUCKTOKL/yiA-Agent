/** 原件阅读视图。EPUB/Markdown 保留结构，放在无脚本沙箱里，不把原书 HTML 注入应用 DOM。 */
import { XMLSerializer, type Document } from "@xmldom/xmldom";
import { Marked, type Token, type TokensList } from "marked";
import { extname } from "node:path";
import { BookError, type Book, type BookStore } from "./store.ts";
import { readEpub, epubFiles, epubPath, bookXml, bookElements, decodeBookText, type EpubBook } from "./epub.ts";
import { normalizeBookText } from "./anchors.ts";

export interface ReaderUnit { index: number; title: string; path?: string; line?: number; endLine?: number; offset?: number; endOffset?: number; }
interface TextPart { unit: ReaderUnit; html: () => string; }
interface PreviewEntry { source: Uint8Array; epub?: EpubBook; parts?: TextPart[]; }
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const epubAssetUrl = (id: string, path: string) => `/api/books/${id}/assets/${path.split("/").map(encodeURIComponent).join("/")}`;
const MIME: Record<string, string> = { ".css": "text/css; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf" };
function resourceUrl(id: string, base: string, href: string): string {
  if (/^data:image\/(png|jpeg|gif|webp|avif);base64,/i.test(href)) return href;
  if (href.startsWith("#")) return href;
  try { return epubAssetUrl(id, epubPath(base, href)) + (href.includes("#") ? "#" + encodeURIComponent(href.split("#")[1]) : ""); }
  catch { return ""; }
}
export function bookCss(css: string, id: string, base: string): string {
  return css.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi, (_all, a, b, c) => `url("${resourceUrl(id, base, (a ?? b ?? c).trim()).replace(/"/g, "%22")}")`)
    .replace(/@import\s+["']([^"']+)["']/gi, (_all, href) => `@import url("${resourceUrl(id, base, href)}")`);
}
function cleanDocument(doc: Document, id: string, base: string, chapters: ReaderUnit[]): { body: string; styles: string } {
  const body = bookElements(doc, "body")[0] ?? doc.documentElement;
  if (!body) throw new BookError("原书没有可显示的正文。", 422);
  const styles: string[] = [];
  for (const style of bookElements(doc, "style")) styles.push(`<style>${bookCss(style.textContent ?? "", id, base).replace(/<\/style/gi, "<\\/style")}</style>`);
  for (const link of bookElements(doc, "link")) if ((link.getAttribute("rel") ?? "").toLowerCase() === "stylesheet") {
    const href = resourceUrl(id, base, link.getAttribute("href") ?? "");
    if (href) styles.push(`<link rel="stylesheet" href="${escape(href)}">`);
  }
  for (const el of [body, ...Array.from(body.getElementsByTagName("*"))]) {
    const tag = el.localName?.toLowerCase();
    if (["script", "style", "iframe", "object", "embed", "form", "input", "button", "textarea", "select", "meta", "base", "link", "template"].includes(tag ?? "")) { el.parentNode?.removeChild(el); continue; }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on") || name.startsWith("data-yia-") || ["srcdoc", "srcset", "action", "formaction", "target", "download", "ping", "autofocus", "autoplay", "contenteditable"].includes(name)) { el.removeAttribute(attr.name); continue; }
      if (name === "style") el.setAttribute(attr.name, bookCss(attr.value, id, base));
      if (["src", "poster", "background"].includes(name) || ((name === "href" || name === "xlink:href") && tag !== "a")) {
        const url = resourceUrl(id, base, attr.value); if (url) el.setAttribute(attr.name, url); else el.removeAttribute(attr.name);
      }
      if (name === "href" && tag === "a") {
        const href = attr.value;
        el.removeAttribute("href");
        try {
          const path = href.startsWith("#") ? base : epubPath(base, href);
          const index = chapters.findIndex(c => c.path === path), fragment = href.includes("#") ? href.split("#")[1] : "";
          if (index >= 0 || href.startsWith("#")) {
            el.setAttribute("href", "#" + fragment); el.setAttribute("data-yia-section", String(index >= 0 ? index + 1 : 0));
          }
        } catch { /* 外部链接只保留文字，不导航到原书之外。 */ }
      }
    }
  }
  return { body: new XMLSerializer().serializeToString(body), styles: styles.join("\n") };
}
const BASE_STYLE = `html{color-scheme:light;background:#fff;color:#24211d;font-size:18px}body{margin:0;padding:28px 32px;line-height:1.85;overflow-wrap:anywhere;font-family:system-ui,"Microsoft YaHei",sans-serif}h1{font-size:2em;line-height:1.3;margin:1em 0 .7em}h2{font-size:1.55em;line-height:1.4;margin:1.2em 0 .6em}h3{font-size:1.25em;line-height:1.5;margin:1em 0 .6em}p{margin:.8em 0}img,svg{max-width:100%;height:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f3ee;padding:16px;border-radius:6px}blockquote{margin:1em 0;padding-left:18px;border-left:3px solid #bdb7aa;color:#625b51}table{border-collapse:collapse;max-width:100%}td,th{border:1px solid #ccc;padding:7px}a{color:#526955}.yia-target{outline:2px solid #c6a958!important;outline-offset:4px;background-color:#fff4ce!important}.yia-line{display:block;white-space:pre-wrap;min-height:1.85em;padding-left:3.5em;position:relative}.yia-line:before{content:attr(data-line);position:absolute;left:0;width:2.5em;text-align:right;color:#aaa;font:12px/2.8 monospace}@media(max-width:500px){body{padding:20px 18px}}`;
function documentHtml(id: string, unit: number, body: string, styles = ""): string {
  return `<!doctype html><html data-yia-reader="${id}" data-yia-unit="${unit}" lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${BASE_STYLE}</style>${styles}</head>${body}</html>`;
}
function textParts(text: string, markdown: boolean): TextPart[] {
  const parts: TextPart[] = [];
  if (!markdown) {
    const lines = text.split("\n"); let offset = 0;
    for (let start = 0; start < lines.length; start += 200) {
      const batch = lines.slice(start, start + 200), raw = batch.join("\n"), end = start + batch.length;
      parts.push({ unit: { index: parts.length + 1, title: `第 ${start + 1}–${end} 行`, line: start + 1, endLine: end, offset, endOffset: offset + normalizeBookText(raw).length }, html: () => `<body>${batch.map((l, i) => `<span class="yia-line" data-line="${start + i + 1}">${escape(l)}</span>`).join("\n")}</body>` });
      offset += normalizeBookText(raw).length;
    }
    return parts;
  }
  const parser = new Marked({ renderer: { html: ({ text: raw }) => escape(raw) } });
  const tokens = parser.lexer(text);
  let cursor = 0, line = 1, startLine = 1, length = 0, blocks: string[] = [], title = "";
  const flush = () => {
    if (!blocks.length) return;
    const html = `<body>${blocks.join("\n")}</body>`;
    parts.push({ unit: { index: parts.length + 1, title: title || `第 ${startLine}–${line} 行`, line: startLine, endLine: line }, html: () => html });
    blocks = []; length = 0; title = ""; startLine = line;
  };
  for (const token of tokens) {
    const at = text.indexOf(token.raw, cursor); if (at < 0) continue;
    line += text.slice(cursor, at).split("\n").length - 1;
    if (length > 24000) flush();
    if (!blocks.length) startLine = line;
    const endLine = line + token.raw.split("\n").length - 1;
    const single = Object.assign([token] as Token[], { links: tokens.links }) as TokensList;
    const html = parser.parser(single);
    blocks.push(`<div data-line-start="${line}" data-line-end="${endLine}">${html}</div>`);
    if (!title && token.type === "heading") title = token.text.replace(/[*_`]/g, "").slice(0, 100);
    line = endLine; cursor = at + token.raw.length; length += token.raw.length;
  }
  flush(); return parts;
}

export class BookPreview {
  private cached: { id: string; value: Promise<PreviewEntry> } | undefined;
  clear(id?: string): void { if (!id || this.cached?.id === id) this.cached = undefined; }
  private entry(book: Book, store: BookStore): Promise<PreviewEntry> {
    if (this.cached?.id === book.id) return this.cached.value;
    const value = (async () => {
      const source = store.original(book.id); if (!source) throw new BookError("原文件不存在。", 404);
      if (book.format === "epub") return { source, epub: await readEpub(source) };
      const text = decodeBookText(source).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
      return { source, parts: textParts(text, book.format === "md") };
    })();
    this.cached = { id: book.id, value };
    value.catch(() => { if (this.cached?.value === value) this.cached = undefined; });
    return value;
  }
  async info(book: Book, store: BookStore): Promise<{ format: string; units: ReaderUnit[] }> {
    if (book.format === "pdf") return { format: "pdf", units: [] };
    const entry = await this.entry(book, store);
    return { format: book.format, units: entry.epub ? entry.epub.chapters.map((c, i) => ({ index: i + 1, title: c.title, path: c.path })) : entry.parts!.map(p => p.unit) };
  }
  async document(book: Book, store: BookStore, unit: number): Promise<string> {
    const entry = await this.entry(book, store);
    if (entry.epub) {
      const chapter = entry.epub.chapters[unit - 1]; if (!chapter) throw new BookError("没有这个原书章节。", 404);
      const chapters = entry.epub.chapters.map((c, i) => ({ index: i + 1, title: c.title, path: c.path }));
      const cleaned = cleanDocument(bookXml(chapter.html, true), book.id, chapter.path, chapters);
      return documentHtml(book.id, unit, cleaned.body, cleaned.styles);
    }
    const part = entry.parts?.[unit - 1]; if (!part) throw new BookError("没有这个原书阅读单元。", 404);
    const doc = bookXml(part.html(), true);
    // Markdown 生成的结构无原书资源包；外链、事件、脚本同样移除。
    const cleaned = cleanDocument(doc, book.id, "document.md", []);
    return documentHtml(book.id, unit, cleaned.body);
  }
  async asset(book: Book, store: BookStore, path: string): Promise<{ mime: string; data: Buffer }> {
    if (book.format !== "epub" || path.length > 1000 || path.split("/").some(p => !p || p === "." || p === "..") || path.includes("\\") || path.includes("\0")) throw new BookError("资源路径不正确。", 400);
    const mime = MIME[extname(path).toLowerCase()]; if (!mime) throw new BookError("不支持显示这种原书资源。", 415);
    const { source } = await this.entry(book, store), files = await epubFiles(source, path), bytes = files.get(path);
    if (!bytes) throw new BookError("原书中没有这个资源。", 404);
    return { mime, data: mime.startsWith("text/css") ? Buffer.from(bookCss(decodeBookText(bytes), book.id, path)) : bytes };
  }
}
