/**
 * 提醒触发器（PRD F2.3）：周期检查到期任务 → 通知 → 记流水 → 完成或顺延。
 *
 * - 检查间隔 30s（提醒分钟级精度足够）
 * - 错过补发：进程启动时（start 的首次 check）把早于启动时间的到期任务
 *   一次性补发并标记"错过"；重复任务顺延到下一个未来周期点
 * - 通知失败不标记完成，下轮重试（成功指标"提醒零漏发"优先于防重复）
 *   ponytail: 若通知通道持续故障会每 30s 重试一次，M4 接微信后加退避
 */
import type { Job } from "../scheduler/job-store.ts";
import type { Logger } from "../logger.ts";

export class ReminderRunner {
  private readonly store: JobStore;
  private readonly notify: (job: Job, text: string) => void;
  private readonly logger: Logger;
  /** 本次进程启动时间：早于此的到期任务视为"错过" */
  private readonly startedAt: number;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(store: JobStore, notify: (job: Job, text: string) => void, logger: Logger) {
    this.store = store;
    this.notify = notify;
    this.logger = logger;
    this.startedAt = Date.now();
  }

  /** 启动：立即查一遍（补发错过的），然后周期检查 */
  start(intervalMs = 30_000): void {
    this.check();
    this.timer = setInterval(() => this.check(), intervalMs);
  }

  /** 停止（session_shutdown 时调用） */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 检查并触发所有到期任务，返回本次触发的任务 */
  check(now: Date = new Date()): Job[] {
    const fired: Job[] = [];
    for (const job of this.store.pending()) {
      if (new Date(job.at).getTime() > now.getTime()) continue; // 未到点
      const missed = new Date(job.at).getTime() < this.startedAt;
      const text = `⏰ 提醒${missed ? "（错过补发）" : ""}：${job.title}`;
      try {
        this.notify(job, text);
        this.store.appendRun(job, missed ? "missed" : "fired");
        this.logger.info("提醒触发", { id: job.id, missed });
      } catch (e) {
        this.logger.error("提醒通知失败，下一轮重试", { id: job.id, error: String(e) });
        continue; // 不标记完成，等下轮重试
      }
      this.store.finishOrReschedule(job.id, now);
      fired.push(job);
    }
    return fired;
  }
}
