import { fork } from "node:child_process";
import { resolve } from "node:path";
import { BookError, MAX_BOOK_BYTES, bookFileName, type Book } from "./store.ts";

const active = new Set<string>();
/** 同一进程一次只导入一本；不同进程由 SQLite 事务防重及互斥写入。 */
export async function importBook(root: string, name: string, source: Uint8Array): Promise<{ book: Book; duplicate: boolean }> {
  const file = bookFileName(name);
  if (!source.length || source.length > MAX_BOOK_BYTES) throw new BookError("文件为空或超过 50 MB。", 413);
  root = resolve(root);
  if (active.has(root)) throw new BookError("正在导入另一本书，请完成后再试。", 409);
  active.add(root);
  try {
    return await new Promise((done, fail) => {
      // 解析进程不需要模型密钥或用户的 NODE_OPTIONS，不向它透传这些环境变量。
      const env: NodeJS.ProcessEnv = { NODE_NO_WARNINGS: "1" };
      for (const key of ["PATH", "SystemRoot", "WINDIR", "HOME", "USERPROFILE", "TEMP", "TMP"]) if (process.env[key]) env[key] = process.env[key];
      const child = fork(new URL("./import-worker.ts", import.meta.url), [], {
        execArgv: ["--experimental-strip-types", "--max-old-space-size=384"],
        env, serialization: "advanced", stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      let result: { book: Book; duplicate: boolean } | undefined;
      let error: BookError | undefined;
      const timer = setTimeout(() => {
        error = new BookError("导入超过两分钟，已停止解析。请刷新书架确认是否已收录，或换更小的文件。", 408);
        child.kill();
      }, 120_000);
      child.on("message", (message: { result?: typeof result; error?: string; status?: number }) => {
        if (message.error) error = new BookError(message.error, message.status ?? 422);
        else result = message.result;
      });
      child.once("error", () => { clearTimeout(timer); fail(new BookError("无法启动本机书籍解析进程。", 503)); });
      child.once("exit", () => {
        clearTimeout(timer);
        if (error) fail(error);
        else if (result) done(result);
        else fail(new BookError("解析进程意外退出，可能占用内存过多；请换较小的文字版文件。", 422));
      });
      child.send({ root, name: file.name, source }, e => { if (e) { error = new BookError("无法把文件交给本机解析进程。", 503); child.kill(); } });
    });
  } finally { active.delete(root); }
}
