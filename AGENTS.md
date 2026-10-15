# yiA 项目 AGENTS.md

> 供 pi Agent（及协作者）快速接手。详细设计见 docs/（第 7 节索引），本文件只保留决策、功能与现状。
> 开源仓库：https://github.com/FUCKTOKL/yiA-Agent

## 1. yiA 是什么

部署在个人电脑上的**"第二大脑"个人助理**：对话式存储信息、按需提炼知识、定时提醒推送到微信。基于 **Pi SDK**（`@earendil-works/pi-coding-agent`）二次开发，**内核零改动**；微信通道走 OpenClaw Gateway + 腾讯官方 weixin 插件。

## 2. 功能清单（当前可用 ✅ / 规划中 ○）

### 记忆（三层）
- ✅ **L1 用户画像**：身份/偏好/常驻项目/事实，JSON 分区，会话自动注入
- ✅ **L2 知识库**：一句话存储→Markdown 条目+frontmatter、自动打标签、自动双向关联
- ✅ **L2 检索**：BM25 + 分词（中文友好），召回带条目 id 引用；万条冷 <400ms / 热 P95 <17ms
- ✅ **L2 精炼**：按 id 修改内容/标题/标签（refine，id 与创建时间不变）；跨进程写锁+写前重读+原子替换，防止旧缓存覆盖；常驻检索自动刷新，Web 过期编辑返回 409 并保留输入
- ✅ **L3 会话索引**：SQLite FTS5 全文检索全部会话原文，压缩不丢档
- ✅ **ContextPack**：每轮自动注入 当前时间+画像+相关记忆+待办提醒
- ○ 向量检索升级位（PRD F1.3 预留）

### 书籍库（独立于日常记忆）
- ✅ 网页上传文字版 PDF、EPUB、TXT/Markdown；原件副本、元数据、分段原文和 FTS5 索引存入 `runtime/books/library.db`，一次事务提交、SHA-256 去重
- ✅ 中英文关键词全文检索（含中文单字）、跨书/按书筛选、原件下载与按书删除；删除同步清索引，不动用户上传前的源文件
- ✅ **原件阅读与定位**：本地 PDF.js 原版页、EPUB 无脚本沙箱排版/包内样式图片、Markdown 标题强调、TXT 行号；搜索/聊天引用跳原书页/节/行，能可靠匹配才高亮。80%–200% 缩放、页码/章节跳转、展开阅读、手机阅读模式；模型仍读独立纯文字索引
- ✅ **旧书无损升级**：`passages.anchor` 结构化 JSON；新增前用 `VACUUM INTO` 一致性备份到 `runtime/books/backups/`。保留原件/编号/正文/FTS，不需重传；只回填旧记录已有的页/节/行，不猜字符偏移
- ✅ Web/微信/TUI 共用只读 `list_books` / `search_books` / `read_book_passage` 工具；回答先查原文、注明出处，网页引用可点击跳转；原文仅为资料，不执行其中指令
- ✅ 本机导入与网页检索不调用模型；只有对话查询的命中片段/上下文交给当前模型。50 MiB/500 万字符/2000 页或节上限，独立解析子进程、两分钟超时、ZIP 路径/解压体积/CRC 校验、本机同源请求保护
- ○ OCR、DRM、语义向量检索、自动读书摘要未做；扫描件/少字页面会拒绝或提示覆盖范围

### 提醒
- ✅ 自然语言建提醒（LLM 换算 ISO 8601，工具校验过去时间拒绝）
- ✅ 重复提醒（repeatDays：每天/每 N 天）
- ✅ 列表 / 按任务 id 取消
- ✅ 常驻调度守护（30s 周期、jobs.json 持久化、重启不丢、错过补发）
- ✅ 微信推送（到点推到用户微信，channel 按来源默认）；等待发送成功后才完成任务，失败/缺配置/停用保留待触发重试；慢推送防重叠，退出等待收尾，每次发送重读配置

