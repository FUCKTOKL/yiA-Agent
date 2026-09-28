/**
 * 微信通道运维操作（UI 无关）：TUI /wechat 命令与 Web 换绑向导共用。
 * 从 commands.ts 抽出（2026-09-21，M6.2 Web 换绑）。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 跑一条命令并收集输出（短命令） */
export function runCapture(cmd: string, args: string[], timeoutMs = 30_000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { env: process.env });
    let out = "";
    const t = setTimeout(() => p.kill(), timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, out });
    });
    p.on("error", (e) => {
      clearTimeout(t);
      resolve({ code: null, out: String(e) });
    });
  });
}

/** 从 channels status 输出解析已登录的微信 bot 账号 id。
 *  只认 configured（排除 "not configured, stopped" 僵尸条目，
 *  否则会把已停用账号写进发送配置 → 推送报 account not configured） */
export function parseWeixinAccounts(statusOut: string): string[] {
  const ids: string[] = [];
  for (const m of statusOut.matchAll(/openclaw-weixin\s+([^\s:]+):\s*(.+)/g)) {
    const id = m[1];
    const state = m[2];
    if (id && id !== "default" && !state.includes("not configured")) ids.push(id);
  }
  return ids;
}

/** 网关服务控制：openclaw 自带命令本身跨平台（Linux=systemd / macOS=launchd / Windows=schtasks） */
export async function gatewayCtl(action: "stop" | "start" | "restart"): Promise<void> {
  await runCapture("openclaw", ["gateway", action], 60_000);
}

/** 登出全部微信账号：停网关 → 凭据文件移入备份目录 → 起网关。
 *  注：weixin 插件不支持 `channels logout` CLI，删账号文件是唯一途径
 *  （凭据存在 ~/.openclaw/openclaw-weixin/accounts/<id>.{json,sync.json,context-tokens.json}）。 */
export async function logoutAllWeixinAccounts(onNotify?: (msg: string) => void): Promise<string[]> {
  const st = await runCapture("openclaw", ["channels", "status", "--probe"]);
  const accounts = parseWeixinAccounts(st.out);
  if (accounts.length === 0) return [];
  await gatewayCtl("stop");
  const dir = join(process.env.HOME || process.env.USERPROFILE || ".", ".openclaw/openclaw-weixin/accounts");
  const backup = join(dir, ".removed-backup");
  mkdirSync(backup, { recursive: true });
  const moved: string[] = [];
  for (const id of accounts) {
    for (const suffix of [".json", ".sync.json", ".context-tokens.json"]) {
      const f = join(dir, id + suffix);
      if (existsSync(f)) {
        renameSync(f, join(backup, `${id}${suffix}.${Date.now()}`));
      }
    }
    moved.push(id);
    onNotify?.(`已登出 ${id}`);
  }
  await gatewayCtl("start");
  await new Promise((r) => setTimeout(r, 5000));
  return moved;
}

/** 解析当前登录账号并写进 wechat.json 的 account 字段（发送指定 accountId 防多账号歧义） */
export async function bindCurrentAccount(configFile: string): Promise<string | null> {
  const st = await runCapture("openclaw", ["channels", "status", "--probe"]);
  const accounts = parseWeixinAccounts(st.out);
  if (accounts.length === 0 || !existsSync(configFile)) return null;
  const cfg = JSON.parse(readFileSync(configFile, "utf8"));
  cfg.account = accounts[0];
  writeFileSync(configFile, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  return accounts[0];
}

/** 微信个人号 id 强校验（插件 peer 格式） */
export function validWechatPeer(peer: string): boolean {
  return /^o[\w-]{15,}@im\.wechat$/.test(peer);
}
