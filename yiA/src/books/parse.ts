/** 本地解析，不调用模型；ZIP 不落地展开，PDF 不执行脚本、不渲染页面。 */
import { fileURLToPath } from "node:url";
import { posix, join } from "node:path";
import { crc32 } from "node:zlib";
import { DOMParser, type Document, type Element } from "@xmldom/xmldom";
import { fromBufferPromise } from "yauzl";
import { BookError, MAX_BOOK_CHARS, MAX_BOOK_SECTIONS, bookFileName, type ParsedBook, type BookSection } from "./store.ts";

function decodeText(data: Uint8Array): string {
  if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder("utf-16le", { fatal: true }).decode(data);
  if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder("utf-16be", { fatal: true }).decode(data);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(data); }
  catch { return new TextDecoder("gb18030", { fatal: true }).decode(data); }
}
function xml(text: string, html = false): Document {
  return new DOMParser({ onError: level => { if (level !== "warning") throw new BookError("EPUB 的目录或正文格式不正确。", 422); } })
    .parseFromString(text, html ? "text/html" : "application/xml");
}
const elements = (doc: Document, name: string): Element[] => Array.from(doc.getElementsByTagName("*")).filter(e => e.localName === name);
function htmlText(doc: Document): string {
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
  walk(elements(doc, "body")[0] ?? doc, 0);
  return out.join("").replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
function epubPath(base: string, href: string): string {
  if (/^[a-z][\w+.-]*:/i.test(href) || href.startsWith("/") || href.includes("\\")) throw new BookError("EPUB 含不支持的外部正文路径。", 422);
  let decoded: string;
  try { decoded = decodeURIComponent(href.split("#")[0]); }
  catch { throw new BookError("EPUB 目录路径编码不正确。", 422); }
  const path = posix.normalize(posix.join(posix.dirname(base), decoded));
  if (path.startsWith("../") || path.startsWith("/") || path === "..") throw new BookError("EPUB 目录路径越界。", 422);
  return path;
}
async function parseEpub(source: Uint8Array): Promise<ParsedBook> {
  const zip = await fromBufferPromise(Buffer.from(source.buffer, source.byteOffset, source.byteLength), { lazyEntries: true, autoClose: false, validateEntrySizes: true });
  const files = new Map<string, string>();
  let expanded = 0;
  try {
    if (zip.entryCount > 10000) throw new BookError("EPUB 包含过多文件。", 413);
    for await (const entry of zip.eachEntry()) {
      if (!/(?:^mimetype$|\.(?:xml|opf|xhtml|html|htm)$)/i.test(entry.fileName)) continue;
      if (entry.isEncrypted()) throw new BookError("不支持加密或受 DRM 保护的 EPUB，请先提供可读取的版本。", 422);
      if (entry.uncompressedSize > 16 * 1024 * 1024 || expanded + entry.uncompressedSize > 40 * 1024 * 1024) throw new BookError("EPUB 解压后的文字过大，已停止导入。", 413);
      const stream = await zip.openReadStreamPromise(entry);
      const parts: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > 16 * 1024 * 1024 || expanded + size > 40 * 1024 * 1024) { stream.destroy(); throw new BookError("EPUB 解压后的文字过大，已停止导入。", 413); }
        parts.push(chunk);
      }
      const bytes = Buffer.concat(parts);
      if (crc32(bytes) !== entry.crc32) throw new BookError("EPUB 文件校验失败，文件可能已经损坏。", 422);
      if (files.has(entry.fileName)) throw new BookError("EPUB 包含重复文件路径。", 422);
      files.set(entry.fileName, decodeText(bytes));
      expanded += size;
    }
  } finally { zip.close(); }
  if (files.get("mimetype")?.trim() !== "application/epub+zip") throw new BookError("这不是有效的 EPUB 电子书。", 422);
  const container = files.get("META-INF/container.xml");
  const opfPath = container && elements(xml(container), "rootfile")[0]?.getAttribute("full-path");
  if (!opfPath || !files.has(opfPath)) throw new BookError("EPUB 缺少有效的书籍目录。", 422);
  const opf = xml(files.get(opfPath)!);
  const manifest = new Map(elements(opf, "item").map(e => [e.getAttribute("id"), e]));
  const spine = elements(opf, "itemref").map(e => {
    const item = manifest.get(e.getAttribute("idref"));
    if (!item) throw new BookError("EPUB 阅读顺序引用了不存在的正文。", 422);
    return item;
  });
  const extra = [...manifest.values()].filter(e => /(?:xhtml|html)/.test(e.getAttribute("media-type") ?? "") && !spine.includes(e) && !(e.getAttribute("properties") ?? "").split(/\s+/).includes("nav"));
  const docs = [...spine, ...extra];
  if (!spine.length) throw new BookError("EPUB 没有可读取的阅读顺序。", 422);
  if (docs.length > MAX_BOOK_SECTIONS) throw new BookError("EPUB 超过 2000 节的导入上限。", 413);
  const sections: BookSection[] = [];
  let chars = 0, empty = 0;
  for (const [i, item] of docs.entries()) {
    const href = epubPath(opfPath, item.getAttribute("href") ?? "");
    const content = files.get(href);
    if (content === undefined) throw new BookError("EPUB 缺少正文，或正文格式暂不支持。", 422);
    const doc = xml(content, true), text = htmlText(doc);
    const heading = (elements(doc, "h1")[0] ?? elements(doc, "h2")[0] ?? elements(doc, "title")[0])?.textContent?.trim().slice(0, 100);
    if (text) sections.push({ text, location: `EPUB 第 ${i + 1} 节${heading ? ` · ${heading}` : ""}（${href.slice(0, 180)}）` });
    else empty++;
    chars += text.length;
    if (chars > MAX_BOOK_CHARS) throw new BookError("EPUB 正文超过 500 万字的导入上限。", 413);
  }
  return {
    title: elements(opf, "title")[0]?.textContent ?? "", author: elements(opf, "creator").map(e => e.textContent).join("、"),
    sections, sectionCount: docs.length, warnings: empty ? [`${empty} 节未提取到文字，可能是封面或图片；图中文字未收录。`] : [],
  };
}
async function parsePdf(source: Uint8Array): Promise<ParsedBook> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const base = fileURLToPath(new URL("../../", import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs")));
  const task = getDocument({
    data: Uint8Array.from(source), cMapUrl: join(base, "cmaps") + "/", cMapPacked: true,
    standardFontDataUrl: join(base, "standard_fonts") + "/", useWorkerFetch: false, useWasm: false,
    disableFontFace: true, useSystemFonts: false, stopAtErrors: true, verbosity: 0,
  });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > MAX_BOOK_SECTIONS) throw new BookError("PDF 超过 2000 页的导入上限。", 413);
    const meta = (await pdf.getMetadata()).info as Record<string, unknown>;
    const sections: BookSection[] = [];
    let chars = 0, lowText = 0;
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i), content = await page.getTextContent();
      const text = content.items.map(t => "str" in t ? t.str + (t.hasEOL ? "\n" : " ") : "").join("")
        .replace(/([\u4e00-\u9fff])[ \t]+(?=[\u4e00-\u9fff])/g, "$1").trim();
      if (text) sections.push({ text, location: `PDF 第 ${i} 页` });
      if (text.length < 40) lowText++;
      chars += text.length;
      page.cleanup();
      if (chars > MAX_BOOK_CHARS) throw new BookError("PDF 正文超过 500 万字的导入上限。", 413);
    }
    return {
      title: typeof meta.Title === "string" ? meta.Title : "", author: typeof meta.Author === "string" ? meta.Author : "",
      sections, sectionCount: pdf.numPages,
      warnings: lowText ? [`${lowText} 页文字很少或为空，可能是封面、图片或扫描页；仅能检索已提取的文字。`] : [],
    };
  } catch (e) {
    if (e instanceof Error && e.name === "PasswordException") throw new BookError("PDF 需要密码，请先在本机解密后再导入。", 422);
    throw e;
  } finally { await task.destroy(); }
}
export async function parseBook(source: Uint8Array, name: string): Promise<ParsedBook> {
  const { format } = bookFileName(name);
  try {
    let parsed: ParsedBook;
    if (format === "pdf") parsed = await parsePdf(source);
    else if (format === "epub") parsed = await parseEpub(source);
    else {
      const text = decodeText(source).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new BookError("文件含二进制内容，请提供真正的文字文件。", 422);
      parsed = { title: "", author: "", sections: [{ text, location: "文字原文" }], sectionCount: 1, warnings: [] };
    }
    if (!parsed.sections.some(s => s.text.trim())) throw new BookError("没有提取到可检索的文字；扫描版 PDF 请先进行文字识别（OCR）。", 422);
    if (parsed.sections.reduce((n, s) => n + s.text.length, 0) > MAX_BOOK_CHARS) throw new BookError("书籍正文超过 500 万字的导入上限。", 413);
    return parsed;
  } catch (e) {
    if (e instanceof BookError) throw e;
    throw new BookError(`${format.toUpperCase()} 解析失败，文件可能已损坏、加密或不是所标注的格式。`, 422);
  }
}