### 微信通道
- ✅ 私聊全功能：存/取/提醒一条龙（chat-cli 无头会话，`runtime/chats/<id>.jsonl` 连续）
- ✅ 配对准入（pairing code 白名单，防陌生人）
- ✅ `/wechat` 换绑：登出全部旧账号（凭据文件移除法）→ 扫码 → 自动绑定发送账号 → 校验推送目标格式 → 重启网关
- ✅ 发送指定 accountId（多账号防歧义）；僵尸账号条目已从解析排除
- ○ 群聊（插件能力边界外）

### 外部能力（MCP）
- ✅ **当地天气**：Pi 原生 MCP 直连 `sidecar/mcp/weather-mcp.mjs`，Open-Meteo 地理编码+天气预报，免 API key；支持中文城市名、当前实况与三日预报
- ✅ 运行时全局配置 `runtime/agent/mcp.json`（`pi mcp add` 生成），避免微信/Web 无头会话受项目服务器信任确认阻塞；部署脚本会幂等配置

### yiA 人格（全通道生效）
- ✅ **记忆管家**：优雅/可靠/克制的英式管家风——口语化短句、称您、禁 Markdown 结构符、办事简短确认不复述（`src/agent/system-prompt.ts`，Web/微信/TUI 同一人格）

### TUI（终端界面）
- ✅ `yiA` 命令启动（独立运行时，PATH 安装）
- ✅ 自定义命令仅三个：`/reminder` `/wechat` `/brain`（记忆浏览：列表→Markdown 查看器）
- ✅ 跨平台：Linux/macOS（systemd/launchd）+ **Windows 原生**（bat/ps1/启动文件夹，`yiA/scripts/win/`）

### Web 端（M6，`npm run web` → http://127.0.0.1:3777）
- ✅ 后端：`src/server/server.ts` 工厂（DI 可测）+ `scripts/web-server.ts` 薄入口；原生 HTTP+SSE（无 Web 框架），仅绑 127.0.0.1
- ✅ 五页：对话（真实 agent 会话 SSE、ContextPack 折叠条）/ 记忆（列表+图谱+阅读/编辑/删除）/ 书籍（导入/检索/原文/原件/删除）/ 提醒（增删）/ 微信（状态+测试推送）
- ✅ **会话管理**：全部历史会话列表（首条用户消息命名，剥微信噪声头）、切换/删除/新开，删会话自动卸载内存缓存
- ✅ **对话失败可见**：Web/微信共用 `src/chat/reply.ts` 检查模型结果；拒绝空回复、错误结果和上一轮旧答案；Web 实时与历史都显示错误，断流/损坏消息会提示并恢复发送按钮；文本通过 DOM 安全渲染
- ✅ **模型设置**：会话面板右上角打开，与微信换绑共用 `.settings-win` 弹窗；按已接入服务商选择模型，provider/model 成对校验与保存；释放旧 Web 会话缓存，网页/微信下一条消息生效且保留历史；回复进行中禁止切换，不展示密钥
- ✅ **全页视觉对齐**：共用页面宽度、内边距、标题高度与分隔线；明暗主题、1440/1024/390/320 宽度截图验证无页面或导航栏横向溢出；模型/微信设置同材质同宽，弹窗支持键盘焦点回收
- ✅ **斜杠命令**：`/login`（模型接入）/`/model`/`/status`/`/reminders`/`/memory`/`/new`/`/help`，命令面板反色浮层，客户端拦截不发给模型
- ✅ **Web 换绑向导**：五步（登出→扫码→配对→推送目标→重启），二维码 ASCII→模块矩阵→SVG（字体无关可扫），与 TUI 共用 `src/channels/weixin-ops.ts`
- ✅ **背景持久化**：`/api/bg` 存 runtime/web/bg.img，刷新/换浏览器自动继承，双击恢复默认
- ✅ 材质：Apple 风格毛玻璃，**色底 .96 岛间同色**（透明材质岛间必有色差，已定论）；无横向滚动条（溢出扫描器验证）
- ○ Web 常驻服务化（现为手动 npm run web）

