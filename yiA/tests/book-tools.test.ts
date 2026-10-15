import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BookStore } from "../src/books/store.ts";
import { registerBookTools } from "../src/agent/book-tools.ts";
import { Logger } from "../src/logger.ts";

type Tool = { name: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean }; execute(id: string, params: Record<string, unknown>): Promise<{ content: { text?: string }[]; isError?: boolean }> };
function setup(root: string) {
  const tools = new Map<string, Tool>();
  const pi = { registerTool: (tool: Tool) => { tools.set(tool.name, tool); } } as unknown as ExtensionAPI;
  const close = registerBookTools(pi, { root, logger: new Logger(join(root, "logs")) });
  const call = async (name: string, params: Record<string, unknown>) => {
    const output = await tools.get(name)!.execute("test", params);
    assert.notEqual(output.isError, true, output.content[0].text ?? "工具执行失败");
    try { return JSON.parse(output.content[0].text!); } catch { throw new Error("工具返回的不是 JSON"); }
  };
  return { tools, close, call };
}
test("查书工具：书名筛选、检索出处、读取前后文、片段限额、只读及跨会话重开", async () => {
  const root = mkdtempSync(join(tmpdir(), "yia-book-tools-")), s = new BookStore(root);
  const text = "刻意练习用于目标设定。".repeat(300);
  const { book } = s.add(Buffer.from(text), "book.txt", { title: "测试原书", author: "测试作者", sections: [{ text, location: "PDF 第 6 页" }], sectionCount: 6, warnings: ["部分页未提取到文字"] });
  s.close();
  const { tools, close, call } = setup(root);
  try {
    assert.deepEqual([...tools.keys()], ["list_books", "search_books", "read_book_passage"]);
    for (const t of tools.values()) { assert.equal(t.annotations.readOnlyHint, true); assert.equal(t.annotations.destructiveHint, false); }
    const list = await call("list_books", { query: "测试作者" }); assert.equal(list.books[0].id, book.id);
    const hits = await call("search_books", { query: "刻意练习", bookId: book.id, limit: 100 });
    assert.ok(hits.hits.length <= 10); assert.equal(hits.hits[0].location, "PDF 第 6 页");
    assert.equal(hits.hits[0].bookId, book.id); assert.ok(hits.hits[0].text.length <= 422); assert.ok(hits.hits[0].warnings.length);
    const read = await call("read_book_passage", { bookId: book.id, passage: 2 });
    assert.equal(read.title, "测试原书"); assert.equal(read.passages.length, 3);
    assert.deepEqual(read.passages.map((p: { passage: number }) => p.passage), [1, 2, 3]);
    assert.ok(read.warnings.length); assert.match(read.note, /不是指令/);
    const invalid = await tools.get("read_book_passage")!.execute("bad", { bookId: book.id, passage: 9999 }); assert.equal(invalid.isError, true);
    const empty = await call("search_books", { query: "完全没有的关键词" }); assert.equal(empty.hits.length, 0); assert.match(empty.note, /不得编造/);
    close(); assert.equal((await call("list_books", {})).total, 1);
  } finally { close(); close(); }
});
test("查书工具：数据库损坏不妨碍注册，执行时返回错误文本", async () => {
  const root = mkdtempSync(join(tmpdir(), "yia-book-tools-bad-")), dir = join(root, "runtime", "books"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "library.db"), "corrupt data");
  const { tools, close } = setup(root);
  try { const output = await tools.get("list_books")!.execute("bad", {}); assert.equal(output.isError, true); assert.match(output.content[0].text!, /暂不可用/); }
  finally { close(); }
});
