# yiA —— 部署在自己电脑上的"第二大脑"个人助理

> Your personal second brain: capture fast, recall accurately, remind on time.
> 对话式存储信息、按需提炼知识、定时提醒推送到微信。

基于 [Pi SDK](https://github.com/earendil-works/pi)（@earendil-works/pi-coding-agent）二次开发，**不修改 Pi 内核**；微信通道封装 [OpenClaw](https://openclaw.ai) + [@tencent-weixin/openclaw-weixin](https://github.com/Tencent/openclaw-weixin) 官方插件。

## 特性

- **存得快**：一句话丢给 yiA 即完成存储、打标签、自动关联（≤10 秒）
- **取得准**：自然语言提问 → 跨条目综合提炼 + 来源引用（BM25 + 自动双向链接）
- **会主动**：自然语言设提醒（"每天早上 9 点叫我站会"），到点推送到微信
- **懂天气**：直接问“北京今天天气如何？”——当前实况加三日预报，Open-Meteo 数据源，免 API key
- **三层记忆**：L1 用户画像 / L2 知识库（Markdown + FTS）/ L3 会话索引（SQLite FTS5）
- **微信随身**：私聊即用——存、取、提醒一条龙；TUI 本地操作
- **运行时独立**：yiA 的 agent 运行时与你的个人 pi 完全隔离（`runtime/agent/`），互不污染

## 架构

```
微信 ⇄ OpenClaw Gateway(常驻) ⇄ weixin 插件 ⇄ yia-cli(CLI 后端)
                                                    ⇅
终端 TUI(yiA 命令) ⇄ pi 会话 ⇄ yiA 扩展(记忆/提醒/微信/命令)
                                    ⇅                ⇅
                        runtime/（L1/L2/L3 数据）   调度守护进程(常驻) → 定时推送
```

- 代码在 `yiA/`，数据在 `runtime/`（gitignored，可整体备份）
- 调度守护进程是提醒的唯一触发者（Linux: systemd / Windows: 启动文件夹），TUI 关着也照发

## 快速开始

前置：Node ≥ 22.13、npm、一个模型 API key（默认 GLM，可换任何 Pi 支持的模型）。

### Windows

```powershell
git clone https://github.com/FUCKTOKL/yiA-Agent.git
cd yiA
powershell -ExecutionPolicy Bypass -File yiA\scripts\win\provision.ps1
# 然后双击 yiA\scripts\win\yia.bat 进入 TUI，运行 /wechat 完成扫码+配对
```

### Linux / macOS / WSL

```bash
git clone https://github.com/FUCKTOKL/yiA-Agent.git
cd yiA && npm --prefix yiA install && bash yiA/scripts/provision.sh
yiA   # TUI；或 node yiA/scripts/chat-cli.ts < 无头自检
# 在 TUI 里运行 /wechat 完成扫码登录 + 配对 + 推送目标
```

### 首次配置（人工 3 步）

1. `runtime/agent/auth.json` 填入你的 API key（provision 会尝试从个人 pi 迁移）
2. `/wechat` → 扫码登录你的 bot 微信号 → 用个人号给 bot 发消息 → 输配对码批准 → 填推送目标
3. 验证：微信里说"提醒我 2 分钟后测试"，到点手机应响

### 模型切换（微信也使用这一份配置）

yiA 与个人 Pi 的模型设置完全隔离。微信、Web 和 `yiA` 命令只读取仓库根的
`runtime/agent/settings.json`；仅在 `~/.pi/agent/` 或个人 Pi TUI 里切换模型，不会影响微信。

跨供应商时必须同时改 `defaultProvider` 与 `defaultModel`。例如已接入 OpenAI Codex 时，把
`runtime/agent/settings.json` 中的两个字段改为：

```json
{
  "defaultProvider": "openai-codex",
  "defaultModel": "gpt-5.5"
}
```

请保留文件中的其他字段。可用模型 id 从 `runtime/agent/models-store.json` 对应 provider 的
`models` 列表查询。微信下一条消息会读取新设置；它会保留聊天历史，但不会再被旧会话的模型绑定。

Web 的 `/login` 只保存或更新 API key；确认 provider/model 后再按上面的配置切换。当前默认
模型可在 Web `/login` 的状态文字，或 `runtime/agent/settings.json` 中核对。

## Web 界面（M6.1）

```bash
cd yiA && npm run web     # http://127.0.0.1:3777（仅本机可访问）
```

浏览器打开即见：对话（真实 agent 会话，SSE）、知识库（列表/图谱/精炼/删除）、
提醒（增/删/渠道）、微信状态与测试推送、系统状态浮层。无需再开 TUI。

## 常用命令（TUI 内）

| 命令 | 作用 |
|---|---|
| `/wechat` | 微信状态 / 换绑（自动登出旧号、防双账号） / 改推送目标 |
| `/reminder` | 查看/管理提醒 |
| `/brain` | 浏览知识库条目 |
| 直接说话 | "记住…"= 存；"我之前说过什么…"= 取；"提醒我…"= 定时 |

## 测试

```bash
npm test                # 单元测试（仓库根即可跑）
npm run loadcheck       # 扩展加载自检（同样仓库根可跑）
npm run bench             # 万条记忆检索基准
```

## 目录

```
yiA/            代码（src/agent 扩展、src/memory 三层、src/scheduler、src/channels、sidecar/）
runtime/        数据（agent 运行时、记忆、调度、日志、微信配置）——gitignored
docs/           设计文档（PRD、技术拆解、测试方案）
.pi/extensions  项目级 pi 扩展装载点
```

## 已知边界

- 微信通道仅支持私聊（插件能力边界）
- L2 检索为 BM25，向量检索为预留升级位（PRD F1.3）
- Web 管理界面（M6）与知识图谱（M7）规划中

## License

MIT
