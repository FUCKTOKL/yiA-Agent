# yiA 项目 AGENTS.md

> 本文件供 pi Agent（及未来协作者）快速接手项目。详细设计见 docs 清单（第 6 节），本文件只保留决策与现状。

## 1. 项目是什么

**yiA** —— 部署在个人电脑上的"第二大脑"个人助理：对话式存储信息、按需提炼知识、定时提醒事务。基于 **Pi SDK（@earendil-works/pi-coding-agent）** 二次开发，**不修改 Pi 内核**。

三大能力目标：
1. **存得快**：一句话丢给 yiA 即完成存储、标签、关联（≤10 秒）
2. **取得准**：自然语言提问 → 跨记忆条目综合提炼 + 来源引用
3. **会主动**：定时提醒可推送到手机微信

核心场景（验收基准，详见 PRD 第 3 节）：灵感捕获、事项+定时提醒、知识提炼、微信随时对话。

## 2. 关键决策（已定，不要推翻）

| 决策 | 结论 |
|---|---|
| 开发环境 | **WSL（Ubuntu 24.04）内完成全部开发**；用户已在 WSL 安装了独立的 pi Agent |
| 项目目录 | **`~/yiA`（WSL 原生路径，性能好）**；曾往 /mnt/e/yiA，因跨文件系统 npm 慢已迁移。代码在 `yiA/` 子目录，数据 `runtime/` 在根 |
| 技术栈 | TypeScript 主体（Node ≥ 20.6）+ Python 辅助（文档解析/检索小服务，不在主链路） |
| Agent 内核 | Pi SDK `createAgentSession` / ExtensionFactory，内核零改动，只用公开 ExtensionAPI（inno-agent 已验证此路径） |
| 运行时独立 | **yiA 的 agent 运行时完全独立**（2026-09-11 定）：agentDir=`runtime/agent/`（settings/auth/models-store/会话全在内，gitignored），与用户个人 pi（~/.pi/agent）零共享；改 yiA 模型只改 `runtime/agent/settings.json`，首次部署由 provision.sh 从个人 pi 一次性迁移凭据 |
| 记忆系统 | 借鉴 inno-agent 三层：L1 画像(JSON) / L2 知识库(Markdown 条目+BM25+自动关联，预留向量升级位) / L3 会话(SQLite FTS5 叠加 Pi 会话 JSONL)，含阈值门控召回 |
| 微信渠道 | **封装 ClawBot**（`@tencent-weixin/openclaw-weixin`，腾讯微信团队官方插件，iLink 官方接口）——Gateway 与 yiA 同在 WSL（systemd 常驻），CLI 后端插件把微信消息直接交给 yiA 无头会话；仅支持私聊（2026-09-11 由 Windows 侧车改为 WSL 直连，少一层跨系统） |
| 分期 | **TUI 期做齐全部功能能力（含微信）**；Web 期只做 UI 增值（浏览/管理/知识图谱）；App 远期 |
| 知识图谱可视化 | Web 期用 Cytoscape（对齐 inno-agent wiki 图谱）；若难实现降级为关联列表，图谱顺延 App 阶段 |

## 3. 形态与里程碑

形态顺序：TUI（含微信渠道）→ Web → App（远期）。

里程碑（详见 PRD 第 6 节）：
- **M1 TUI 骨架** ✅ 已完成（2026-09-11）：扩展工厂 + remember/recall + L2 存储，代码见 `yiA/src/`，文档见 docs/
- **M2 记忆完整** ✅ 已完成（2026-09-11）：L1 画像 + L3 会话索引(FTS5) + 覆盖率门控召回 + ContextPack 注入 + 自动关联(双向链接) + refine + 统一日志；单测 18 条、万条 bench 冷 395ms/热 P95 16.8ms
- **M3 提醒调度** ✅ 已完成（2026-09-11）：自然语言建提醒（LLM 换算 ISO，工具校验）+ jobs.json/runs.jsonl 持久化 + 30s 周期触发 + 错过补发 + repeatDays 重复；单测 26 条
- **M4 微信接入** ◐ 代码+部署完成（2026-09-11）：WSL 直连方案——openclaw@2026.8.1 + wechat 插件 + yia-cli CLI 后端已装，Gateway systemd 服务常驻，clawbot 适配器（发送/降级链）+ chat-cli 无头会话（连续性已 E2E）；**待人工**：`openclaw channels login --channel openclaw-weixin` 扫码 → 配对 → 填 targetPeer
- M5 TUI 打磨（记忆管理命令、send_message 跨渠道路由、2 周自用验证）
- M6 Web MVP（HTTP+SSE 对话、记忆浏览/编辑）——TUI 成熟后启动
- M7 知识图谱（Cytoscape）

