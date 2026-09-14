# Inno Agent 技术架构拆解

> 项目地址：https://github.com/hhyqhh/inno-agent
> 定位：**基于 Pi SDK 构建的开源个人学习智能体**（三层记忆 + 主动调度 + IM 渠道 + 练习实验室）
> 数据来源：GitHub API、仓库源码与 README（2026-09 查询）

---

## 1. 项目概况

| 项 | 内容 |
|---|---|
| 作者 | Hao Hao, Ye Lu, Ruotong Yang, Yongheng Guo, Aimin Zhou（华东师大团队） |
| 创建 / 活跃 | 2026-05-28 创建，持续更新中 |
| Stars / Forks | ⭐ 1204 / 224 |
| License | MIT |
| 语言构成 | TypeScript 89% · Python 7% · CSS/HTML/JS/Shell/Dockerfile 少量 |
| 版本 | v0.5.5（npm monorepo，Node >= 20.6） |
| 官网 / 论文 | hhyqhh.github.io/inno-agent-website · 技术报告（arXiv, 2026-06） |
| Topics | learning-agent · llm-agent · memory · pi-sdk · electron · cli · personal-knowledge-management |

**一句话**：把 Pi（一个终端编码 Agent）不改内核地改造成"一对一长期学习伙伴"——所有学习行为通过注册工具 + 一个扩展钩子实现，运行时始终与上游 Pi SDK 兼容。

## 2. 设计哲学（4 条核心立场）

1. **分层记忆，而非扁平聊天摘要**——学习者状态、归档知识、近期对话生命周期不同，各自独立成层。
2. **持久事实写入工具，而非回复**——凡影响后续教学的内容都通过工具写入 L1/L2，个性化决策有据可查。
3. **开放可纠正的学习者模型**——L1 画像对用户可检视可编辑，系统提示词禁止无证据打标签。
4. **永不修改 SDK 内核**——与上游 Pi 版本解耦，升级无痛。

## 3. 总体架构（四层）

```
用户界面          CLI · Web UI (React 19) · Electron 桌面 · 飞书 · 微信 · QQ
        ↓
应用层            渠道适配 (ChannelRegistry) · HTTP API (SSE) · 记忆编排
                  cron 调度器 · 练习实验室 (WebSocket 终端) · 内容中心
        ↓
Agent 运行时      Pi AgentSession · 注册工具 (~10 组) · inno 扩展钩子
(Pi SDK,未修改)   任意 LLM 供应商 (openai-completions / anthropic-messages)
        ↓
分层记忆          L1 学习者画像 · L2 原生 wiki 知识库 · L3 会话记录检索
```

三种形态（桌面 / Web / CLI）共享同一份运行时状态（`runtime/` 目录：config + data + skills）。

## 4. 三层记忆系统（核心创新）

### L1 学习者画像（`src/memory/learner/`，约 15 个模块）

- **内容**：学习目标（goals，带 priority/status）、概念级知识状态（mastery 0~1 + 状态标签）、误解记录、偏好。
- **状态机**：`state-engine.ts` 基于证据（`evidence.ts` 事件日志）投影概念状态，状态优先级：`misconception > review_due > unknown > learning > fragile > stable`。
- **上下文包**：`context-pack.ts` 每轮把画像压缩为 ContextPack（当前目标 + 5 个最需干预的概念），经扩展的 `before_agent_start` 钩子注入系统提示词。
- **画像更新**：`auto-profile.ts`（17KB）自动从对话中抽取学习事件；`prerequisite-resolver.ts` 维护概念先修图。
- **存储**：JSON 文件（`profile-store.ts`）+ 事件日志。

### L2 原生 wiki 知识库（`src/memory/l2/`，约 25 个模块，是代码量最大的一层）

- **形态**：人类可读的 Markdown wiki 页面 + 机器可查询的工具接口，供 agent 与用户双端使用。
- **检索**：混合检索 = 词法 BM25（`l2-search.ts`）+ 知识图谱（`wiki-graph.ts`，graphology 库 + Louvain 社区检测做聚类）。
- **生成管线**：`wiki-generator.ts`（39KB，最大单文件）LLM 辅助生成/摘要页面；`wiki-linker.ts`（30KB）自动建立页面间链接；`wiki-maintainer.ts` 增量维护与去重。
- **摄入**：支持 PDF/Office/图片——`document-parser.ts`（llamaindex liteparse）+ OCR（PaddleOCR-VL API）+ `structural-chunker.ts` 结构化分块 + `summarizer.ts`。
- **质量**：`l2-lint.ts` 对 wiki 页面做 lint 校验。
- **存储**：Markdown 文件 + manifest（`manifest-store.ts`）+ 索引（`l2-index-store.ts`）。

