import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BookStore, BookError } from "../src/books/store.ts";
import { legacyAnchor, readAnchor, normalizeBookText } from "../src/books/anchors.ts";
import { BookPreview } from "../src/books/preview.ts";
import { parseBook } from "../src/books/parse.ts";
import { importBook } from "../src/books/import.ts";
import { bookXml } from "../src/books/epub.ts";
import { createYiaServer } from "../src/server/server.ts";
import { Logger } from "../src/logger.ts";
import { pdfPagesFixture, epubReaderFixture } from "./book-fixtures.ts";
const temp = () => mkdtempSync(join(tmpdir(), "yia-book-reader-"));
function oldSchema(root: string) { const db = new DatabaseSync(join(root, "runtime", "books", "library.db")); db.exec("ALTER TABLE passages DROP COLUMN anchor"); db.close(); }

test("定位格式：旧出处只回填已有页/节/行，不伪造未知位置，损坏定位有错误", () => {
  assert.deepEqual(legacyAnchor("PDF 第 18 页"), { kind: "pdf", page: 18 });
  assert.deepEqual(legacyAnchor("EPUB 第 3 节 · 第一章（OPS/a.xhtml）"), { kind: "epub", section: 3 });
  assert.deepEqual(legacyAnchor("第 12–23 行"), { kind: "text", line: 12, endLine: 23 });
  assert.deepEqual(legacyAnchor("未知位置"), { kind: "unknown" });
  assert.deepEqual(readAnchor("{}", "PDF 第 8 页"), { kind: "pdf", page: 8 });
  for (const value of ['{"kind":"pdf","page":0}', '{"kind":"epub","section":-1}', '{"kind":"text","line":12,"endLine":1}', 'not json']) assert.throws(() => readAnchor(value, ""));
});

test("老书库无损迁移：一致性备份、书籍编号/原件/文字/FTS 全部保留且无需重新导入", async () => {
  const root = temp(), source = pdfPagesFixture(), created = await importBook(root, "old.pdf", source), id = created.book.id;
  const before = new BookStore(root), original = before.passage(id, 2)!; before.close(); oldSchema(root);
  const upgraded = new BookStore(root);
  try {
    assert.equal(upgraded.get(id)!.passageCount, 2); assert.deepEqual(Buffer.from(upgraded.original(id)!), source);
    assert.equal(upgraded.passage(id, 2)!.text, original.text);
    assert.deepEqual(upgraded.passage(id, 2)!.anchor, { kind: "pdf", page: 2 });
    assert.equal(upgraded.search("NEEDLETERM")[0].passage, 2);
    const files = readdirSync(join(root, "runtime", "books", "backups")); assert.equal(files.length, 1);
    const backup = new DatabaseSync(join(root, "runtime", "books", "backups", files[0]), { readOnly: true });
    try { assert.equal(backup.prepare("PRAGMA table_info(passages)").all().some(r => r.name === "anchor"), false); assert.deepEqual(Buffer.from(backup.prepare("SELECT source FROM books WHERE id=?").get(id)!.source as Uint8Array), source); }
    finally { backup.close(); }
    const again = new BookStore(root); again.close(); assert.equal(readdirSync(join(root, "runtime", "books", "backups")).length, 1);
  } finally { upgraded.close(); }
});

test("迁移备份失败立即停下，旧库和源文件不被改写", async () => {
  const root = temp(), source = Buffer.from("旧数据必须保留，不能因为阅读器升级而丢失。"), r = await importBook(root, "old.txt", source);
  oldSchema(root); const dir = join(root, "runtime", "books"); writeFileSync(join(dir, "backups"), "do not overwrite");
  assert.throws(() => new BookStore(root));
  const db = new DatabaseSync(join(dir, "library.db"), { readOnly: true });
  try { assert.equal(db.prepare("PRAGMA table_info(passages)").all().some(c => c.name === "anchor"), false); assert.deepEqual(Buffer.from(db.prepare("SELECT source FROM books WHERE id=?").get(r.book.id)!.source as Uint8Array), source); }
  finally { db.close(); }
  assert.equal(readFileSync(join(dir, "backups"), "utf8"), "do not overwrite");
});

