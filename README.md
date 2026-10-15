# yiA —— 部署在自己电脑上的"第二大脑"个人助理

> Your personal second brain: capture fast, recall accurately, remind on time.
> 对话式存储信息、按需提炼知识、定时提醒推送到微信。

基于 [Pi SDK](https://github.com/earendil-works/pi)（@earendil-works/pi-coding-agent）二次开发，**不修改 Pi 内核**；微信通道封装 [OpenClaw](https://openclaw.ai) + [@tencent-weixin/openclaw-weixin](https://github.com/Tencent/openclaw-weixin) 官方插件。

## 特性

- **存得快**：一句话丢给 yiA 即完成存储、打标签、自动关联（≤10 秒）
- **取得准**：自然语言提问 → 跨条目综合提炼 + 来源引用（BM25 + 自动双向链接）
- **会主动**：自然语言设提醒（"每天早上 9 点叫我站会"），到点推送到微信
- **懂天气**：直接问“北京今天天气如何？”——当前实况加三日预报，Open-Meteo 数据源，免 API key
- **本地书架**：导入文字版 PDF、EPUB、TXT/Markdown；中英文全文检索、原文定位、原件下载，对话查书带出处；导入不调用在线模型
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

推荐在网页操作：打开对话页，点击右侧「会话」面板右上角的模型设置按钮，选择服务商与模型，
再点「保存设置」。当前网页会话和微信的下一条消息都会使用新模型，聊天记录保留，不必删会话或重启网关。
只列出已接入服务商的模型；没有可选项时，在 `yiA` 终端运行 `/login` 接入后，点「重新读取」。
回复进行中会提示稍后切换，避免中断当前回复。

注意：列表说明 Pi 认识这个型号、服务商已接入，不代表您的账号一定有使用权限。
例如 ChatGPT 登录返回 “model is not supported” 时，需要选择账号支持的型号或重新配置接入；
不能通过反复重发解决。网页会显示具体错误，历史里的失败回复也可以回看，不再显示空白。

yiA 与个人 Pi 的模型设置完全隔离。微信、Web 和 `yiA` 命令只读取仓库根的
`runtime/agent/settings.json`；仅在 `~/.pi/agent/` 或个人 Pi TUI 里切换模型，不会影响微信。

也可手工配置：跨供应商时必须同时改 `defaultProvider` 与 `defaultModel`。下面仅为字段示例：
只有已通过 OpenAI API 接入 `openai`、且账号确有 `gpt-5.5` 权限时，才使用这组值；它不适用于仅有 ChatGPT 登录的账号。

```json
{
  "defaultProvider": "openai",
  "defaultModel": "gpt-5.5"
}
```

请保留文件中的其他字段。可用模型 id 从 `runtime/agent/models-store.json` 对应 provider 的
`models` 列表查询。微信下一条消息会读取新设置；它会保留聊天历史，但不会再被旧会话的模型绑定。

Web 的 `/login` 只保存或更新 API key，不等于已切换模型。当前默认模型可在模型设置窗口、
会话面板底部或 `runtime/agent/settings.json` 中核对。

## Web 界面（M6.1）

```bash
cd yiA && npm run web     # http://127.0.0.1:3777（仅本机可访问）
```

浏览器打开即见：对话（真实 agent 会话，SSE）、知识库（列表/图谱/精炼/删除）、
书籍（导入/全文检索/原文/原件下载）、提醒（增/删/渠道）、微信状态与测试推送、模型设置、系统状态浮层。五页共用标题基线与间距，
支持明暗主题和窄屏布局。无需再开 TUI。

## 把书放进第二大脑

打开网页「书籍」页 →「＋ 导入」→ 选择 PDF、EPUB、TXT 或 Markdown。单本最多 50 MB。
左侧可按关键词搜索全部书籍或某一本书，点击命中查看原文；右侧可翻段、下载原文件或确认删除。
重复上传同一文件不会重复收录，上传前的原文件不会被改动。

导入后可在 Web、微信或 TUI 问「在我导入的这本书里，查一下目标设定」，模型会用查书工具核对原文、标注出处。
网页中的 `bk_编号:片段号` 引用可点开原文。PDF 按文件页序定位，EPUB 按节/文档路径，TXT 按行号。

原件副本、原文和全文索引存入 `runtime/books/library.db`，与日常记忆分开。导入和网页检索不调用模型；
对话查书时，命中的片段会交给您选用的模型。该数据库也包含原件，**不能当缓存直接删除**；备份整个 `runtime/books/`。
第一版不含 OCR 或语义向量检索；扫描件请先识别文字，需要密码的 PDF 请先在本机解密。
详见 [书籍导入与全文检索](docs/书籍导入与全文检索.md)。

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
yiA/            代码（src/agent 扩展、src/memory 三层、src/books 书籍库、src/scheduler、src/channels、sidecar/）
runtime/        数据（agent 运行时、记忆、书籍原件与索引、调度、日志、微信配置）——gitignored
docs/           设计文档（PRD、技术拆解、测试方案）
.pi/extensions  项目级 pi 扩展装载点
```

## 已知边界

- 微信通道仅支持私聊（插件能力边界）
- L2 检索为 BM25，向量检索为预留升级位（PRD F1.3）
- 书籍检索是关键词匹配，不是语义向量检索；不含扫描件 OCR 或自动摘要
- Web 已有五页与记忆图谱；常驻服务化、独立知识图谱页仍待后续

## License

MIT
