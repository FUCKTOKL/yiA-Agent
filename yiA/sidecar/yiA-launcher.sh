#!/usr/bin/env bash
# yiA TUI 启动器（Linux/macOS/WSL）：以独立的 agent 运行时启动 pi（与用户个人的 ~/.pi/agent 互不影响）
# 由 provision.sh 安装到 PATH（~/.npm-global/bin/yiA）；Windows 用 scripts/win/yia.bat
set -euo pipefail

# 项目根 = 本脚本所在目录的上两层（sidecar/yiA-launcher.sh → 仓库根）
YIA_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# 独立运行时：配置/凭据/会话/默认模型全部在 runtime/agent/（gitignored）
export PI_CODING_AGENT_DIR="$YIA_ROOT/runtime/agent"

# 项目根作为 cwd：.pi/extensions 发现 yiA 扩展（记忆/提醒/微信/命令）
cd "$YIA_ROOT"

exec pi "$@"
