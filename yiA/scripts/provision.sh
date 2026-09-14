#!/usr/bin/env bash
# M4 ClawBot 侧车部署脚本（WSL 直连方案，PRD F4.1）：
# 在 WSL 内安装 OpenClaw Gateway + 微信插件 + yiA 大脑插件，注册 systemd 服务常驻。
# 用法：bash yiA/scripts/provision.sh
# 前置：WSL 内 Node >= 22.13（已验证 v22.23.2）
# 扫码登录必须人工完成（脚本结束时会给出最后一步指引）。
# 可重复执行（幂等）：已安装的组件跳过，token 以 yiA 侧 wechat.json 为准。
set -euo pipefail

YIA_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CFG="$YIA_ROOT/runtime/config/wechat.json"

echo "== 1/9 WSL systemd 检查（Gateway 常驻需要）=="
if ps -p 1 -o comm= | grep -q systemd; then
  echo "systemd 已启用 ✓"
else
  echo "⚠️  systemd 未启用：请在 /etc/wsl.conf 加 [boot]\\nsystemd=true 后，Windows PowerShell 运行 wsl --shutdown 再进 WSL 重跑本脚本"
  exit 1
fi

echo "== 2/9 安装 OpenClaw CLI（若已装则跳过）=="
if command -v openclaw >/dev/null 2>&1; then
  echo "openclaw 已安装: $(openclaw --version)"
else
  # 锁定 2026.8.1：兼容 WSL 现有 Node 22.23（更新版要求 Node>=24）；2026.8.2 修复消息分发竞态，
  # 且满足微信插件 >=2026.5.12 的运行时检查
  npm install -g openclaw@2026.8.2
  openclaw --version
fi

plugins_list=$(openclaw plugins list 2>/dev/null || true)

echo "== 3/9 安装微信插件并启用 =="
if grep -q "openclaw-weixin" <<<"$plugins_list"; then
  echo "openclaw-weixin 已安装 ✓"
else
  openclaw plugins install @tencent-weixin/openclaw-weixin --accept-capabilities || \
    openclaw plugins install @tencent-weixin/openclaw-weixin --force --accept-capabilities
fi
openclaw config set plugins.entries.openclaw-weixin.enabled true >/dev/null
# 关键：browser 插件运行时会自启用并改写 config，与启动时快照不一致会炸掉消息分发
# （PreparedModelCatalogConfigReplacedError），必须预先固化
openclaw config set plugins.entries.browser.enabled true >/dev/null

echo "== 4/9 安装 yiA 大脑插件 =="
if grep -q "yia-cli" <<<"$plugins_list"; then
  echo "yia-cli 已安装 ✓"
else
  openclaw plugins install "$YIA_ROOT/yiA/sidecar/clawbot-yia" --force --accept-capabilities
fi

echo "== 5/9 初始化 yiA 独立 agent 目录（runtime/agent/）=="
# yiA 运行时与用户个人 pi（~/.pi/agent）完全隔离：
# 模型/凭据/默认设置只从 runtime/agent/ 读；此处为首次引导，
# 从个人 pi 一次性迁移凭据与模型目录缓存（此后两者互不影响）
AG="$YIA_ROOT/runtime/agent"
mkdir -p "$AG"
if [ ! -f "$AG/settings.json" ]; then
  cat > "$AG/settings.json" <<'EOF2'
{
  "defaultProvider": "zai-coding-cn",
  "defaultModel": "glm-5.3"
}
EOF2
  echo "已写入 yiA 默认模型设置（改模型只改这个文件）"
fi
if [ ! -f "$AG/auth.json" ] && [ -f "$HOME/.pi/agent/auth.json" ]; then
  cp "$HOME/.pi/agent/auth.json" "$AG/auth.json"
  echo "已从个人 pi 一次性迁移 API 凭据（此后独立维护）"
fi
[ -f "$HOME/.pi/agent/models-store.json" ] && cp "$HOME/.pi/agent/models-store.json" "$AG/models-store.json"
# 辅助工具（fd/rg）：pi 首启会自动下载，但本机 Clash TUN 的 fake-IP DNS
# 会让直连下载超时——直接从个人 pi 拷现成的（同机静态二进制）
if [ -d "$HOME/.pi/agent/bin" ] && [ ! -d "$AG/bin" ]; then
  cp -r "$HOME/.pi/agent/bin" "$AG/bin"
  echo "已迁移辅助工具（fd/rg）"