### L3 会话记录与跨对话检索（`src/memory/l3/`，5 个模块）

- **存储**：叠加在 Pi 原生会话 JSONL 文件之上的 **SQLite FTS5 全文索引**（`sqlite-store.ts`）。
- **召回**：`recall.ts` 按相关性阈值**门控**——检索分数不够高就不注入，避免噪声污染上下文；召回内容格式化后同样经钩子注入系统提示词。

## 5. Agent 运行时层：与 Pi SDK 的集成方式

这是"基于 Pi 二次开发"的标准范式，值得重点拆解：

### 5.1 单一扩展工厂

`src/agent/inno-extension.ts`（30KB）导出一个 `ExtensionFactory`，集中完成：

```typescript
// 伪代码归纳自源码
export const createInnoExtension: ExtensionFactory = (pi) => {
  pi.registerProvider(...)                    // 注册自定义 LLM 供应商
  pi.registerTool(createLearnerTools(...))    // L1 画像工具
  pi.registerTool(createL2Tools(...))         // L2 wiki 工具（archive/query）
  pi.registerTool(createL3Tools(...))         // L3 会话召回工具
  pi.registerTool(createSchedulerTools(...))  // cron 任务 CRUD
  pi.registerTool(createChannelTools(...))    // IM 发消息
  pi.registerTool(createPracticeTools(...))   // 练习实验室
  pi.registerTool(createDocumentTools(...))   // 文档摄入
  pi.registerTool(createOcrTools(...))        // OCR
  pi.registerTool(createTavilyTools(...))     // Tavily 联网搜索
  pi.on("before_agent_start", ...)            // 注入 L1 上下文包 + L3 门控召回
}
```

### 5.2 其他运行时组件（`src/agent/`）

| 文件 | 职责 |
|---|---|
| `pi-runner.ts`（60KB，最大文件） | AgentSession 生命周期管理：创建、多会话、工作区绑定 |
| `system-prompt.ts`（14KB） | 教学系统提示词 + 新手引导 |
| `workspace-path-guard.ts` | 路径防护：限制文件操作在 workspace 内 |
| `observability-extension.ts` | 可观测性扩展（trace/log） |
| `mcp-extension.ts` | 通过 pi-mcp-adapter 接入 MCP 工具生态 |
| `question-bridge.ts` | agent 提问 → 用户交互的桥接 |
| `provider-sync.ts` | 为 pi-subagents 同步供应商配置 |

### 5.3 Pi 生态依赖（直接复用社区扩展，而非重造）

| 依赖 | 用途 |
|---|---|
| `@earendil-works/pi-coding-agent` + `pi-ai` ^0.84.2 | Agent 主循环 + 模型抽象 |
| `pi-web-access` ^0.24 | 联网搜索/网页提取扩展 |
| `pi-mcp-adapter` 2.21 | MCP 协议接入 |
| `pi-subagents` ^0.51 | 子 Agent 编排 |
| `pi-sandbox` 0.4.3 | 系统级沙箱（可选，需 ripgrep） |
| `@earendil-works/pi-web-ui` ^0.75 | 前端聊天 UI 组件库（官方 Web 组件） |

## 6. 应用层

### 6.1 HTTP 服务（`src/server.ts` + `src/server/`）

- **原生 Node `http.createServer`，无 Express/Fastify**——零框架依赖。
- **SSE** 流式对话（`routes/chat.ts` 41KB）+ `stream-registry.ts` 管理并发流。
- **WebSocket** 终端（练习实验室，`node-pty` + xterm.js）。
- 路由模块：chat / sessions / wiki / jobs / learner / practice / skills / workspaces / settings / channels / attachments / presets / checkins / commands。
- `trace-store.ts`：agent 执行轨迹存储。

### 6.2 调度器（`src/scheduler/`）

- 自然语言创建 cron 任务（agent 调工具 → `cron-parser` 解析）。
- 持久化：`jobs.json` + `runs.jsonl`，支持延迟执行（`deferred-runs.ts`）、签到打卡（`checkins/`）。
- 触发来源三路：agent 工具调用 / UI / 守护进程，执行后经渠道 dispatcher 回推提醒。

