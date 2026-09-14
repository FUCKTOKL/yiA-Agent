# pi Agent 二次开发方案

> 基于 pi（@earendil-works/pi-coding-agent）官方文档整理。按改动成本从低到高排列，可组合使用。

## 方案总览

| # | 方案 | 改动成本 | 适用场景 | 关键文档 |
|---|------|---------|---------|---------|
| 1 | AGENTS.md 上下文文件 | ★ | 注入团队规范、项目约定 | docs/index.md |
| 2 | Prompt 模板（斜杠命令） | ★ | 固化常用提示词为 `/命令` | docs/prompt-templates.md |
| 3 | Skills（Agent 技能） | ★ | 按需加载的 reusable 能力 | docs/skills.md |
| 4 | 自定义模型 / Provider | ★★ | 接入私有模型、Ollama、企业网关 | docs/models.md, custom-provider.md |
| 5 | Extensions（TS 扩展） | ★★★ | 自定义工具、命令、事件拦截、TUI | docs/extensions.md |
| 6 | Pi Packages 打包分发 | ★★ | 团队共享上述资源 | docs/packages.md |
| 7 | RPC / JSON 模式集成 | ★★★ | 跨语言、子进程嵌入 | docs/rpc.md, docs/json.md |
| 8 | SDK 深度嵌入 | ★★★★ | 自建 UI、自动化流水线、子 Agent | docs/sdk.md |

---

## 1. AGENTS.md 上下文文件（零代码）

最低成本的自定义方式。pi 启动时自动从 cwd 向上查找 `AGENTS.md`，合并全局 `~/.pi/agent/AGENTS.md`。

- 全局规范 → `~/.pi/agent/AGENTS.md`
- 项目规范 → 项目根目录 `AGENTS.md`
- 可用 SDK 的 `agentsFilesOverride` 注入虚拟上下文文件

适合：编码规范、禁止命令、项目结构说明、输出格式要求。

## 2. Prompt 模板

把常用提示词做成 `.md` 文件，使用时以斜杠命令展开：

- 项目级：`.pi/prompts/deploy.md` → `/deploy`
- 全局级：`~/.pi/agent/prompts/review.md` → `/review`
- SDK 注册：`DefaultResourceLoader` 的 `promptsOverride`

适合：部署流程、代码评审清单、固定输出格式等"每次都打一样的话"。

## 3. Skills（Agent 技能）

目录结构 `skills/<name>/SKILL.md`（front-matter 写 name + description），模型按任务匹配后按需加载指令，不占常驻上下文。

- 位置：`.pi/skills/`、`.agents/skills/`（项目）、`~/.pi/agent/skills/`（全局）
- SDK 可用 `skillsOverride` 注入自定义 Skill

适合：PDF 处理、前端生成等"有套路"的任务型能力。

## 4. 自定义模型 / Provider

### 4.1 models.json（配置即可）

`~/.pi/agent/models.json` 添加 Ollama / vLLM / LM Studio / OpenAI 兼容网关：

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [{ "id": "qwen2.5-coder:7b" }]
    }
  }
}
```

### 4.2 registerProvider()（需要代码）

扩展中调用 `pi.registerProvider()` 实现：

- 企业代理 / API 网关路由
- 私有部署端点
- OAuth/SSO 认证流
- 非标准 LLM API 的自定义流式实现

参考示例：`examples/extensions/custom-provider-anthropic/`。

## 5. Extensions（核心扩展机制）

TypeScript 模块，是 pi 二次开发的主力。放置于 `~/.pi/agent/extensions/`（全局）或 `.pi/extensions/`（项目，需信任）后自动发现，支持 `/reload` 热加载；临时测试用 `pi -e ./my-ext.ts`。

### 核心能力

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  // 1. 事件拦截：危险命令确认门
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
      const ok = await ctx.ui.confirm("危险操作", "允许执行 rm -rf？");
      if (!ok) return { block: true, reason: "被用户拒绝" };
    }
  });

  // 2. 注册自定义工具（LLM 可调用）
  pi.registerTool({
    name: "query_db",
    label: "Query DB",
    description: "查询内部数据库",
    parameters: Type.Object({ sql: Type.String() }),
    async execute(toolCallId, params) {
      return { content: [{ type: "text", text: "..." }], details: {} };
    },
  });

  // 3. 注册斜杠命令
  pi.registerCommand("hello", {
    description: "打招呼",
    handler: async (args, ctx) => ctx.ui.notify(`Hello ${args || "world"}!`, "info"),
  });
}
```

### 可做的事

