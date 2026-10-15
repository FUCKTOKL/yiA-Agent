/** 本地解析只生成检索文字与定位；阅读器另外读取完整原件。 */
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { BookError, MAX_BOOK_CHARS, MAX_BOOK_SECTIONS, bookFileName, type ParsedBook, type BookSection } from "./store.ts";
import { readEpub, decodeBookText } from "./epub.ts";

async function parseEpub(source: Uint8Array): Promise<ParsedBook> {
  const epub = await readEpub(source), sections: BookSection[] = [];
  let empty = 0;
  for (const [i, chapter] of epub.chapters.entries()) {
    if (chapter.text) sections.push({ text: chapter.text, location: `EPUB 第 ${i + 1} 节 · ${chapter.title}（${chapter.path.slice(0, 180)}）`, anchor: { kind: "epub", section: i + 1, path: chapter.path } });
    else empty++;
  }
  return { title: epub.title, author: epub.author, sections, sectionCount: epub.chapters.length, warnings: empty ? [`${empty} 节未提取到文字，可能是封面或图片；图中文字未收录。`] : [] };
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
      if (text) sections.push({ text, location: `PDF 第 ${i} 页`, anchor: { kind: "pdf", page: i } });
      if (text.length < 40) lowText++;
      chars += text.length; page.cleanup();
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
      const text = decodeBookText(source).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
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