### 6.3 IM 渠道（`src/channels/`）

- `ChannelRegistry` 统一注册；飞书（`@larksuiteoapi/node-sdk`，原生 API + 流式卡片）、微信（iLink 扫码登录 或 bridge 模式 sidecar 进程）、QQ（bridge）。
- `personal-dispatcher.ts`：统一消息分发/回推；`dedupe-store.ts` 消息去重。

### 6.4 内容中心（`src/content-source/`）

- 技能库与"简单模式"预设从远程 Hub 拉取——默认 GitHub 仓库（`Chloris-Blaxk/inno-agent-hub`），可切换自建 bundle 服务（`scripts/content-hub-server/`，零依赖 Node 服务）。
- 本地缓存 + 应用内置模板离线兜底。

### 6.5 工作区体系（`src/workspace/`）

- 多工作区注册表：每个工作区可有自己的 `agent.md`（每轮注入提示词）和 `.skills/` 私有技能（与全局技能合并）——即"工作区级 Practice Lab"。

## 7. 前端架构（`apps/inno-agent/web/`）

| 层 | 技术 |
|---|---|
| 框架 | React 19 + Vite 6 + Tailwind 4 |
| 状态 | **框架无关的 `EventEmitter` stores**（`web/src/stores/`），API 调用独立在 `web/src/api/` |
| 聊天流渲染 | streamdown（+ code/math/mermaid/cjk 插件） |
| 编辑器 | CodeMirror 6（12 种语言）/ @uiw/react-md-editor |
| 可视化 | ECharts 6、Cytoscape（wiki 知识图谱，cola/cose 布局）、viz-js（Graphviz）、PlantUML |
| 终端 | xterm.js + addon-fit/web-links |
| 其他 | i18next 中英双语、lit（Web 组件）、docx-preview、react-arborist 树、react-dnd 拖拽 |

特色功能：对话分支编辑（重新编辑已发消息并从该节点重新生成，旧分支不进上下文——复用 Pi 会话树）、四套主题、markdown 表格/图表操作菜单。

## 8. 桌面端与部署

- **Electron 42** + electron-builder：macOS dmg (arm64) / Windows NSIS+MSI / Linux AppImage；`asarUnpack` 处理 node-pty 原生模块。
- **Docker**：`Dockerfile` + `Dockerfile.base` + docker-compose（挂载 runtime/ 与 workspace/）。
- **CLI**：`bin: { "inno": "dist/cli.js" }`，纯 TUI 无 HTTP。
- 路径解析优先级：CLI 参数 > 环境变量（`INNO_HOME/CONFIG_DIR/DATA_DIR/SKILLS_DIR/WORKSPACE_DIR/PORT`）> `~/.inno-agent/` 默认值——代码/配置/数据/工作区四分离，利于生产部署。

## 9. 技术栈总表

| 分类 | 选型 |
|---|---|
| 语言 | TypeScript (ESM, type: module) |
| 运行时 | Node.js >= 20.6 |
| Agent 内核 | Pi SDK @earendil-works/pi-coding-agent ^0.84（不改内核） |
| LLM 接入 | 任意 openai-completions / anthropic-messages 端点（Anthropic/OpenAI/DeepSeek/Ollama/本地），默认示例为 InnoSpark 网关的 claude-sonnet-4-6 |
| 后端 HTTP | 原生 node:http + SSE + ws (WebSocket) |
| 存储 | 文件系统（JSON/Markdown/JSONL）+ SQLite FTS5（L3）+ BM25 自实现（L2） |
| 图计算 | graphology + graphology-communities-louvain |
| 文档解析 | @llamaindex/liteparse、PaddleOCR-VL（外部 API） |
| 搜索 | @tavily/core + pi-web-access |
| IM | 飞书官方 SDK、微信 iLink/bridge |
| 前端 | React 19 + Vite 6 + Tailwind 4 + lit + streamdown + CodeMirror 6 + xterm.js + Cytoscape + ECharts |
| 桌面 | Electron 42 + electron-builder |
| 测试 | Vitest 3（后端单测较多，前端少量） |
| 工程化 | npm workspaces monorepo、tsx、pino 日志、typebox（工具参数 schema）、jiti（运行时 TS 加载） |

