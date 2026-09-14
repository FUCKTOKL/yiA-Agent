/**
 * 统一日志入口（PRD §10.1）。
 *
 * - 落盘：<项目根>/runtime/logs/yia-YYYYMMDD.log，按天分文件，保留 14 天
 * - 级别：error < warn < info < debug，默认 info，环境变量 YIA_LOG_LEVEL 可调
 * - 纪律：全项目禁用散落的 console.log（TUI 模式下 stdout 输出会破坏界面）；
 *   禁记记忆正文、凭据、会话原文——只记 id、数量、耗时、错误消息
 *
 * ponytail: 同步追加写，单进程单用户场景无锁竞争；多进程并发写再加队列
 */
import { appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export type LogLevel = "error" | "warn" | "info" | "debug";

const LEVELS: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };
const RETAIN_DAYS = 14;

export class Logger {
  /** 当前生效的最低输出级别（数值越大越啰嗦） */
  private minLevel: number;

  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    const env = process.env.YIA_LOG_LEVEL as LogLevel | undefined;
    this.minLevel = env && env in LEVELS ? LEVELS[env] : LEVELS.info;
    this.cleanupOldLogs();
  }

  error(msg: string, data?: unknown): void {
    this.write("error", msg, data);
  }
  warn(msg: string, data?: unknown): void {
    this.write("warn", msg, data);
  }
  info(msg: string, data?: unknown): void {
    this.write("info", msg, data);
  }
  debug(msg: string, data?: unknown): void {
    this.write("debug", msg, data);
  }

  /** 写一行日志；附加数据序列化为 JSON（调用方负责脱敏） */
  private write(level: LogLevel, msg: string, data?: unknown): void {
    if (LEVELS[level] > this.minLevel) return;
    const extra = data === undefined ? "" : " " + JSON.stringify(data);
    const line = `[${new Date().toISOString()}] [${level}] ${msg}${extra}\n`;
    appendFileSync(join(this.dir, `yia-${dayStamp()}.log`), line, "utf8");
  }

  /** 删除超过保留期的旧日志（构造时执行一次即可） */
  private cleanupOldLogs(): void {
    const cutoff = Date.now() - RETAIN_DAYS * 86_400_000;
    for (const f of readdirSync(this.dir)) {
      const m = f.match(/^yia-(\d{8})\.log$/);
      if (!m) continue;
      const t = Date.parse(`${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}`);
      if (Number.isFinite(t) && t < cutoff) rmSync(join(this.dir, f));
    }
  }
}

/** 当前日期戳（本地时区），如 20260911；日志按天分文件用 */
function dayStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}
