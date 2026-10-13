import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const server = join(dirname(fileURLToPath(import.meta.url)), "..", "sidecar", "mcp", "weather-mcp.mjs");

test("天气 MCP：初始化并暴露两个天气工具", async () => {
  const child = spawn(process.execPath, [server], { stdio: ["pipe", "pipe", "pipe"] });
  const replies: any[] = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) replies.push(JSON.parse(line));
    }
  });
  child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
  child.stdin.write('{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n');

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("天气 MCP 初始化超时")), 3_000);
    const poll = () => replies.length >= 2 ? (clearTimeout(timeout), resolve()) : setTimeout(poll, 10);
    poll();
  });
  child.stdin.end();

  assert.equal(replies[0].result.serverInfo.name, "yia-weather");
  assert.deepEqual(replies[1].result.tools.map((tool: any) => tool.name), ["weather", "weather_by_coords"]);
});
