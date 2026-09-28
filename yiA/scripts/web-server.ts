/**
 * yiA Web 入口：createYiaServer（src/server/server.ts）+ 监听。
 * 实现与单测都在 src/server；这里只负责起端口与友好报错。
 *
 * 启动：npm run web（默认 3777；YIA_WEB_PORT 可换）
 */
import { createYiaServer } from "../src/server/server.ts";
import { Logger } from "../src/logger.ts";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.YIA_WEB_PORT ?? 3777);

const server = createYiaServer({ root: ROOT, logger: new Logger(join(ROOT, "runtime", "logs")) });

server.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EADDRINUSE") {
    console.error(`端口 ${PORT} 已被占用——可能已有一个 yiA Web 在跑。\n先停掉旧实例（lsof -t -i:${PORT} | xargs kill）或换端口：YIA_WEB_PORT=${PORT + 1} npm run web`);
  } else {
    console.error(`启动失败：${String(e)}`);
  }
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`yiA Web 已启动：http://127.0.0.1:${PORT}（仅本机可访问；Ctrl+C 停止）`);
});
