import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { BookStore, BookError, MAX_BOOK_BYTES, MAX_BOOK_CHARS, bookFileName } from "../src/books/store.ts";
import { parseBook } from "../src/books/parse.ts";
import { importBook } from "../src/books/import.ts";
import { epubFixture, pdfFixture, zipFixture } from "./book-fixtures.ts";
const temp = () => mkdtempSync(join(tmpdir(), "yia-books-test-"));

// 临时目录留在系统 temp，不执行递归/批量文件删除。
test("文字书：UTF-8/UTF-16/GB18030、本地原件、持久化、中文单字与多词 AND", async () => {
  const root = temp(), source = Buffer.from("第一章\n目标设定需要刻意练习，热爱学习。\nLearning deliberate PRACTICE.");
  const r = await importBook(root, "../书籍.txt", source);
  assert.equal(r.book.sourceName, "书籍.txt");
  assert.equal(r.duplicate, false);
  const store = new BookStore(root);
  try {
    assert.equal(store.list().length, 1);
    assert.equal(store.search("目标").length, 1);
    assert.equal(store.search("爱").length, 1);
    assert.equal(store.search("目标 练习").length, 1);
    assert.equal(store.search("目标 不存在").length, 0);
    assert.equal(store.search("practice").length, 1);
    assert.deepEqual(Buffer.from(store.original(r.book.id)!), source);
    assert.match(store.passage(r.book.id, 1)!.location, /第 1–3 行/);
    assert.equal(store.search('" OR - ()').length, 0);
    assert.throws(() => store.search("x".repeat(201)), BookError);
    assert.throws(() => store.search("目标", "../../outside"), BookError);
  } finally { store.close(); store.close(); }
  const duplicate = await importBook(root, "新名字.md", source);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.book.id, r.book.id);
  assert.equal(duplicate.book.title, r.book.title);
  for (const bytes of [Buffer.concat([Buffer.from([255, 254]), Buffer.from("中文文字", "utf16le")]), Buffer.from([0xd6, 0xd0, 0xce, 0xc4])]) {
    assert.match((await parseBook(bytes, "编码.txt")).sections[0].text, /中文/);
  }
});

test("EPUB：按 spine 而非 ZIP 顺序阅读、真实节/文件位置、实体解码、排除脚本", async () => {
  const source = epubFixture(), parsed = await parseBook(source, "测试.epub");
  assert.equal(parsed.title, "中文 EPUB 测试书");
  assert.equal(parsed.author, "测试作者");
  assert.match(parsed.sections[0].text, /^第二章/);
  assert.match(parsed.sections[0].location, /第 1 节.*two.xhtml/);
  assert.match(parsed.sections[1].text, /A & B practice/);
  assert.doesNotMatch(parsed.sections.map(s => s.text).join(""), /script_marker/);
  assert.doesNotMatch(parsed.sections[0].location, /第.*页/);
  const root = temp();
  const { book } = await importBook(root, "电子书.epub", source);
  const store = new BookStore(root);
  try { assert.match(store.search("刻意练习", book.id)[0].location, /one.xhtml/); }
  finally { store.close(); }
});

test("PDF：提取文字与元数据，保留真实页码；扫描空页和密码文件明确拒绝", async () => {
  const parsed = await parseBook(pdfFixture(), "test.pdf");
  assert.equal(parsed.title, "Fixture PDF");
  assert.equal(parsed.author, "Test Author");
  assert.equal(parsed.sectionCount, 1);
  assert.equal(parsed.sections[0].location, "PDF 第 1 页");
  assert.match(parsed.sections[0].text, /Practice makes progress/);
  await assert.rejects(parseBook(pdfFixture(""), "scan.pdf"), /没有提取到.*OCR/);
  await assert.rejects(parseBook(pdfFixture("secret", true), "protected.pdf"), /需要密码/);
});

test("安全边界：格式伪装/损坏/ZIP 越界/外部资源/解压炸弹/文字体积均拒绝", async () => {
  assert.throws(() => bookFileName("anything.exe"), /PDF、EPUB/);
  assert.equal(bookFileName("C:\\folder\\note.MARKDOWN").format, "md");
  for (const name of ["bad.pdf", "bad.epub"]) await assert.rejects(parseBook(Buffer.from("broken bytes"), name), /解析失败/);
  await assert.rejects(parseBook(Buffer.from([0, 1, 2, 0, 255]), "binary.txt"), BookError);
  await assert.rejects(parseBook(zipFixture({ "../escape.xhtml": "bad" }), "bad.epub"), BookError);
  await assert.rejects(parseBook(epubFixture("https://example.invalid/external.xhtml"), "external.epub"), /外部正文路径/);
  await assert.rejects(parseBook(zipFixture({ "large.xhtml": "tiny" }, { compressed: true, declaredSize: 50 * 1024 * 1024 }), "bomb.epub"), /解压后的文字过大/);
  await assert.rejects(parseBook(Buffer.from("x".repeat(MAX_BOOK_CHARS + 1)), "long.txt"), /500 万字/);
  const root = temp();
  await assert.rejects(importBook(root, "bad.exe", Buffer.from("x")), BookError);
  await assert.rejects(importBook(root, "empty.txt", Buffer.alloc(0)), BookError);
  await assert.rejects(importBook(root, "big.txt", Buffer.alloc(MAX_BOOK_BYTES + 1)), BookError);
  assert.equal(existsSync(join(root, "runtime", "books", "library.db")), false);
});

