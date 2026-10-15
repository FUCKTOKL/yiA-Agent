/**
 * 提醒触发器：周期检查到期任务 → 等待通知成功 → 记流水 → 完成或顺延。
 * 通知失败保留 pending，下轮重试；一次只跑一轮，慢推送不会被下个周期重复发送。
 * shortcut: 发送成功后若进程在落盘前崩溃，重启可能补发；优先避免漏发，非严格恰好一次。
 */
import type { Job, JobStore } from "./job-store.ts";
import type { Logger } from "../logger.ts";

type Notify = (job: Job, text: string) => void | Promise<void>;

export class ReminderRunner {
  private readonly store: JobStore;
  private readonly notify: Notify;
  private readonly logger: Logger;
  private readonly startedAt: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private checking: Promise<Job[]> | undefined;

  constructor(store: JobStore, notify: Notify, logger: Logger) {
    this.store = store;
    this.notify = notify;
    this.logger = logger;
    this.startedAt = Date.now();
  }

  /** 启动时立即补发，之后每 30 秒检查；顶层异常不变成未处理的 Promise。 */
  start(intervalMs = 30_000): void {
    if (this.timer) return;
    const tick = () => {
      void this.check().catch((e) => {
        this.logger.error("提醒检查失败，下一轮重试", { error: String(e) });
      });
    };
    tick();
    this.timer = setInterval(tick, intervalMs);
  }

  /** 停止新检查，并等待已发出的请求和任务落盘，避免重启时切断收尾。 */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.checking;
  }

  check(now: Date = new Date()): Promise<Job[]> {
    if (!this.checking) {
      this.checking = this.runCheck(now).finally(() => { this.checking = undefined; });
    }
    return this.checking;
  }

  private async runCheck(now: Date): Promise<Job[]> {
    const fired: Job[] = [];
    for (const job of this.store.pending()) {
      if (new Date(job.at).getTime() > now.getTime()) continue;
      // 前一条推送等待期间，用户可能已在另一通道取消这一条。
      if (this.store.byId(job.id)?.status !== "pending") continue;
      const missed = new Date(job.at).getTime() < this.startedAt;
      const text = `⏰ 提醒${missed ? "（错过补发）" : ""}：${job.title}`;
      try {
        await this.notify(job, text);
        this.store.appendRun(job, missed ? "missed" : "fired");
        this.store.finishOrReschedule(job.id, now);
        this.logger.info("提醒触发", { id: job.id, missed });
        fired.push(job);
      } catch (e) {
        this.logger.error("提醒通知或收尾失败，下一轮重试", { id: job.id, error: String(e) });
      }
    }
    return fired;
  }
}