fi

echo "== 6/9 配置默认模型指向 yiA 大脑 =="
# 注意：不要在 models 里加 agentRuntime.id —— 那会触发 2026.8.1 的
# harness 绑定检查（第三方 CLI 后端只注册模型提供者，不注册 harness）
openclaw config set agents.defaults.model "yia-cli/yia" >/dev/null
openclaw config set agents.defaults.models '{"yia-cli/yia":{}}' >/dev/null

echo "== 7/9 同步 Gateway token（以 yiA 侧 wechat.json 为准）=="
# openclaw config get 会脱敏读不回真值，所以以 wechat.json 里保存的 token 为单一事实源；
# 首次部署（无 wechat.json）时生成新 token 并由步骤 7 写入 wechat.json
FIRST_RUN=0
if [ -f "$CFG" ] && python3 -c "import json,sys;sys.exit(0 if json.load(open(sys.argv[1])).get('gatewayToken') not in (None,'','__OPENCLAW_REDACTED__') else 1)" "$CFG" 2>/dev/null; then
  TOKEN=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['gatewayToken'])" "$CFG")
else
  FIRST_RUN=1
  TOKEN=$(head -c 24 /dev/urandom | base64 | tr -d '=+/\n')
fi
openclaw config set gateway.auth.token "$TOKEN" >/dev/null

if systemctl --user is-active --quiet openclaw-gateway.service 2>/dev/null; then
  echo "Gateway 服务已在运行 ✓（systemctl --user restart openclaw-gateway 可重启）"
else
  echo "== 7/9 注册并启动 systemd 服务（开机自启+常驻）=="
  openclaw gateway install 2>/dev/null || true
  systemctl --user restart openclaw-gateway.service
  sleep 3
fi
systemctl --user is-active openclaw-gateway.service

echo "== 8/9 部署调度守护与 yiA 启动器 =="
mkdir -p "$HOME/.config/systemd/user"
# 烘焙真实仓库根到 unit（模板占位符 __YIA_ROOT__）
sed "s|__YIA_ROOT__|$YIA_ROOT|g" "$YIA_ROOT/yiA/sidecar/yia-scheduler.service" > "$HOME/.config/systemd/user/yia-scheduler.service"
systemctl --user daemon-reload
systemctl --user enable --now yia-scheduler.service
systemctl --user is-active yia-scheduler.service
# 终端 yiA 命令：独立 agent 运行时启动 TUI（烘焙仓库根）
if [ -d "$HOME/.npm-global/bin" ]; then
  sed "s|^YIA_ROOT=.*|YIA_ROOT=\"$YIA_ROOT\"|" "$YIA_ROOT/yiA/sidecar/yiA-launcher.sh" | sed "/推导仓库根/d" > "$HOME/.npm-global/bin/yiA"
  chmod 755 "$HOME/.npm-global/bin/yiA"
  echo "已安装 yiA 命令 → $(command -v yiA || echo '~/.npm-global/bin/yiA')"
fi

echo "== 8/9 生成 yiA 侧微信配置 =="
mkdir -p "$YIA_ROOT/runtime/config"
if [ "$FIRST_RUN" = "1" ]; then
  cat > "$CFG" <<EOF
{
  "enabled": true,
  "gatewayUrl": "http://localhost:18789",
  "gatewayToken": "$TOKEN",
  "channel": "openclaw-weixin",
  "targetPeer": "PENDING-配对后填写"
}
EOF
  echo "已生成 $CFG"
else
  echo "wechat.json 已存在，跳过"
fi

cat <<'EOF'

== 人工步骤（必须，全程在 WSL 终端） ==
1) 扫码登录微信：
     openclaw channels login --channel openclaw-weixin
   终端会显示二维码 → 手机微信扫一扫 → 确认授权
2) 重启网关并确认在线：
     systemctl --user restart openclaw-gateway
     openclaw channels status        ← 应显示 openclaw-weixin OK
3) 配对：用另一个微信号给你的 bot 微信发一条私信，然后：
     openclaw pairing list openclaw-weixin
     openclaw pairing approve openclaw-weixin <CODE>
4) 把对方微信 id（xxx@im.wechat）填进 runtime/config/wechat.json 的 targetPeer
5) 验证推送：
     openclaw message send --channel openclaw-weixin --target <对方id> --message "yiA M4 通了"
   再用对方号给 bot 发消息，测完整对话（yiA 记忆系统在线）
EOF