### 工程化
- ✅ 单元测试 96 条（node:test，无额外测试框架；含原有记忆/提醒/模型/SSE 回归及书籍解析、原子导入、跨进程去重、索引删除、坏文件/坏库、HTTP 防护、只读查书工具）、loadcheck 扩展自检、bench 基准
- ✅ 破坏性用例：jobs.json/L2 损坏自动备份降级、配置缺失降级
- ✅ 统一日志（本地时区按天分文件）、扩展工具异常返回错误文本不崩
- ✅ 已开源（MIT，仓库 github.com/FUCKTOKL/yiA-Agent，**当前 PRIVATE 待转公开**）；双平台 provision 一键部署
- ✅ 视觉验证流水线：playwright-core（sidecar node_modules）+ headless Chromium（~/.cache/ms-playwright），截图+像素量化（溢出扫描/岛面均匀度/QR 网格对齐），色差类 bug 必须量化定位不盲修
- ◐ M6 Web：功能已齐（见上节 Web 端），待常驻化
- ○ M7 知识图谱：Web 端已有确定性力导向图（60 轮松弛）+降级关联列表；独立图谱页远期

## 3. 关键决策（已定，不要推翻）

| 决策 | 结论 |
|---|---|
| 环境 | WSL Ubuntu 24.04 开发；**已支持 Windows 原生**（v0.5.0 起跨平台） |
| 目录 | 代码全在 `yiA/`；数据 `runtime/`（gitignored 可整体备份）；加载器 `.pi/extensions/`；文档 `docs/` |
| 运行时独立 | agentDir=`runtime/agent/`（settings/auth/models-store/sessions），与个人 `~/.pi/agent` 零共享；`PI_CODING_AGENT_DIR` 隔离。切模型须同时改此处 `settings.json` 的 defaultProvider/defaultModel，不认个人 Pi 设置；无头会话显式使用当前默认模型，旧微信会话不再绑定旧模型 |
| 记忆三层 | L1 画像(JSON) / L2 知识库(MD+BM25) / L3 会话(FTS5)，阈值门控召回 |
| 书籍库 | 与三层记忆分离，原件 BLOB/原文/FTS5 同存 `runtime/books/library.db`，**不是可删除重建的缓存**；坏库保留报错。阅读原件与模型索引分开，定位写入 `passages.anchor` JSON，旧库先一致性备份再加列，不重建正文/索引。EPUB 文档必须 sandbox 无脚本+CSP+资源白名单；远程资源不加载。OCR/向量/自动摘要未做；备份覆盖整个 books 目录及 WAL |
| L2 多通道写入 | `runtime/l2/write-lock.db` 仅用作 SQLite 跨进程写锁；条目仍为 Markdown，临时文件原子替换；`runtime/l2/revision` 更新标记不依赖时间精度；网页保存和模型 refine 必须带 expectedVersion（模型从 recall 获取），过期网页返回 409 |
| 提醒完成语义 | runner 等待异步推送成功，失败保持 pending；同一实例检查不重叠，停止等待当前推送。发送成功后落盘前若崩溃仍可能重发，优先不漏发，不承诺严格恰好一次 |
| 提醒触发 | **唯一触发者=yia-scheduler 常驻守护**（Linux systemd / Windows 启动文件夹），TUI/chat-cli 不跑 runner 防双发 |
| 微信架构 | OpenClaw Gateway(2026.8.2 锁定) + @tencent-weixin 插件 + yia-cli CLI 后端（stdin 进消息/stdout JSON） |
| 网关控制 | 统一 `openclaw gateway start/stop/restart`（自带 systemd/launchd/schtasks 适配），不直接调 systemctl |
| 换绑语义 | 替换式（1 bot 账号 + 1 推送目标）；账号 id **每次登录都会变**，登录后自动解析写入 wechat.json 的 account 字段 |
| 微信凭据 | ~/.openclaw/openclaw-weixin/accounts/ 下按文件存；插件不支持 CLI logout，登出=移除凭据文件（备份到 .removed-backup/） |
| 天气 MCP | 用 Pi 内置 `pi mcp` 配到独立运行时的全局 `mcp.json`，直连暴露；勿改项目 `.mcp.json`（无头会话会被项目服务器信任机制拦截）。数据源 Open-Meteo，零 key。SDK 无头会话不会自动加载 MCP，必须走 `src/chat/session-factory.ts`（显式 createMcpExtension + bindExtensions + `PI_CODING_AGENT_DIR`） |
| Web 架构 | `src/server/server.ts` 工厂（createYiaServer，DI 可测）+ `scripts/web-server.ts` 薄入口；曾出现双后端并行事故（无测脚本影子实现），合并后禁止另起炉灶 |
| Web 模型设置 | `src/server/model-catalog.ts` 复用 Pi ModelRuntime 读取独立运行时，只列已接入服务商；目录收录不等于账号有该型号权限；`/api/model` 校验完整 provider/model 并释放旧 Web 缓存后原子保存；旧斜杠命令只给 id 时，仅在唯一匹配时推断服务商 |
| Web 材质 | Apple 毛玻璃，色底 **.96**：透明材质岛间必有色差（透多少差多少），多轮实测定论，不要回调透明度 |
| Web 二维码 | 终端 ASCII 码必转 SVG（字符列宽在浏览器不可靠对齐）；剥 ANSI+提取纯█▀▄块再解析模块矩阵 |
| 验证方式 | 视觉/布局 bug 用 playwright 截图+像素量化定位（headless 软渲染复现不了 GPU 合成 bug，需真浏览器确认） |
| 分期 | TUI 期做齐能力（含微信）→ M6 Web 增值 UI ✅ → 常驻化/App 远期 |