test("切片：覆盖全部正文、边界重叠、原文行号连续且不丢尾部", async () => {
  const root = temp(), source = Buffer.from(Array.from({ length: 1600 }, (_, i) => `第${i + 1}行：坚持学习并记录实践。`).join("\n"));
  const parsed = await parseBook(source, "长书.md");
  const store = new BookStore(root);
  try {
    const { book } = store.add(source, "长书.md", parsed);
    assert.ok(book.passageCount > 10);
    let previous = 0;
    for (let n = 1; n <= book.passageCount; n++) {
      const p = store.passage(book.id, n)!;
      const line = Number(p.location.match(/第 (\d+)/)![1]);
      assert.ok(line >= previous); previous = line;
      assert.ok(p.text.length <= 1200);
    }
    assert.match(store.passage(book.id, book.passageCount)!.text, /第1600行/);
    assert.ok(store.search("第1600行", book.id).length);
  } finally { store.close(); }
});

test("原件+正文+索引原子写入：中途失败回滚，删除级联清除 FTS，其他连接即时可见", async () => {
  const root = temp(), a = new BookStore(root), b = new BookStore(root);
  const path = join(root, "runtime", "books", "library.db"), raw = new DatabaseSync(path);
  try {
    const source = Buffer.from("保留旧书，刻意练习。"), parsed = await parseBook(source, "旧书.txt");
    const { book } = a.add(source, "旧书.txt", parsed);
    assert.equal(b.search("刻意练习").length, 1);
    raw.exec("CREATE TRIGGER inject_failure BEFORE INSERT ON passages BEGIN SELECT RAISE(ABORT,'test write failure'); END;");
    const next = Buffer.from("失败原文绝对不能残留。 ");
    assert.throws(() => a.add(next, "失败.txt", { title: "失败", author: "", sectionCount: 1, sections: [{ text: "失败原文绝对不能残留", location: "文字原文" }], warnings: [] }));
    assert.equal(b.list().length, 1); assert.equal(b.search("失败原文").length, 0);
    raw.exec("DROP TRIGGER inject_failure;");
    assert.equal(a.delete(book.id), true); assert.equal(a.delete(book.id), false);
    assert.equal(b.search("刻意练习").length, 0); assert.equal(b.list().length, 0);
    assert.equal(b.original(book.id), undefined);
    raw.exec("INSERT INTO book_fts(book_fts,rank) VALUES('integrity-check',1)");
  } finally { raw.close(); a.close(); b.close(); }
});

test("损坏书籍库降级，不覆盖原数据库；损坏书籍不留下书架条目", async () => {
  const root = temp(), dir = join(root, "runtime", "books"); mkdirSync(dir, { recursive: true });
  const bad = Buffer.from("keep corrupt database untouched"), file = join(dir, "library.db"); writeFileSync(file, bad);
  await assert.rejects(importBook(root, "test.txt", Buffer.from("一段书籍文字")), /写入失败/);
  assert.deepEqual(readFileSync(file), bad);
  const fresh = temp();
  await assert.rejects(importBook(fresh, "bad.pdf", Buffer.from("not pdf")), /解析失败/);
  const s = new BookStore(fresh);
  try { assert.equal(s.list().length, 0); } finally { s.close(); }
});

test("导入并发：同实例拒绝重叠，两独立进程同时导入同一本只保留一份", async () => {
  const root = temp(), source = Buffer.from("并发导入需要去重与事务。"), first = importBook(root, "one.txt", source);
  await assert.rejects(importBook(root, "two.txt", source), /正在导入另一本/); await first;
  const isolated = temp(), importer = new URL("../src/books/import.ts", import.meta.url).href;
  const run = () => new Promise<{ duplicate: boolean }>((resolve, reject) => {
    const code = `import {importBook} from ${JSON.stringify(importer)}; const r=await importBook(${JSON.stringify(isolated)},'same.txt',Buffer.from('独立进程并发文字'));console.log(JSON.stringify({duplicate:r.duplicate}));`;
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", error = "";
    child.stdout.on("data", b => output += b); child.stderr.on("data", b => error += b);
    child.on("error", reject); child.on("exit", status => {
      if (status) reject(new Error(error)); else { try { resolve(JSON.parse(output)); } catch (e) { reject(e); } }
    });
  });
  const results = await Promise.all([run(), run()]);
  assert.equal(results.filter(r => !r.duplicate).length, 1);
  const s = new BookStore(isolated); try { assert.equal(s.list().length, 1); } finally { s.close(); }
});
