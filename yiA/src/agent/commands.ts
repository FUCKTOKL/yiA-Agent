/**
 * yiA 自定义命令（M5）：只注册 pi 原生没有的能力。
 *
 * 与 pi 原生命令的关系（不重复造轮子）：
 *   新对话 → /new            历史会话 → /resume
 *   选模型 → /model(Ctrl+S 存默认)   凭证 → /login /logout
 *   会话信息 → /session      改名 → /name   退出 → /quit
 *   （曾实现 /sessions、/setting，因与 /resume、/settings 冲突已删除）
 *
 * 本文件注册三个：
 *   /reminder  查看提醒/事项列表
 *   /brain     知识库浏览器（.md 列表 → 选择 → 打开）
 *   /wechat    微信绑定（状态/换绑/推送目标，全程在 yiA 内完成）
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSelectListTheme, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { Markdown, ScrollView, SelectList, Text, matchesKey, Key } from "@earendil-works/pi-tui";
import type { JobStore } from "../scheduler/job-store.ts";
import type { L2Store } from "../memory/l2/store.ts";

export interface CommandDeps {
  /** 项目根（读 runtime/ 配置用） */
  root: string;
  jobs: JobStore;
  l2: L2Store;
}

export function registerYiaCommands(pi: ExtensionAPI, deps: CommandDeps): void {
  const { root, jobs } = deps;

  // ---- /reminder：提醒列表 ----
  pi.registerCommand("reminder", {
    description: "查看提醒/事项列表",
    handler: async (_args, ctx) => {
      const list = jobs.pending();
      if (list.length === 0) {
        ctx.ui.notify("当前没有待触发的提醒", "info");
        return;
      }
      const lines = list
        .map(
          (j) =>
            `${new Date(j.at).toLocaleString("zh-CN")}` +
            `${j.repeatDays ? `（每 ${j.repeatDays} 天）` : ""}` +
            `${j.channel === "wechat" ? " [微信]" : ""} ${j.title}`
        )
        .join("\n");
      ctx.ui.notify(`待触发提醒（${list.length} 条）：\n${lines}`, "info");
    },
  });

  // ---- /brain：知识库浏览器 ----
  // Enter 看列表（全部 L2 条目，均为 .md）→ 选中 Enter 打开 → 上下键滚动 / PgUp PgDn 翻页 / ESC 关闭
  pi.registerCommand("brain", {
    description: "浏览知识库（存储的 .md 条目列表，选中打开）",
    handler: async (_args, ctx) => {
      const entries = deps.l2.all();
      if (entries.length === 0) {
        ctx.ui.notify("知识库还是空的，用对话存点东西吧（\"记住…\"）", "info");
        return;
      }
      // 非 TUI 环境（print/微信）退化为纯文本列表；TUI 走选择器+查看器
      if (ctx.mode !== "tui") {
        ctx.ui.notify(entries.map((e) => `[${e.id}] ${e.title}`).join("\n"), "info");
        return;
      }
      const picked = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        const list = new SelectList(
          entries.map((e) => ({
            value: e.path,
            label: e.title,
            description: `${e.created.slice(0, 10)}${e.tags.length ? "  " + e.tags.join(",") : ""}`,
          })),
          Math.min(entries.length + 2, 16),
          getSelectListTheme(),
        );
        list.onSelect = (item) => done(item.value);
        list.onCancel = () => done(null);
        const header = new Text(
          theme.fg("accent", theme.bold(`知识库（${entries.length} 条，↑↓选择 Enter打开 ESC退出）`)),
          1, 1,
        );
        // 注意：不能用 Container 包（它是纯布局组件，没有 handleInput，
        // 键盘事件不会转发给子组件）——手写组合件直接转发按键
        return {
          render(width: number): string[] {
            return [...header.render(width), ...list.render(width)];
          },
          invalidate(): void {
            header.invalidate();
            list.invalidate();
          },
          handleInput(data: string): void {
            list.handleInput(data);
          },
        };
      });
      if (!picked) return;
      await showMarkdown(ctx, picked);
    },
  });

  // ---- /wechat：微信绑定（状态 / 换绑 / 推送目标，全部在 TUI 内完成） ----
  pi.registerCommand("wechat", {
    description: "微信绑定状态与换绑（全程在 yiA 内完成）",
    handler: async (_args, ctx) => {
      // 注意：ctx.ui.select 只支持纯字符串数组（不支持 {label,value} 对象）
      const options = [
        "查看绑定状态",
        "换绑微信（登出 → 扫码 → 配对 → 改推送目标）",
        "仅修改推送目标 targetPeer",
      ];
      const choice = await ctx.ui.select("微信绑定", options);
      if (!choice) return;
      if (choice === options[0]) return await showChannelStatus(ctx, root);
      if (choice === options[1]) return await rebindWechat(ctx, root);
      if (choice === options[2]) return await editTargetPeer(ctx, root);
    },
  });
}

