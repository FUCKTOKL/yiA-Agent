/**
 * 提醒任务持久化（PRD F2.2）：jobs.json + runs.jsonl。
 *
 * - jobs.json：全部任务，整文件重写（任务量小，简单可靠）
 * - runs.jsonl：触发流水（只追加），供审计
 * - 任务模型：一次性（无 repeatDays）或每 N 天重复（repeatDays）
 * - 微信渠道字段 M4 启用；M3 只有 tui
 *
 * 并发设计：**无内存缓存，每次操作都是 读文件→改→写回**。
 * 原因：用户会「TUI 常驻 + 另开 pi -p」双进程并用，若持有内存快照，
 * 先后 flush 会互相覆盖导致丢任务（tests/scheduler.test.ts 有复现用例）。
 * ponytail: 两个进程同一毫秒同时写仍会后写覆盖先写——出现频率极低，
 * 真遇到再加文件锁（flock）或改 SQLite。
 *
 * 异常容错（PRD §10.2）：jobs.json 损坏 → 备份为 .bak 后从空表降级，不崩。
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Job {
  id: string;
  title: string;
  at: string; // 下次触发时间（ISO 8601，本地时区偏移或 UTC 均可）
  repeatDays?: number; // 每 N 天重复；缺省一次性
  channel: "tui" | "wechat"; // 回推渠道（M4 起微信可用）
  createdAt: string;
  status: "pending" | "done" | "cancelled";
}

export class JobStore {
  private readonly file: string;
  private readonly runsFile: string;

  constructor(file: string, runsFile: string) {
    this.file = file;
    this.runsFile = runsFile;
    mkdirSync(dirname(this.file), { recursive: true });
    mkdirSync(dirname(this.runsFile), { recursive: true });
  }

  /** 全部任务（每次都从文件读，保证看到其他进程的改动） */
  all(): Job[] {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      return Array.isArray(raw) ? raw : [];
    } catch {
      // 文件不存在（首次）或损坏：损坏时备份原文件后从空表开始（测试方案 §4 破坏性用例）
      try {
        renameSync(this.file, this.file + ".bak");
      } catch {
        // 文件不存在的情况，忽略
      }
      return [];
    }
  }

  /** 待触发任务，按时间升序 */
  pending(): Job[] {
    return this.all()
      .filter((j) => j.status === "pending")
      .sort((a, b) => a.at.localeCompare(b.at));
  }

  /** 新建任务（读→追加→写回） */
  add(p: Pick<Job, "title" | "at" | "channel"> & { repeatDays?: number }): Job {
    const job: Job = {
      id: newId(),
      title: p.title.trim(),
      at: p.at,
      repeatDays: p.repeatDays,
      channel: p.channel,
      createdAt: new Date().toISOString(),
      status: "pending",
    };
    const jobs = this.all();
    jobs.push(job);
    this.flush(jobs);
    return job;
  }

  /** 按 id 查任务 */
  byId(id: string): Job | null {
    return this.all().find((j) => j.id === id) ?? null;
  }

  /** 取消待触发任务；返回是否取消成功 */
  cancel(id: string): boolean {
    const jobs = this.all();
    const job = jobs.find((j) => j.id === id);
    if (!job || job.status !== "pending") return false;
    job.status = "cancelled";
    this.flush(jobs);
    return true;
  }

  /**
   * 触发后收尾（读→按 id 定位→改→写回）：
   * 重复任务顺延到下一个未来周期点，一次性标记完成。
   * 若另一进程已把它标记为非 pending（重复触发防护），本调用为无操作。
   */
  finishOrReschedule(id: string, now: Date): void {
    const jobs = this.all();
    const job = jobs.find((j) => j.id === id);
    if (!job || job.status !== "pending") return;
    if (job.repeatDays && job.repeatDays > 0) {
      // 顺延到第一个晚于 now 的周期点（进程停了几天也只补一次，不逐个补发）
      let t = new Date(job.at).getTime();
      const step = job.repeatDays * 86_400_000;
      while (t <= now.getTime()) t += step;
      job.at = new Date(t).toISOString();
    } else {
      job.status = "done";
    }
    this.flush(jobs);
  }

  /** 追加一条触发流水 */
  appendRun(job: Job, kind: "fired" | "missed"): void {
    appendFileSync(
      this.runsFile,
      JSON.stringify({ ts: new Date().toISOString(), kind, id: job.id, title: job.title, at: job.at }) + "\n",
      "utf8"
    );
  }

  private flush(jobs: Job[]): void {
    writeFileSync(this.file, JSON.stringify(jobs, null, 2) + "\n", "utf8");
  }
}

/** 生成任务 id：r + 时间戳 + 随机后缀 */
function newId(): string {
  return (
    "r" +
    new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14) +
    "-" +
    Math.random().toString(36).slice(2, 6)
  );
}
