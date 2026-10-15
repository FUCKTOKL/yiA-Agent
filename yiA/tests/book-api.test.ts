import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { createYiaServer } from "../src/server/server.ts";
import { Logger } from "../src/logger.ts";
import { MAX_BOOK_BYTES } from "../src/books/store.ts";
import { pdfFixture, epubFixture } from "./book-fixtures.ts";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = mkdtempSync(join(tmpdir(), "yia-book-api-"));
  let modelCalls = 0;
  const server = createYiaServer({ root, logger: new Logger(join(root, "logs")), modelCatalog: async () => [], chat: async () => { modelCalls++; throw new Error("books must not call models"); } });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>(r => { server.close(() => r()); server.closeIdleConnections(); }));
  const port = (server.address() as { port: number }).port, base = `http://127.0.0.1:${port}`;
  const upload = (name: string, bytes: Buffer, headers: Record<string, string> = {}) => fetch(`${base}/api/books/import?name=${encodeURIComponent(name)}`, { method: "POST", headers: { "content-type": "application/octet-stream", ...headers }, body: Uint8Array.from(bytes) });
  return { root, base, port, upload, calls: () => modelCalls };
}

test("书籍 HTTP 完整链：上传、去重、列表、跨书/单书检索、页码原文、下载、删除并刷新", async t => {
  const f = await fixture(t), text = Buffer.from("敏感原文标记：热爱学习，目标设定。另一项是 deliberate practice。"), name = "<安全标题>.txt";
  const uploaded = await f.upload(name, text); assert.equal(uploaded.status, 201);
  const data = await uploaded.json(), id = data.book.id;
  const duplicate = await f.upload("same.md", text); assert.equal(duplicate.status, 200); assert.equal((await duplicate.json()).duplicate, true);
  const pdf = await f.upload("test.pdf", pdfFixture()); assert.equal(pdf.status, 201);
  const pdfId = (await pdf.json()).book.id;
  const epub = await f.upload("test.epub", epubFixture()); assert.equal(epub.status, 201);
  const list = await (await fetch(f.base + "/api/books")).json();
  assert.equal(list.books.length, 3); assert.equal("source" in list.books[0], false);
  const hits = await (await fetch(f.base + "/api/books/search?q=" + encodeURIComponent("学习"))).json();
  assert.ok(hits.hits.length >= 2);
  const scoped = await (await fetch(f.base + `/api/books/search?q=${encodeURIComponent("学习")}&bookId=${id}`)).json();
  assert.equal(scoped.hits.length, 1); assert.equal(scoped.hits[0].bookId, id);
  const passage = await (await fetch(f.base + `/api/books/${pdfId}/passages/1`)).json();
  assert.equal(passage.passage.location, "PDF 第 1 页"); assert.match(passage.passage.text, /Practice/);
  const original = await fetch(f.base + `/api/books/${id}/original`);
  assert.match(original.headers.get("content-disposition")!, /attachment; filename\*=UTF-8/);
  assert.equal(original.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), text);
  assert.equal((await fetch(f.base + `/api/books/${id}/passages/999999`)).status, 404);
  assert.equal((await fetch(f.base + `/api/books/${id}`, { method: "DELETE" })).status, 200);
  assert.equal((await fetch(f.base + `/api/books/${id}/original`)).status, 404);
  const gone = await (await fetch(f.base + `/api/books/search?q=${encodeURIComponent("敏感原文标记")}`)).json(); assert.equal(gone.hits.length, 0);
  assert.equal(f.calls(), 0);
  const logs = readdirSync(join(f.root, "logs")).map(n => readFileSync(join(f.root, "logs", n), "utf8")).join("");
  assert.doesNotMatch(logs, /敏感原文标记|安全标题|deliberate practice/);
});

test("书籍接口拒绝跨站/伪造 Host/错误 Content-Type/超大请求，失败不改变书架", async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.base + "/api/books", { headers: { origin: "https://evil.invalid" } })).status, 403);
  assert.equal((await f.upload("bad.txt", Buffer.from("bad"), { origin: "null" })).status, 403);
  assert.equal((await f.upload("bad.txt", Buffer.from("bad"), { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await f.upload("bad.txt", Buffer.from("bad"), { "content-type": "text/plain" })).status, 415);
  assert.equal((await f.upload("bad.exe", Buffer.from("bad"))).status, 415);
  const raw = (headers: Record<string, string>, method = "GET", path = "/api/books") => new Promise<number>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: f.port, path, method, headers: { connection: "close", ...headers } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode!)); });
    req.on("error", reject); req.end();
  });
  assert.equal(await raw({ host: "attacker.invalid" }), 403);
  assert.equal(await raw({}, "GET", "/api/books/%FF/passages/1"), 400);
  assert.equal(await raw({ "content-type": "application/octet-stream", "content-length": String(MAX_BOOK_BYTES + 1) }, "POST", "/api/books/import?name=too-big.txt"), 413);
  const failed = await f.upload("bad.pdf", Buffer.from("not a PDF")); assert.equal(failed.status, 422);
  const list = await (await fetch(f.base + "/api/books")).json(); assert.equal(list.books.length, 0);
  assert.equal(f.calls(), 0);
});

test("书籍库损坏返回可读 503，不拖垮服务器，不覆盖损坏文件", async t => {
  const f = await fixture(t), dir = join(f.root, "runtime", "books"); mkdirSync(dir, { recursive: true });
  const file = join(dir, "library.db"), bytes = Buffer.from("preserve corrupt db"); writeFileSync(file, bytes);
  const response = await fetch(f.base + "/api/books"); assert.equal(response.status, 503);
  assert.match((await response.json()).error, /从备份恢复/);
  assert.equal((await fetch(f.base + "/api/chat/history")).status, 200);
  assert.deepEqual(readFileSync(file), bytes);
});
