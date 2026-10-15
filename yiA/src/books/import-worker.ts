/** 一次性解析子进程：限堆内存、超时可终止，不与 Web 主进程争用事件循环。 */
import { BookStore, BookError, bookHash, type Book } from "./store.ts";
import { parseBook } from "./parse.ts";

process.once("disconnect", () => process.exit(1));
process.once("message", async (input: { root: string; name: string; source: Uint8Array }) => {
  let store: BookStore | undefined;
  let message: { result: { book: Book; duplicate: boolean } } | { error: string; status: number };
  try {
    store = new BookStore(input.root);
    const known = store.byHash(bookHash(input.source));
    const result = known ? { book: known, duplicate: true } : store.add(input.source, input.name, await parseBook(input.source, input.name));
    message = { result };
  } catch (e) {
    message = e instanceof BookError ? { error: e.message, status: e.status } : { error: "书籍库写入失败，请检查磁盘空间和本地数据库；原文件未被修改。", status: 503 };
  } finally { store?.close(); }
  process.send?.(message, () => process.exit(0));
});
