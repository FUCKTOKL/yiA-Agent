#!/usr/bin/env node
/**
 * yiA Web 服务器入口：npm run web（或 node yiA/scripts/web-server.ts）
 * 只绑 127.0.0.1:8787——个人工具，不要改绑 0.0.0.0（无鉴权）。
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createYiaServer } from "../src/server/server.ts";
import { Logger } from "../src/logger.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.YIA_WEB_PORT ?? 8787);

const logger = new Logger(resolve(ROOT, "runtime", "logs"));
const server = createYiaServer({ root: ROOT, logger });

server.listen(PORT, "127.0.0.1", () => {
  console.log(`yiA Web → http://127.0.0.1:${PORT}`);
  console.log("（仅本机可访问；Ctrl+C 停止）");
});

process.on("SIGTERM", () => { server.close(); process.exit(0); });
process.on("SIGINT", () => { server.close(); process.exit(0); });