| 能力 | API | 典型场景 |
|------|-----|---------|
| 注册工具 | `pi.registerTool()` | 对接内部 API、数据库、CI |
| 事件订阅/拦截 | `pi.on("tool_call" / "agent_start" / ...)` | 权限门、路径保护、自动 git checkpoint |
| 自定义命令 | `pi.registerCommand()` | `/mycommand` 自动化 |
| 用户交互 UI | `ctx.ui`（select/confirm/input/notify/custom） | 向导、对话框 |
| 会话持久化 | `pi.appendEntry()` | 状态跨重启保存 |
| 自定义渲染 | tool renderer | 改变工具结果显示 |
| 自定义 compaction | compaction 事件 | 按业务摘要上下文 |
| 自定义 Provider | `pi.registerProvider()` | 见方案 4.2 |
| 扩展间通信 | `pi.events` / `createEventBus()` | 多扩展协作 |

官方示例库 `examples/extensions/` 含 60+ 实现：permission-gate、git-checkpoint、protected-paths、custom-compaction、subagent、todo 等。

## 6. Pi Packages 打包分发

把扩展、技能、模板、主题打包为 npm 包或 git 仓库共享，`package.json` 中 `pi` 字段声明资源：

```bash
pi install npm:@foo/bar@1.0.0
pi install git:github.com/user/repo@v1
pi install /absolute/path          # 本地路径
pi remove npm:@foo/bar
pi list / pi update --all
pi -e npm:@foo/bar                 # 免安装试用
```

`pi install -l` 写入项目 `.pi/settings.json`，团队共享、项目信任后启动自动安装。

## 7. RPC / JSON 模式（跨语言集成）

不改 SDK，直接以子进程方式嵌入任意语言的应用：

```bash
pi --mode rpc --no-session     # stdin/stdout JSONL，双向命令+事件流
pi --mode json ...             # print 模式输出结构化 JSON 事件流
```

- RPC 协议：JSONL over stdio，命令如 `{"id":"req-1","type":"prompt","message":"..."}`，事件持续流回 stdout
- 注意：按 `\n` 分帧，Node 的 `readline` 不合规（会额外按 U+2028/U+2029 切分）
- 适合：IDE 插件、Python/Go/Java 宿主程序、Web 后端

## 8. SDK 深度嵌入

`npm install @earendil-works/pi-coding-agent` 后在同进程内完全控制 Agent：

```typescript
import { createAgentSession, ModelRuntime, SessionManager, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const myTool = defineTool({
  name: "my_tool",
  description: "自定义工具",
  parameters: Type.Object({ input: Type.String() }),
  execute: async (_id, p) => ({ content: [{ type: "text", text: `结果: ${p.input}` }], details: {} }),
});

const { session } = await createAgentSession({
  modelRuntime: await ModelRuntime.create(),
  tools: ["read", "bash", "my_tool"],
  customTools: [myTool],
  sessionManager: SessionManager.inMemory(),
});

session.subscribe((e) => {
  if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(e.assistantMessageEvent.delta); // 流式输出
  }
});

await session.prompt("列出当前目录文件");
```

### SDK 关键扩展点

- **会话控制**：`prompt()` / `steer()` / `followUp()`、`abort()`、compact
- **模型与认证**：`ModelRuntime`（自定义 authPath/modelsPath、`setRuntimeApiKey`）
- **系统提示词**：`DefaultResourceLoader` 的 `systemPromptOverride`
- **资源注入**：extensions / skills / prompts / context files 全部可 override
- **会话管理**：`SessionManager`（inMemory / create / continueRecent / open，树形分支 branch/fork）
- **运行模式**：`InteractiveMode`（完整 TUI）、`runPrintMode`（单次执行）、`runRpcMode`（JSON-RPC）
- **会话替换**：`createAgentSessionRuntime()` 支持 new / switch / fork（用于自建多会话 UI）

官方示例 `examples/sdk/01~13`：从 minimal 到 full-control 全覆盖。

## 选型建议

1. **只是给 Agent 定规矩** → AGENTS.md（方案 1）
2. **重复话术固化** → Prompt 模板（方案 2）
3. **任务型能力按需加载** → Skills（方案 3）
4. **接入私有模型** → models.json / registerProvider（方案 4）
5. **加工具、加命令、拦事件、改 UI** → Extension（方案 5，90% 的二次开发落点）
6. **团队/跨项目共享** → Package（方案 6）
7. **非 Node 宿主集成** → RPC / JSON 模式（方案 7）
8. **自建产品级 UI 或自动化流水线** → SDK（方案 8）

> 安全提示：Extension 与 Package 均以你的完整系统权限运行任意代码，只安装可信来源；项目级资源需项目信任后才加载。