test("新导入位置：PDF 的命中页、EPUB 的章节/路径、文字切片的行号和规范化偏移", async () => {
  const root = temp(), s = new BookStore(root);
  try {
    const pdf = pdfPagesFixture(), p = s.add(pdf, "new.pdf", await parseBook(pdf, "new.pdf"));
    assert.deepEqual(s.passage(p.book.id, 2)!.anchor, { kind: "pdf", page: 2, offset: 0 });
    const epub = epubReaderFixture(), e = s.add(epub, "new.epub", await parseBook(epub, "new.epub"));
    const hit = s.search("唯一命中词阅读锚点", e.book.id)[0]; assert.equal(hit.passage, 2);
    assert.deepEqual(s.passage(e.book.id, 2)!.anchor, { kind: "epub", section: 2, path: "OPS/Text/two.xhtml", offset: 0 });
    const text = Array.from({ length: 500 }, (_, i) => `第${i + 1}行 练习记录和内容。`).join("\n"), bytes = Buffer.from(text), b = s.add(bytes, "lines.txt", await parseBook(bytes, "lines.txt"));
    for (let n = 1; n <= b.book.passageCount; n++) {
      const row = s.passage(b.book.id, n)!; assert.equal(row.anchor.kind, "text");
      if (row.anchor.kind === "text") { assert.ok(row.anchor.line >= 1); assert.ok(normalizeBookText(text).slice(row.anchor.offset!).startsWith(normalizeBookText(row.text))); }
    }
  } finally { s.close(); }
});

test("EPUB 原书：保留标题/加粗/样式/图片，清除脚本/表单/事件，资源只来自本书", async () => {
  const root = temp(), source = epubReaderFixture(), r = await importBook(root, "styled.epub", source), s = new BookStore(root), view = new BookPreview();
  try {
    const info = await view.info(r.book, s); assert.equal(info.units.length, 2); assert.equal(info.units[1].path, "OPS/Text/two.xhtml");
    const html = await view.document(r.book, s, 1); assert.match(html, /<h1>第一章：清晰的标题<\/h1>/); assert.match(html, /<strong>加粗重点<\/strong>/);
    assert.match(html, /assets\/OPS\/Styles\/book.css/); assert.match(html, /assets\/OPS\/Images\/pixel.png/); assert.match(html, /data-yia-section="2"/);
    assert.doesNotMatch(html, /<script|<iframe|<form|onload=|onerror=|http-equiv="refresh"|blocked.invalid/);
    const css = await view.asset(r.book, s, "OPS/Styles/book.css"); assert.match(css.mime, /text\/css/); assert.match(css.data.toString(), /font-size:34px/); assert.doesNotMatch(css.data.toString(), /blocked.invalid/);
    const image = await view.asset(r.book, s, "OPS/Images/pixel.png"); assert.equal(image.mime, "image/png"); assert.equal(image.data[0], 0x89);
    await assert.rejects(view.asset(r.book, s, "../../auth.json"), BookError); await assert.rejects(view.asset(r.book, s, "OPS/evil.js"), BookError);
    await assert.rejects(view.document(r.book, s, 999), /没有这个/);
  } finally { view.clear(); s.close(); }
});

test("TXT/Markdown 原件阅读：真实行号、标题层级、强调，危险 HTML 仅显示为文字", async () => {
  const root = temp(), text = Array.from({ length: 450 }, (_, i) => `第${i + 1}行 <script>not executed</script>`).join("\n"), r = await importBook(root, "lines.txt", Buffer.from(text)), s = new BookStore(root), view = new BookPreview();
  try {
    const info = await view.info(r.book, s); assert.equal(info.units.length, 3); assert.equal(info.units[1].line, 201);
    const html = await view.document(r.book, s, 2); assert.match(html, /data-line="250"/); assert.match(html, /&lt;script/); assert.doesNotMatch(html, /<script>/);
    const md = Buffer.from('# 一级标题\n\n## 二级标题\n\n正文与**加粗**。\n\n<img src=x onerror="parent.bad=true">');
    const m = s.add(md, "style.md", await parseBook(md, "style.md")), rendered = await view.document(m.book, s, 1);
    assert.match(rendered, /<h1>一级标题<\/h1>/); assert.match(rendered, /<h2>二级标题<\/h2>/); assert.match(rendered, /<strong>加粗<\/strong>/);
    const doc = bookXml(rendered, true); assert.equal(doc.getElementsByTagName("img").length, 0); assert.equal(doc.getElementsByTagName("script").length, 0);
  } finally { view.clear(); s.close(); }
});

async function serverFixture(t: { after(fn: () => Promise<void>): void }) {
  const root = temp(), server = createYiaServer({ root, logger: new Logger(join(root, "logs")), modelCatalog: async () => [], chat: async () => { throw new Error("reader must not call models"); } });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>(r => { server.close(() => r()); server.closeIdleConnections(); }));
  return { root, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}
