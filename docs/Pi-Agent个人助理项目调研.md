# 基于 Pi Agent 的个人助理项目 & 其他 Agent 个人助理项目调研

> 数据来源：GitHub Search API + Web 搜索，star 数为查询当日（2026-09）数据，仅供参考。

---

## 一、基于 Pi Agent（Earendil-works/pi）的项目

### 1.1 上游基座

| 项目 | Stars | 简介 |
|------|-------|------|
| [earendil-works/pi](https://github.com/earendil-works/pi) | — | Pi Agent Harness 本体：统一 LLM API、Agent Loop、TUI、编码 Agent CLI。包含 `@earendil-works/pi-coding-agent`（交互式编码 Agent）与 `@earendil-works/pi-ai` 等包，通过 Extensions / Skills / SDK / RPC 支持二次开发 |

### 1.2 基于 Pi SDK 的个人助理 / Agent 应用

| 项目 | Stars | 简介 |
|------|-------|------|
| [hhyqhh/inno-agent](https://github.com/hhyqhh/inno-agent) | ⭐ 1204 | 开源个人学习助理，三层记忆架构（学习者画像 / wiki 知识库 / 会话记忆），基于 Pi Agent SDK 构建 |
| [m-sec-org/BreachWeave](https://github.com/m-sec-org/BreachWeave) | ⭐ 638 | 智能渗透测试 Agent，Manager/Observer/Solver 多角色架构，基于 pi-mono SDK |
| [steel-experiments/durable-researcher](https://github.com/steel-experiments/durable-researcher) | ⭐ 22 | 自托管深度研究 Agent，持久化执行（Pi Agent SDK + Absurd + Steel） |
| [vanzan01/pi-agent-sdk-starter](https://github.com/vanzan01/pi-agent-sdk-starter) | ⭐ 23 | 基于 Pi SDK 的 Agentic 桌面应用脚手架，可配置 Provider |
| [ent-ini/pi-telegram](https://github.com/ent-ini/pi-telegram) | ⭐ 0 | Ini —— 基于 `@earendil-works/pi-coding-agent` 的 Telegram 个人 AI 助理 Bot |

### 1.3 Pi 生态扩展（可组合成个人助理的"零件"）

| 项目 | Stars | 简介 |
|------|-------|------|
| [nicobailon/pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) | ⭐ 1451 | 为 Pi 接入 MCP 服务器的 Token 高效适配器 |
| [nicobailon/pi-web-access](https://github.com/nicobailon/pi-web-access) | ⭐ 1415 | Web 搜索与网页内容提取扩展（助理联网能力） |
| [nicobailon/pi-messenger](https://github.com/nicobailon/pi-messenger) | ⭐ 706 | 多 Agent 通信扩展 |
| [ccch1mneyyy/working-activity](https://github.com/ccch1mneyyy/working-activity) | ⭐ 659 | 状态可视化扩展（RunCat 式工作指示） |
| [nicobailon/pi-interactive-shell](https://github.com/nicobailon/pi-interactive-shell) | ⭐ 582 | 让 Pi 自主操控交互式 CLI |
| [narumiruna/pi-extensions](https://github.com/narumiruna/pi-extensions) | ⭐ 541 | Pi 扩展 monorepo（多合一扩展集合） |
| [nicobailon/pi-intercom](https://github.com/nicobailon/pi-intercom) | ⭐ 508 | 多会话间通信扩展 |
| [tmustier/pi-extensions](https://github.com/tmustier/pi-extensions) | ⭐ 476 | 一组实用的 Pi 扩展合集 |
| [fitchmultz/pi-cursor-sdk](https://github.com/fitchmultz/pi-cursor-sdk) | ⭐ 322 | 在 Pi 中运行 Cursor 的 Agent Loop |
| [m-sec-org 系列 / cdervis/Pendant](https://github.com/cdervis/Pendant) | ⭐ 165 | Pi 的 VS Code 扩展 |
| [prateekmedia/claude-agent-sdk-pi](https://github.com/prateekmedia/claude-agent-sdk-pi) | ⭐ 116 | 把 Claude Agent SDK 作为 Pi 的 Provider |
| [yinguangyao/coding-agent-runner](https://github.com/yinguangyao/coding-agent-runner) | ⭐ 23 | ACP 兼容的 Node.js SDK，统一驱动 Codex / Claude Code / Cursor / OpenCode / Pi |

### 1.4 小结

Pi 生态的个人助理项目目前以 **SDK 嵌入 + 扩展组合** 为主要形态：
- **助理形态**：Telegram Bot（pi-telegram）、学习助理（inno-agent）、研究 Agent（durable-researcher）
- **能力来源**：官方扩展机制 + 社区扩展（联网搜索、MCP、多 Agent 协作）
- **典型架构**：Pi SDK 做核心循环 + 自定义工具/记忆层 + IM 渠道（Telegram）做交互入口

---

## 二、其他基于 Agent 的个人助理项目

### 2.1 头部项目

| 项目 | Stars | 简介 |
|------|-------|------|
| [openclaw/openclaw](https://github.com/openclaw/openclaw) | ⭐ 389425 | 当前最火的个人 AI 助理（"The AI that really does things"），全平台、全 OS，可通过消息渠道（WhatsApp/Telegram 等）全天候指挥 Agent 执行任务 |
| [mem0ai/mem0](https://github.com/mem0ai/mem0) | ⭐ 65107 | AI Agent 记忆层基础设施，个人助理的核心组件（长期记忆/用户画像），可 drop-in 接入任意 Agent |
| [aaif-goose/goose](https://github.com/aaif-goose/goose) | ⭐ 54117 | Block 开源的可扩展 AI Agent，超越代码补全——安装扩展、执行任务、自动化日常工作流 |
| [khoj-ai/khoj](https://github.com/khoj-ai/khoj) | ⭐ 37266 | AI 第二大脑：自托管，回答网页/个人文档问题，可构建自定义 Agent，支持桌面/Emacs/Obsidian/Web |
| [letta-ai/letta](https://github.com/letta-ai/letta) | ⭐ 24698 | 有状态 Agent 平台（原 MemGPT），具备高级记忆、可持续学习自我改进，适合构建长期运行的助理 |
| [leon-ai/leon](https://github.com/leon-ai/leon) | ⭐ 17502 | 老牌开源个人助理，模块化技能（skills）体系，本地优先、注重隐私 |

### 2.2 中小型/特色项目

| 项目 | Stars | 简介 |
|------|-------|------|
| [the-open-agent/openagent](https://github.com/the-open-agent/openagent) | ⭐ 5612 | 新一代个人 AI 助理：LLM + RAG + Agent Loop，支持 computer-use |
| [Zafer-Liu/Data-Analysis-Agent](https://github.com/Zafer-Liu/Data-Analysis-Agent) | ⭐ 2513 | 私人数据分析助理：对话式生成可视化报表与商业洞察 |
| [Run-Tu/MindFlow](https://github.com/Run-Tu/MindFlow) | ⭐ 207 | 多模态个人助理，让 LLM 在本地运行代码 |
| [PersonalJarvis/PersonalJarvis](https://github.com/PersonalJarvis/PersonalJarvis) | ⭐ 41 | 自托管语音助理：语音问答、听写、操控本地应用 |
| [akyourowngames/A.N.K.I.T.A](https://github.com/akyourowngames/A.N.K.I.T.A) | ⭐ 3 | Python 个人助理：语音 + 记忆 + Telegram + 桌面工具 + 项目监控 |

---

## 三、横向对比与启示

| 维度 | Pi 生态助理 | 通用 Agent 助理 |
|------|------------|----------------|
| 定位 | 编码 Agent 内核扩展为助理 | 生而为人助理设计 |
| 优势 | 工具调用/文件操作/终端能力强；扩展机制成熟；SDK 可嵌入 | IM 渠道、语音、记忆、日程等助理场景原生支持 |
| 交互入口 | 终端 TUI / RPC / 自建（如 Telegram Bot） | 原生 App / Web / IM / 语音 |
| 记忆 | 会话树 + compaction，需自建长期记忆（可接 mem0） | 普遍内置记忆层（letta/mem0/khoj） |

**对 Pi 二次开发做个人助理的启示**：

1. **渠道层**：参考 `ent-ini/pi-telegram`，用 Pi SDK + Telegram/微信 Bot 做交互入口
2. **能力层**：组合社区扩展——`pi-web-access`（联网）、`pi-mcp-adapter`（接 MCP 工具生态）、`pi-messenger`（多 Agent 协作）
3. **记忆层**：Pi 自带会话树/压缩，长期记忆可对接 mem0 或参考 `inno-agent` 的三层记忆架构
4. **调度层**：用 Extension 的 `pi.registerCommand()` + 系统定时任务实现主动提醒/日程类功能
5. **分发层**：打包成 Pi Package（npm/git）共享

> 注：openclaw 的爆火（38w+ star）印证了"IM 渠道 + 常驻 Agent + 工具执行"是个人助理类项目的主流形态，Pi 的 RPC/SDK 模式天然适配这种架构。