// ==================== /brain 查看器 ====================

/** 用 ScrollView + Markdown 全屏打开一个 md 文件，ESC 关闭 */
async function showMarkdown(
  ctx: ExtensionContext,
  file: string,
): Promise<void> {
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch (e) {
    ctx.ui.notify(`文件读取失败：${String(e).slice(0, 100)}`, "error");
    return;
  }
  await ctx.ui.custom<null>((tui, theme, _kb, done) => {
    const md = new Markdown(content, 1, 1, getMarkdownTheme());
    const scroll = new ScrollView(md, { scrollbar: "always", primary: true });
    const header = new Text(
      theme.fg("accent", ` ${file.split("/").pop() ?? file} `) +
        theme.fg("muted", "（↑↓滚动 PgUp/PgDn 翻页 ESC 关闭）"),
      1,
      0,
    );
    return {
      render(width: number): string[] {
        return [...header.render(width), ...scroll.render(width)];
      },
      invalidate(): void {
        header.invalidate();
        scroll.invalidate();
      },
      handleInput(data: string): void {
        if (matchesKey(data, Key.escape)) {
          done(null);
          return;
        }
        if (matchesKey(data, Key.up)) scroll.scrollBy(-1);
        else if (matchesKey(data, Key.down)) scroll.scrollBy(1);
        else if (matchesKey(data, Key.pageUp)) scroll.scrollBy(-20);
        else if (matchesKey(data, Key.pageDown)) scroll.scrollBy(20);
        else if (matchesKey(data, Key.home)) scroll.scrollToStart();
        else if (matchesKey(data, Key.end)) scroll.scrollToEnd();
        else return;
        tui.requestRender();
      },
    };
  });
}

// ==================== /wechat 微信绑定工具 ====================
// 核心操作（登出/网关控制/账号解析）在 src/channels/weixin-ops.ts，与 Web 端共用
import { runCapture, parseWeixinAccounts, gatewayCtl, logoutAllWeixinAccounts, bindCurrentAccount, validWechatPeer } from "../channels/weixin-ops.ts";

/** 在全屏面板里跑长命令：实时流式显示输出（含二维码），ESC 中止；
 *  检测到验证码提示时行内输入，Enter 提交到子进程 stdin。返回退出码。 */
function runStream(
  ctx: ExtensionContext,
  title: string,
  cmd: string,
  args: string[],
): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: process.env });
    const lines: string[] = [title, ""];
    let awaitingCode = false;
    let codeBuf = "";
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };

    const push = (text: string) => {
      for (const raw of text.split("\n")) {
        lines.push(raw.replace(/\r/g, ""));
      }
      if (/验证码|verify[_ ]?code/i.test(text)) {
        awaitingCode = true;
        codeBuf = "";
      }
    };
    child.stdout.on("data", (d) => push(d.toString()));
    child.stderr.on("data", (d) => push(d.toString()));
    child.on("close", (code) => finish(code));
    child.on("error", (e) => {
      push(String(e));
      finish(null);
    });

    void ctx.ui.custom<number | null>((tui: any, theme: any, _kb: any, done: (v: number | null) => void) => {
      return {
        render(width: number): string[] {
          const visible = lines.slice(-40);
          const body = visible.map((l) => (l.length > width ? l.slice(0, width) : l));
          if (awaitingCode) body.push("  验证码 > " + codeBuf);
          body.push("");
          body.push(
            theme.fg(
              "muted",
              awaitingCode ? "请输入验证码后回车（直接提交）｜ESC 中止" : "ESC 中止",
            ),
          );
          return body;
        },
        invalidate(): void {},
        handleInput(data: string): void {
          if (matchesKey(data, Key.escape)) {
            child.kill();
            done(null);
            return;
          }
          if (awaitingCode) {
            if (matchesKey(data, Key.enter)) {
              child.stdin?.write(codeBuf + "\n");
              lines.push("  → 已提交验证码");
              awaitingCode = false;
            } else if (matchesKey(data, Key.backspace)) {
              codeBuf = codeBuf.slice(0, -1);
            } else {
              codeBuf += data; // 可见字符（含中文多字节）
            }
          }
          tui.requestRender();
        },
      };
    }).then((code) => {
      if (code === null) child.kill();
      finish(code as number | null);
    });
  });
}

