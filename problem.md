# problem.md — 开放性问题与解答

> 记录关于 yiA 的疑问与当前答案，随项目演进而更新（2026-09-14）。

## 1. 是否留有下一步功能扩展的接口或模块？

**有，扩展点集中在四处：**

| 扩展点 | 位置 | 说明 |
|---|---|---|
| Agent 工具 | `yiA/src/agent/tools.ts` + `yia-extension.ts` | 工具用 `registerTool` 注册，新增能力（如笔记、待办、抓网页）照抄 remember/recall 的模式即可，无需动内核 |
| 记忆层 | `yiA/src/memory/{l1,l2,l3}/` | L2 检索是 BM25 起步、**预留向量检索升级位**（PRD F1.3）；条目是纯 Markdown+frontmatter，换索引不动数据 |
| 渠道 | `yiA/src/channels/`（registry + clawbot） | 微信走 `ClawbotSender` 抽象；加 Telegram/飞书等渠道=新增一个 sender + 注册进 registry，提醒路由已按 channel 字段分发 |
| 提醒调度 | `yiA/src/scheduler/` | jobs.json/runs.jsonl 与触发器解耦，daemon 是唯一触发者；换 cron 表达式等只改 runner |

另外 Pi 本身的 ExtensionAPI / SDK（内核零改动）就是设计边界：所有 yiA 功能都走公开 API，Pi 升级不受我们绑架。规划中的 M6（Web）、M7（知识图谱）都有既定落点（`src/server/`、`web/`）。

## 2. 开源到 GitHub 后，别人能部署在自己的电脑上吗？

**可以，这是设计目标，但有三个前置条件：**

1. **WSL（Linux）环境**：当前部署脚本、systemd 服务、路径都是 WSL Ubuntu 24.04 验证的；macOS 大概率可用（systemd 需换成 launchd 或手动跑 daemon），Windows 原生不支持（历史上有 provision-windows.sh，已弃）
2. **自己的模型凭据**：`runtime/agent/`（auth/settings/会话）整体 gitignored，不外泄；新用户跑 `provision.sh` 从自己已登录的 pi 迁移凭据，或直接在 `runtime/agent/auth.json` 配自己的 API key（默认模型 glm-5.3，可换任何 Pi 支持的模型）
3. **自己的微信**：扫码登录自己的 bot 号 + 配对自己的个人号，与我的账号零关系

**已经做对的隔离**：密钥不入库、runtime/ 可整体备份、代码与数据分离。**开源前要补的**：README 部署一节（前置依赖：Node≥20.6、openclaw、WSL）+ `provision.sh` 对"无既有 pi"用户的空机路径。工作量约半天。

## 3. 一次对话的最大上下文是多少？

**取决于所用模型，不是 yiA 限的。** 当前配置 `runtime/agent/settings.json`：`glm-5.3`（zai-coding-cn），GLM 系列上下文窗口以智谱官方规格为准（128K~200K tokens 量级，约 15~30 万字中文）。

- 上下文 = system prompt + 注入的 ContextPack（画像/相关记忆/时间）+ 本会话全部往来消息
- 快满时 Pi 会**自动压缩（compaction）**早期内容为摘要，会话可以一直聊下去，但最早细节会被压缩掉
- L3 会话索引（SQLite FTS5）独立持久化全部原文，压缩不影响"翻旧账"检索
- 换模型只改 settings.json 的 defaultModel，上下文上限随之变化

## 4. yiA 可以下载 Pi 的插件和其他 skill 吗？

**可以。** yiA 的 agent 运行时就是完整的 pi 运行时（独立 agentDir=`runtime/agent/`），Pi 的包机制（packages：插件扩展、skill、自定义工具）对 yiA 全部可用：

- 插件/skill 装到运行时的 `runtime/agent/npm/` 下，与个人 pi（`~/.pi/agent/npm/`）**互不污染**
- 安装方式与 pi 一致（pi 的包安装命令，或手动放目录），装完重启 yiA 会话即生效
- 实际案例：yiA 已在用 pi 生态的组件（fd/rg 二进制从 pi bin 引入）；skill 是纯 Markdown 指令文件，放对位置就能被 agent 按需加载
- 注意：第三方插件质量参差，装进 yiA 的插件会拿到与 yiA 相同的工具权限（含写 runtime/），开源后建议只在 README 推荐可信来源
