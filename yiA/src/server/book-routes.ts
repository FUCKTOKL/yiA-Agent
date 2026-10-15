/** 书籍 API，挂在既有 createYiaServer 上；不另建服务器。 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "../logger.ts";
import { BookStore, BookError, MAX_BOOK_BYTES, BOOK_ID, bookFileName } from "../books/store.ts";
import { importBook } from "../books/import.ts";
import { BookPreview } from "../books/preview.ts";

const PDF_ROOT = fileURLToPath(new URL("../", import.meta.resolve("pdfjs-dist/build/pdf.mjs")));
function pdfAsset(path: string, res: ServerResponse): void {
  if (!/^(?:build\/pdf(?:\.worker)?\.mjs|web\/pdf_viewer\.css|(?:cmaps|standard_fonts|wasm)\/[\w.-]+\.(?:bcmap|ttf|pfb|wasm|js))$/.test(path)) throw new BookError("不存在的阅读器资源。", 404);
  const file = join(PDF_ROOT, path);
  if (!existsSync(file)) throw new BookError("阅读器资源缺失，请重新安装项目依赖。", 404);
  const type = extname(file);
  res.writeHead(200, { "content-type": type === ".mjs" || type === ".js" ? "text/javascript; charset=utf-8" : type === ".css" ? "text/css; charset=utf-8" : type === ".wasm" ? "application/wasm" : "application/octet-stream", "cache-control": "no-cache", "x-content-type-options": "nosniff" });
  createReadStream(file).on("error", () => res.destroy()).pipe(res);
}
function byteRange(header: string | undefined, size: number): { start: number; end: number } {
  if (!header) return { start: 0, end: size - 1 };
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) throw new BookError("不支持的文件范围。", 416);
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) throw new BookError("文件范围超出原件大小。", 416);
  return { start, end };
}
function readerPolicy(req: IncomingMessage, id: string): string {
  const resources = `http://${req.headers.host}/api/books/${id}/assets/`;
  return `default-src 'none'; script-src 'none'; style-src 'unsafe-inline' ${resources}; img-src ${resources} data:; font-src ${resources} data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-same-origin`;
}

function localRequest(req: IncomingMessage): boolean {
  try {
    const origin = new URL(`http://${req.headers.host}`);
    if (!["127.0.0.1", "localhost"].includes(origin.hostname) || Number(origin.port || 80) !== req.socket.localPort) return false;
    if (req.headers["sec-fetch-site"] === "cross-site") return false;
    return !req.headers.origin || req.headers.origin === origin.origin;
  } catch { return false; }
}
function upload(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let bytes = 0, rejected = false;
    const parts: Buffer[] = [];
    const fail = (error: BookError) => { rejected = true; parts.length = 0; reject(error); };
    req.on("data", (part: Buffer) => {
      if (rejected) return;
      bytes += part.length;
      if (bytes > MAX_BOOK_BYTES) { fail(new BookError("文件超过 50 MB，请缩小文件后再导入。", 413)); return; }
      parts.push(part);
    });
    req.once("end", () => { if (!rejected) resolve(Buffer.concat(parts)); });
    req.once("aborted", () => fail(new BookError("上传已中断，请重新选择文件。", 400)));
    req.once("error", () => fail(new BookError("上传失败，请重新选择文件。", 400)));
  });
}
export function createBookRoutes(root: string, logger: Logger) {
  let store: BookStore | undefined;
  const preview = new BookPreview();
  const books = () => store ??= new BookStore(root);
  const json = (res: ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(data));
  };
  return {
    close: () => { preview.clear(); store?.close(); },
    async handle(req: IncomingMessage, res: ServerResponse, url: URL) {
      try {
        if (!localRequest(req)) { req.resume(); return json(res, 403, { error: "书籍库只接受来自本机同源页面的请求。" }); }
        const path = url.pathname;
        if (path.startsWith("/api/books/assets/pdfjs/") && req.method === "GET") return pdfAsset(path.slice("/api/books/assets/pdfjs/".length), res);
        if (path === "/api/books" && req.method === "GET") return json(res, 200, { books: books().list() });
        if (path === "/api/books/search" && req.method === "GET") {
          const query = url.searchParams.get("q")?.trim() ?? "", id = url.searchParams.get("bookId") || undefined;
          return json(res, 200, { hits: books().search(query, id) });
        }
        if (path === "/api/books/import" && req.method === "POST") {
          if (req.headers["content-type"]?.split(";")[0].trim() !== "application/octet-stream") { req.resume(); throw new BookError("上传请使用二进制文件格式。", 415); }
          if (Number(req.headers["content-length"]) > MAX_BOOK_BYTES) { req.resume(); throw new BookError("文件超过 50 MB。", 413); }
          const { name } = bookFileName(url.searchParams.get("name") ?? "");
          const source = await upload(req), started = Date.now();
          const result = await importBook(root, name, source);
          logger.info("书籍导入完成", { id: result.book.id, bytes: source.length, format: result.book.format, duplicate: result.duplicate, ms: Date.now() - started });
          return json(res, result.duplicate ? 200 : 201, result);
        }
        const match = path.match(/^\/api\/books\/([^/]+)(?:\/(original|content|reader-info|reader|assets\/(.+)|passages\/([1-9]\d*)))?$/);
        if (match && BOOK_ID.test(match[1])) {
          const id = match[1], book = books().get(id);
          if (!book) throw new BookError("书籍不存在或已经删除。", 404);
          if (!match[2] && req.method === "DELETE") {
            if (!books().delete(id)) throw new BookError("书籍已经删除，请刷新书架。", 404);
            preview.clear(id);
            logger.info("书籍已删除", { id });
            return json(res, 200, { ok: true });
          }
          if (match[2] === "original" && req.method === "GET") {
            const source = books().original(id);
            if (!source) throw new BookError("原文件不存在，请从备份恢复。", 404);
            res.writeHead(200, {
              "content-type": "application/octet-stream", "content-length": source.length,
              "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(book.sourceName)}`,
              "cache-control": "no-store", "x-content-type-options": "nosniff",
            });
            return res.end(source);
          }
          if (match[2] === "content" && req.method === "GET") {
            if (book.format !== "pdf") throw new BookError("此接口只提供 PDF 原件预览。", 415);
            res.setHeader("accept-ranges", "bytes");
            res.setHeader("content-range", `bytes */${book.byteSize}`);
            const range = byteRange(req.headers.range, book.byteSize);
            const source = books().originalRange(id, range.start, range.end - range.start + 1);
            if (!source) throw new BookError("原件不存在。", 404);
            res.removeHeader("content-range");
            if (req.headers.range) res.setHeader("content-range", `bytes ${range.start}-${range.end}/${book.byteSize}`);
            res.writeHead(req.headers.range ? 206 : 200, { "content-type": "application/pdf", "content-length": source.length, "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(book.sourceName)}`, "cache-control": "no-store", "x-content-type-options": "nosniff" });
            return res.end(source);
          }
          if (match[2] === "reader-info" && req.method === "GET") return json(res, 200, await preview.info(book, books()));
          if (match[2] === "reader" && req.method === "GET") {
            if (book.format === "pdf") throw new BookError("请使用 PDF 原件阅读器。", 415);
            const unit = Number(url.searchParams.get("unit") ?? "1");
            if (!Number.isSafeInteger(unit) || unit < 1) throw new BookError("阅读位置不正确。", 400);
            const html = await preview.document(book, books(), unit);
            res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": readerPolicy(req, id), "referrer-policy": "no-referrer", "cache-control": "no-store", "x-content-type-options": "nosniff" });
            return res.end(html);
          }
          if (match[3] && req.method === "GET") {
            const asset = await preview.asset(book, books(), decodeURIComponent(match[3]));
            res.writeHead(200, { "content-type": asset.mime, "content-security-policy": readerPolicy(req, id), "referrer-policy": "no-referrer", "cache-control": "no-store", "x-content-type-options": "nosniff" });
            return res.end(asset.data);
          }
          if (match[4] && req.method === "GET") {
            const passage = books().passage(id, Number(match[4]));
            if (!passage) throw new BookError("没有这个原文片段。", 404);
            return json(res, 200, { book, passage });
          }
          if (!match[2] && req.method === "GET") return json(res, 200, { book });
        }
        return json(res, 404, { error: "不存在的书籍接口。" });
      } catch (e) {
        if (!req.complete) req.resume();
        const error = e instanceof BookError ? e : new BookError("书籍库暂不可用，请检查磁盘空间或从备份恢复；请勿直接删除数据库。", 503);
        logger.warn("书籍请求未完成", { status: error.status });
        if (!res.headersSent && !res.destroyed) json(res, error.status, { error: error.message });
      }
    },
  };
}