async function showChannelStatus(ctx: any, root: string): Promise<void> {
  let peer = "（未配置）";
  try {
    const cfg = JSON.parse(readFileSync(join(root, "runtime/config/wechat.json"), "utf8"));
    peer = cfg.targetPeer ?? peer;
  } catch {}
  ctx.ui.notify("查询中…", "info");
  const r = await runCapture("openclaw", ["channels", "status", "--probe"]);
  ctx.ui.notify(`推送目标：${peer}\n\n${r.out.trim() || "（无输出）"}`, "info");
}

async function editTargetPeer(ctx: any, root: string): Promise<void> {
  const file = join(root, "runtime/config/wechat.json");
  if (!existsSync(file)) {
    ctx.ui.notify("尚未部署微信侧车，请先跑 bash yiA/scripts/provision.sh", "warning");
    return;
  }
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    ctx.ui.notify("微信配置无法读取，请先修复配置文件。", "error");
    return;
  }
  const input = await ctx.ui.input("新的推送目标（微信 id，形如 oXXXX...@im.wechat）：", cfg.targetPeer);
  // 真实 peer id 是长不透明串（o+20位左右）；填昵称会静默推送失败
  //（ret=-3 invalid arguments —— 2026-09-14 E2E 体检事故：填了昵称“瓜皮”）
  if (!input || !/^o[A-Za-z0-9_-]{15,}@im\.wechat$/.test(input.trim())) {
    ctx.ui.notify("未修改：这不是微信 peer id（不能用昵称！查法：/wechat 状态里的对话方，或网关日志 chatId=）", "warning");
    return;
  }
  cfg.targetPeer = input.trim();
  writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  ctx.ui.notify(`推送目标已更新：${cfg.targetPeer}`, "info");
}

async function rebindWechat(ctx: any, root: string): Promise<void> {
  const ok = await ctx.ui.confirm("换绑微信", "将登出全部已登录微信账号并用新号扫码，继续？");
  if (!ok) return;

  // 1) 登出全部已登录账号（插件不支持 CLI logout，用凭据文件移除法；
  //    残留旧账号会导致双账号并存：旧号继续可用、推送发错号 —— 2026-09-14 事故）
  const moved = await logoutAllWeixinAccounts((m) => ctx.ui.notify(m, "info"));
  if (moved.length > 0) ctx.ui.notify(`已登出：${moved.join(", ")}`, "info");

  // 2) 扫码登录（全屏显示二维码，流式刷新状态；如需验证码行内输入）
  const code = await runStream(
    ctx,
    "── 微信扫码登录（ESC 中止）──",
    "openclaw",
    ["channels", "login", "--channel", "openclaw-weixin"],
  );
  if (code !== 0) {
    ctx.ui.notify("登录未完成（中止或失败）", "warning");
    return;
  }

  // 3) 解析新账号 id 并写入配置（发送时指定 accountId，防多账号歧义）
  const file = join(root, "runtime/config/wechat.json");
  const boundAccount = await bindCurrentAccount(file);
  if (boundAccount) {
    ctx.ui.notify(`发送账号已绑定：${boundAccount}`, "info");
  }

  // 4) 配对：提示用新号发条消息，然后列出待批准项
  const ready = await ctx.ui.confirm("配对", "请用新号给 bot 微信发一条消息，发好后点确认（会列出待批准的配对）");
  if (ready) {
    const list = await runCapture("openclaw", ["pairing", "list", "openclaw-weixin"]);
    ctx.ui.notify(list.out.trim() || "（无输出）", "info");
    const codeToApprove = await ctx.ui.input("输入要批准的配对码（留空跳过）：");
    if (codeToApprove?.trim()) {
      const ap = await runCapture("openclaw", ["pairing", "approve", "openclaw-weixin", codeToApprove.trim()]);
      ctx.ui.notify(ap.out.trim() || "已批准", "info");
    }
  }

  // 5) 更新推送目标（提醒发到这个号）
  await editTargetPeer(ctx, root);

  // 6) 重启网关生效
  ctx.ui.notify("重启 Gateway 生效…", "info");
  await gatewayCtl("restart");
  ctx.ui.notify("换绑完成 ✅（发条微信消息验证对话，再设个 2 分钟提醒验证推送）", "info");
}
