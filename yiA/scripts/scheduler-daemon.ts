/**
 * 调度守护进程（常驻宿主）：提醒触发器从 TUI 会话独立出来后的唯一触发者。
 *
 * 背景（2026-09-12 事故复盘）：微信里设的提醒 9 点没响——chat-cli 每条消息
 * 起一个进程、答完即退，TUI 又没开，到点时无人在跑 ReminderRunner。
 * 修复：本脚本由 systemd 常驻（yia-scheduler.service，开机自启），
 * 30s 周期检查 jobs.json，到点即推；错过的在进程启动时补发。
 *
 * 通知路由：channel=wechat → 微信推送；channel=tui → 有微信配置时也推微信
 * （daemon 没有 TUI 可用，微信是唯一能到达手机的出口），否则记日志。
 * 提醒触发职责全部收归本进程，TUI 会话不再启动 runner（防双发）。
 */
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { JobStore } from "../src/scheduler/job-store.ts";
import { ReminderRunner } from "../src/scheduler/runner.ts";
import { Logger } from "../src/logger.ts";
import { ClawbotSender } from "../src/channels/clawbot/sender.ts";
import { loadWechatConfig } from "../src/channels/wechat-config.ts";

const isEntry = (() => {
  try {
    return resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

// 仅作为入口运行时才启动守护（防止被 import 时产生多余实例）
if (isEntry) {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const logger = new Logger(join(ROOT, "runtime", "logs"));

  const jobs = new JobStore(
    join(ROOT, "runtime", "scheduler", "jobs.json"),
    join(ROOT, "runtime", "scheduler", "runs.jsonl"),
  );

  // 微信出口：配置存在才可用；不可用时通知降级为日志
  const wcfg = loadWechatConfig(ROOT);
  const wechat = wcfg ? new ClawbotSender(wcfg, logger) : null;

  /** 通知路由：见文件头注释 */
  const notify = (job: { channel: string; title: string }, text: string): void => {
    if (wechat) {
      // 异步发送；失败由 sender 抛错——这里 catch 后记日志（runner 不因推送失败重试整个任务）
      wechat.send("", text).catch((e) => {
        logger.error("提醒微信推送失败", { id: (job as any).id, error: String(e) });
      });
    } else {
      logger.warn("无微信配置，提醒仅记日志", { text });
    }
  };

  const runner = new ReminderRunner(jobs, notify, logger);
  runner.start();
  logger.info("调度守护进程启动", { wechat: !!wechat, intervalMs: 30_000 });

  // 优雅退出（systemd stop 时）
  process.on("SIGTERM", () => {
    runner.stop();
    logger.info("调度守护进程退出");
    process.exit(0);
  });
}
