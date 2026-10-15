/**
 * 调度守护进程（常驻宿主）：提醒触发器从 TUI 会话独立出来后的唯一触发者。
 *
 * 背景（2026-09-12 事故复盘）：微信里设的提醒 9 点没响——chat-cli 每条消息
 * 起一个进程、答完即退，TUI 又没开，到点时无人在跑 ReminderRunner。
 * 修复：本脚本由 systemd 常驻（yia-scheduler.service，开机自启），
 * 30s 周期检查 jobs.json，到点即推；错过的在进程启动时补发。
 *
 * 通知路由：channel=wechat → 微信推送；channel=tui → 有微信配置时也推微信
 * （daemon 没有 TUI 可用，微信是唯一能到达手机的出口）；通道不可用则保留任务重试。
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

/** 返回真实发送结果；不可用或发送失败必须抛出，让 runner 保留待触发状态。 */
export async function sendWechatReminder(root: string, text: string, logger: Logger): Promise<void> {
  // 每次发送重新读取，换绑或修复配置后无需重启守护就能恢复重试。
  const cfg = loadWechatConfig(root);
  if (!cfg?.enabled || !cfg.gatewayToken) throw new Error("微信推送未配置或已停用");
  await new ClawbotSender(cfg, logger).send("", text);
}

// 仅作为入口运行时才启动守护（防止被 import 时产生多余实例）
if (isEntry) {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const logger = new Logger(join(ROOT, "runtime", "logs"));

  const jobs = new JobStore(
    join(ROOT, "runtime", "scheduler", "jobs.json"),
    join(ROOT, "runtime", "scheduler", "runs.jsonl"),
  );

  const runner = new ReminderRunner(jobs, (_job, text) => sendWechatReminder(ROOT, text, logger), logger);
  runner.start();
  logger.info("调度守护进程启动", { wechat: !!loadWechatConfig(ROOT)?.enabled, intervalMs: 30_000 });

  // 重启时先等当前推送和任务落盘，避免明明发出却来不及标完成。
  process.on("SIGTERM", async () => {
    try {
      await runner.stop();
      logger.info("调度守护进程退出");
      process.exit(0);
    } catch (e) {
      logger.error("调度守护进程退出失败", { error: String(e) });
      process.exit(1);
    }
  });
}