## 4. 里程碑状态（2026-10-15）

- M1 TUI 骨架 ✅　M2 记忆完整 ✅　M3 提醒调度 ✅　M4 微信接入 ✅　M5 TUI 打磨 ✅
- v0.5.0 开源 GitHub（PRIVATE 待转公开）；Windows 原生支持 ✅
- **M6 Web** ✅ 功能全齐：五页 UI（新增独立书籍库）、真实会话 SSE、会话管理、模型设置、斜杠命令、Web 换绑向导（QR SVG）、背景持久化、yiA 人格；待常驻化
- M7 知识图谱 ◐ Web 端已有力导向图+降级列表；独立图谱页远期
- 技术债：无阻塞项；杂项见 `problem.md`（扩展点/部署/上下文/插件兼容四问）

## 5. 工程约束（提交前检查）

- 提交前（`yiA/` 目录）：`npm test`（96 用例）+ `npm run loadcheck` 必过
- 单测 node:test 不引第三方；每个 IO 边界有破坏性用例
- 日志统一走 `yiA/src/logger.ts`（禁记记忆正文/凭据/会话原文；禁散落 console.log）
- 工具 execute 必返回错误文本；工厂初始化不得抛出拖垮 pi；禁空 catch
- 密钥不入库不进会话记录；扩展工具写文件仅限 runtime/
- 性能：万条检索 <1s；TUI 冷启动 <3s；微信端到端 <5s
- **禁止批量删除**（rm -rf / rd /s 等）；删文件只能逐个明确路径

## 6. 排障速查（近年事故复盘）