## 10. 仓库结构

```
inno-agent/
├── apps/inno-agent/          后端（CLI + HTTP 服务）
│   ├── src/
│   │   ├── agent/            Pi 集成：inno-extension、pi-runner、system-prompt、各类工具
│   │   ├── memory/
│   │   │   ├── learner/      L1 画像（15 模块：state-engine、context-pack、auto-profile…）
│   │   │   ├── l2/           L2 wiki（25 模块：generator、linker、graph、search…）
│   │   │   └── l3/           L3 会话检索（sqlite-store、recall…）
│   │   ├── scheduler/        cron 调度（job-store、job-runner…）
│   │   ├── channels/         飞书/微信/QQ + dispatcher + bridge
│   │   ├── server/           HTTP 路由（14 组）+ SSE + 附件 + trace
│   │   ├── workspace/        多工作区注册表
│   │   ├── content-source/   内容中心（github/bundle 双源）
│   │   ├── mcp/ checkins/ chat/ terminal/ storage/ showcase/
│   │   ├── cli.ts / server.ts / runtime.ts / config.ts
│   └── web/                  React 19 前端（stores / api / 组件）
├── apps/showcase/            案例展示站（Vite）
├── electron/                 桌面主进程（main.js / preload.cjs）
├── scripts/                  构建、评测（eval-l2-retrieval）、content-hub-server
├── docs/                     系统依赖、学习者状态引擎设计、PDF 技术报告
├── config.example.json / .env.example / docker-compose.yml
└── runtime/ workspace/       本地运行时（gitignored）
```

## 11. 亮点与可借鉴模式

1. **"单扩展工厂 + 钩子注入"范式**：所有业务逻辑收敛在一个 `ExtensionFactory` 里（registerProvider + registerTool + before_agent_start 注入），Pi 内核零改动——这是 Pi 二次开发的最干净姿势。
2. **记忆分层按生命周期隔离**：画像（秒级更新）/ wiki（天级沉淀）/ 会话（分钟级检索）用完全不同的存储与检索策略，而不是一个向量库包打天下。
3. **检索门控注入**：L3 召回设相关性阈值，不够相关就不进上下文——实用的抗噪声设计。
4. **上下文包（ContextPack）**：每轮注入固定预算的画像摘要（Top-5 待干预概念），控制 token 成本。
5. **工具写入式记忆**：记忆更新走 LLM 工具调用而非事后摘要，决策可追溯、可纠正。
6. **复用 Pi 生态而非重造**：联网（pi-web-access）、MCP（pi-mcp-adapter）、子代理（pi-subagents）、沙箱（pi-sandbox）、前端组件（pi-web-ui）全部来自社区包。
7. **零框架后端**：原生 http + SSE + ws 足够，省掉 Express 一层。
8. **评测脚本**（`eval-l2-retrieval.ts`）：对记忆检索单独做量化评测——Agent 项目少见的严谨。

## 12. 局限与风险

- 检索以 BM25 + 图谱为主，**无向量嵌入检索**（语义召回弱，但换来零嵌入模型依赖）。
- 后端无 lint/CI 测试流水线（README 自述），质量靠 TS 编译 + Vitest 局部覆盖。
- 微信 bridge 模式依赖 sidecar 进程，合规与稳定性有风险。
- monorepo 核心文件过大（pi-runner 60KB、wiki-generator 39KB），重构压力大。
- LLM 供应商配置示例绑定 InnoSpark 网关，新用户需自行改配置。

## 13. 对 Pi 二次开发的参考价值

| 想做的事 | Inno Agent 给出的模板 |
|---|---|
| 做垂直领域助理 | Pi AgentSession 为核 + 领域工具集 + 领域系统提示词 |
| 给 Agent 加长期记忆 | L1 工具写入 + L2 wiki + L3 SQLite FTS5，分层按生命周期选型 |
| 加 IM 渠道 | ChannelRegistry + 统一 dispatcher，飞书/微信各有实现可抄 |
| 加主动能力 | 自然语言 → cron-parser → jobs.json 持久化 → 渠道回推 |
| 做自有 UI | 原生 HTTP + SSE 包 AgentSession，前端用官方 pi-web-ui 起步 |
| 打包分发 | Electron（桌面）/ npm bin（CLI）/ Docker（服务）三形态复用同一 runtime |