test("PDF 原件 HTTP：inline/字节 Range/后缀范围/416，跨站不能读取，阅读器资源只暴露白名单", async t => {
  const f = await serverFixture(t), source = pdfPagesFixture(), r = await importBook(f.root, "original.pdf", source), url = f.base + `/api/books/${r.book.id}/content`;
  const full = await fetch(url); assert.equal(full.status, 200); assert.equal(full.headers.get("content-type"), "application/pdf"); assert.match(full.headers.get("content-disposition")!, /^inline/); assert.deepEqual(Buffer.from(await full.arrayBuffer()), source);
  for (const [range, expected] of [["bytes=0-7", source.subarray(0, 8)], ["bytes=-8", source.subarray(-8)], ["bytes=8-", source.subarray(8)]] as const) {
    const response = await fetch(url, { headers: { range } }); assert.equal(response.status, 206); assert.match(response.headers.get("content-range")!, /^bytes /); assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
  }
  for (const range of ["bytes=-0", "bytes=999999-", "bytes=9-2", "bytes=0-1,5-8"]) { const response = await fetch(url, { headers: { range } }); assert.equal(response.status, 416); assert.equal(response.headers.get("content-range"), `bytes */${source.length}`); }
  assert.equal((await fetch(url, { headers: { origin: "https://other.invalid" } })).status, 403);
  const asset = await fetch(f.base + "/api/books/assets/pdfjs/build/pdf.mjs"); assert.equal(asset.status, 200); assert.match(asset.headers.get("content-type")!, /javascript/); await asset.body?.cancel();
  assert.equal((await fetch(f.base + "/api/books/assets/pdfjs/package.json")).status, 404);
});

test("原书 HTML HTTP：沙箱与 CSP、正确章节和样式资源；索引工具仍读取纯文字", async t => {
  const f = await serverFixture(t), source = epubReaderFixture(), r = await importBook(f.root, "book.epub", source), prefix = f.base + `/api/books/${r.book.id}`;
  const info = await (await fetch(prefix + "/reader-info")).json(); assert.equal(info.units.length, 2);
  const response = await fetch(prefix + "/reader?unit=2"); assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy")!, /script-src 'none'/); assert.match(response.headers.get("content-security-policy")!, /sandbox allow-same-origin/);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer"); assert.match(await response.text(), /第二章：搜索定位/);
  const css = await fetch(prefix + "/assets/OPS/Styles/book.css"); assert.equal(css.status, 200); assert.match(css.headers.get("content-type")!, /text\/css/);
  assert.equal((await fetch(prefix + "/content")).status, 415); assert.equal((await fetch(prefix + "/reader?unit=0")).status, 400);
  const hit = (await (await fetch(f.base + "/api/books/search?q=" + encodeURIComponent("唯一命中词阅读锚点"))).json()).hits[0];
  const passage = (await (await fetch(prefix + `/passages/${hit.passage}`)).json()).passage;
  assert.equal(passage.anchor.section, 2); assert.match(passage.text, /唯一命中词/); assert.doesNotMatch(passage.text, /<p>/);
});

test("前端定位算法：优先命中词，重复原文不猜测，跨阅读单元按命中行跳转", async () => {
  const path = new URL("../web/js/book-reader.js", import.meta.url).href;
  const { findBookTarget, BookReader } = await import(path);
  assert.equal(findBookTarget("headingbodyneedle", "heading body needle", 0, "needle").at, 11);
  assert.equal(findBookTarget("same".repeat(5000), "same", undefined).at, -1);
  assert.equal(findBookTarget("same".repeat(5000), "same", 16000).at, 16000);
  assert.equal(findBookTarget("same".repeat(5000), "same", 3).at, -1);
  const book = { id: "test", format: "txt" }, reader = new BookReader({}, () => {});
  reader.book = book; reader.units = [{ index: 1, line: 1, endLine: 200 }, { index: 2, line: 201, endLine: 400 }];
  let selected = 0;
  reader.go = async (unit: number) => { selected = unit; };
  const text = Array.from({ length: 70 }, (_, i) => i + 190 === 250 ? "needle250" : `row${i + 190}`).join("\n");
  await reader.open(book, { anchor: { kind: "text", line: 190, endLine: 259 }, text }, "needle250");
  assert.equal(selected, 2);
});