## 4. 环境现状（2026-09-11 体检，可支撑全部里程碑）

- WSL Ubuntu 24.04：Python 3.12 ✅、git 2.43 ✅、磁盘 949G 空闲 ✅、内存 7.7G（够用，M6 前后端同跑时略紧）
- WSL 内：Node v22.23.2 ✅、npm 10.9.8 ✅、pi 0.85.1 ✅、`node:sqlite` + FTS5 ✅（M2/M3 可用）、openclaw 2026.8.2 ✅（M4 Gateway，systemd 常驻；8.1 有消息分发竞态 bug 已规避）
- Windows interop ✅（WSL 可直接调 Windows Node v22.15.0，M4 ClawBot 侧车可部署）
- npm registry / github 连通正常；/mnt/e 可读写

## 5. 工程约束

- 目录规划：**代码全部在 `yiA/` 子目录**（`yiA/src/agent/` 扩展工厂+工具、`yiA/src/memory/{l1,l2,l3}/`、`yiA/src/scheduler/`、`yiA/src/channels/`、`yiA/src/server/`(M6)、`yiA/web/`(M6)、`yiA/scripts/`）；数据 `runtime/` 与加载器 `.pi/` 留在项目根（便于备份与 pi 发现）；根目录只放 AGENTS.md 与 docs/
- 扩展工具限制文件写入在 runtime/ 内（参考 inno-agent workspace-path-guard）
- 密钥（微信凭据/API key）不入库、不进会话记录；runtime/ 整体可备份
- **日志**：统一走 `yiA/src/logger.ts`（M2 落地），落根目录 `runtime/logs/yia.log`；禁记记忆正文、凭据、会话原文；禁用散落的 console.log（详见 PRD §10.1）
- **异常**：工具 execute 必指并返回错误文本；工厂初始化不得抛出拖垮 pi 启动；单条数据损坏跳过不崩；禁止空 catch（详见 PRD §10.2）
- **测试**：提交前（在 `yiA/` 目录下）`npm test` + `npm run loadcheck` 必过；单测用 node:test 不引第三方；每个 IO 边界有破坏性用例（详见 docs/测试方案.md）
- 性能基线：记忆 ≤1 万条检索 <1s；TUI 冷启动 <3s；微信端到端 <5s
- 提醒任务持久化，重启不丢

## 6. 文档索引（都在 docs/ 目录）

| 文件 | 内容 |
|---|---|
| `docs/yiA-PRD.md` | **产品需求文档 v0.2**：场景、功能、里程碑、非功能、风险——先读这个 |
| `docs/inno-agent技术架构拆解.md` | 主要参考项目的架构拆解：三层记忆实现、Pi 集成范式、技术选型 |
| `docs/pi-Agent二次开发方案.md` | Pi 的 8 种二次开发路径总览（扩展/SDK/RPC/包） |
| `docs/Pi-Agent个人助理项目调研.md` | 竞品调研（openclaw/khoj/leon 等 + Pi 生态） |
| `docs/测试方案.md` | 测试分层、各里程碑必测项、性能基准、异常路径用例 |

## 7. 参考实现（GitHub）

- **hhyqhh/inno-agent**（1204★）：核心参考——三层记忆、扩展工厂+钩子注入范式、channels/调度器实现，MIT
- **openclaw/openclaw** 的微信插件生态：`@tencent-weixin/openclaw-weixin`（ClawBot）官方文档 docs.openclaw.ai/channels/wechat.md
- Pi 官方：pi.dev / github.com/earendil-works/pi（docs/ 与 examples/ 齐全）