| 症状 | 根因 | 解法 |
|---|---|---|
| 换绑后旧号仍可用 | 插件无 CLI logout，凭据残留 | 移除 accounts/<id>.* 文件+重启网关 |
| 换绑后新号收不到提醒 | 发送未带 accountId / 配置写进僵尸账号 / targetPeer 填了昵称 | sender 带 accountId；解析只认 configured；强校验 `/^o[\w-]{15,}@im\.wechat$/` |
| 提醒不响但列表里有 | 通道暂不可用/推送失败；旧版 daemon 也会驻留旧配置 | 新版每次发送重读配置，失败保持 pending 后续重试；升级后需重启 yia-scheduler |
| 提醒未收到却显示完成 | 旧版 daemon 吞掉异步推送错误，runner 未等待发送 | 已改 await 发送成功才记流水/完成；旧 done 任务不能自动判断是否漏发，不擅自重发 |
| 网页保存覆盖微信新记忆 | 旧内存索引/旧编辑页整篇回写 | L2 写锁+最新内容合并；Web expectedVersion 冲突返回 409，刷新后重新打开，编辑框不自动清空 |
| 日志查不到当天 | 文件名曾用 UTC 日期 | 已改本地时区（2026-09-14） |
| CLI 后端 harness 报错 | openclaw 8.1 agentRuntime pin 触发绑定检查 | 模型只用纯 ref，勿加 agentRuntime.id |
| fd/rg 下载超时 | Clash TUN fake-IP DNS | 从个人 pi bin/ 拷静态二进制 |
| npm run web 甩 node 堆栈 | 端口被残留实例占用（EADDRINUSE） | server.on('error') 友好提示；杀端口或换 YIA_WEB_PORT |
| 悬停左栏右岛变色 | 噪点层 mix-blend-mode 与 backdrop-filter 跨表面 GPU 合成错乱（动 A 坏 B） | 材质层禁用 blend，透明度烘进 SVG；子层嵌套去二次 backdrop-filter |
| 岛间/岛内色差反复 | 透明材质固有：压背景亮区就亮 | 色底 .96 定论；嵌套子层补偿；勿回调透明度 |
| Web 二维码扫不出 | 浏览器字符列宽错位（空格与 █▀▄ 回退字体不同） | 半块字符→模块矩阵→SVG，与字体无关 |
| 切会话历史叠加 | loadHistory 不清旧 .msg 节点 | 清节点但保留同容器 ctxBar（不能 innerHTML 一刀切） |
| provision 不可重跑 | 历史游离引号致 bash 语法错 | 已修；bash -n 预检脚本语法 |
| Web 双后端事故 | 新写 scripts 版影子实现与 src/server 并行（无单测） | 合并回工厂模式；改后端只改 src/server |
| 微信回 `yia-cli/yia request fail` / Web 空白回复 | Pi 将套餐到期、账号拒绝型号等错误写进 assistant.errorMessage，prompt 不一定抛错；只取文本会误发空 done | Web/微信共用 getAssistantReply，失败抛可读错误；Web 发 error 帧且历史可回看；实际账号无权限仍需用户重新接入或选支持的型号 |
| MCP 加入后微信 CLI 不退出 | `AgentSession.dispose()` 不发 session_shutdown，stdio MCP 子进程仍持有事件循环 | 用 `disposeYiaHeadlessSession()` 显式发 session_shutdown 后再 dispose |

## 7. 文档索引（docs/）

| 文件 | 内容 |
|---|---|
| `yiA-PRD.md` | 产品需求 v0.2：场景/功能/里程碑/非功能/风险——先读 |
| `inno-agent技术架构拆解.md` | 参考项目架构：三层记忆、Pi 集成范式 |
| `pi-Agent二次开发方案.md` | Pi 的 8 种二开路径总览 |
| `Pi-Agent个人助理项目调研.md` | 竞品调研（openclaw/khoj/leon 等） |
| `测试方案.md` | 测试分层、各里程碑必测项、性能基准 |
| `书籍导入与全文检索.md` | 书架用法、支持格式/限制、隐私边界、数据库备份、接口与验证记录 |
| `../problem.md` | 四问四答：扩展点/开源部署/上下文上限/插件兼容 |

参考实现：hhyqhh/inno-agent（MIT，三层记忆范式）、openclaw weixin 插件（docs.openclaw.ai/channels/wechat.md）、pi 官方（github.com/earendil-works/pi）。
