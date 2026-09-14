# yiA Windows 部署脚本（对应 Linux/macOS 的 provision.sh）
# 用法：powershell -ExecutionPolicy Bypass -File yiA\scripts\win\provision.ps1
# 前置：Node >= 22.13（含 --experimental-strip-types）、npm、微信扫码需人工完成
# 可重复执行（幂等）：已安装的组件跳过。
$ErrorActionPreference = "Stop"

$YiaRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\")).Path
$Ag = Join-Path $YiaRoot "runtime\agent"
$CfgDir = Join-Path $YiaRoot "runtime\config"
Write-Host "== yiA Windows 部署（仓库根：$YiaRoot）=="

# 1) 全局依赖：openclaw（锁定版本）+ pi
Write-Host "== 1/6 安装全局依赖（openclaw@2026.8.2 + pi）=="
npm install -g openclaw@2026.8.2
npm list -g @earendil-works/pi-coding-agent *> $null
if ($LASTEXITCODE -ne 0) { npm install -g @earendil-works/pi-coding-agent }

# 2) 微信插件 + yiA 大脑插件（clawbot-yia 侧车）
Write-Host "== 2/6 安装 openclaw 插件 =="
openclaw plugins install @tencent-weixin/openclaw-weixin --accept-capabilities
if ($LASTEXITCODE -ne 0) { openclaw plugins install @tencent-weixin/openclaw-weixin --force --accept-capabilities }
openclaw plugins install (Join-Path $YiaRoot "yiA\sidecar\clawbot-yia") --force --accept-capabilities

# 3) 独立 agent 运行时：优先从个人 pi 迁移凭据；没有则提示手动配置
Write-Host "== 3/6 准备 agent 运行时（runtime\agent\）=="
New-Item -ItemType Directory -Force -Path $Ag | Out-Null
$personalPi = Join-Path $env:USERPROFILE ".pi\agent"
$authDst = Join-Path $Ag "auth.json"
if (-not (Test-Path $authDst) -and (Test-Path (Join-Path $personalPi "auth.json"))) {
    Copy-Item (Join-Path $personalPi "auth.json") $authDst
    if (Test-Path (Join-Path $personalPi "models-store.json")) {
        Copy-Item (Join-Path $personalPi "models-store.json") (Join-Path $Ag "models-store.json")
    }
    Write-Host "已从个人 pi 迁移凭据 ✓"
} elseif (-not (Test-Path $authDst)) {
    Write-Host "⚠️ 未发现个人 pi 凭据：请在 $auth.json 手动填入 API key（参考 README『模型配置』）"
    New-Item -ItemType File -Force -Path $authDst | Out-Null
}
# 默认模型设置（存在则跳过）
$settings = Join-Path $Ag "settings.json"
if (-not (Test-Path $settings)) {
    '{"defaultModel":"glm-5.3","defaultProvider":"zai-coding-cn"}' | Out-File -Encoding utf8 $settings
}

# 4) 微信通道配置骨架（token 由用户从 openclaw config get GATEWAY_TOKEN 填写）
Write-Host "== 4/6 生成 wechat.json 骨架 =="
New-Item -ItemType Directory -Force -Path $CfgDir | Out-Null
$wechat = Join-Path $CfgDir "wechat.json"
if (-not (Test-Path $wechat)) {
    @'
{
  "enabled": true,
  "gatewayUrl": "http://localhost:18789",
  "gatewayToken": "填入 openclaw config get GATEWAY_TOKEN 的值",
  "channel": "openclaw-weixin",
  "account": "扫码登录后由 /wechat 换绑流程自动填入",
  "targetPeer": "配对后填入你的微信 id（xxx@im.wechat）"
}
'@ | Out-File -Encoding utf8 $wechat
}

# 5) Gateway 服务（Windows 上 openclaw 用任务计划程序 schtasks 常驻）
Write-Host "== 5/6 安装 Gateway 服务 =="
openclaw gateway install

# 6) 调度守护：开机自启（快捷方式放进 shell:startup）
Write-Host "== 6/6 调度守护开机自启 =="
$startup = [Environment]::GetFolderPath("Startup")
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut((Join-Path $startup "yiA-scheduler.lnk"))
$sc.TargetPath = Join-Path $YiaRoot "yiA\scripts\win\start-daemon.bat"
$sc.WindowStyle = 7  # 最小化
$sc.WorkingDirectory = $YiaRoot
$sc.Save()
Write-Host "已放入启动文件夹 ✓"

Write-Host @"

== 部署完成，剩余人工步骤 ==
1. 启动 TUI：双击 yiA\scripts\win\yia.bat（或把它加入 PATH）
2. 在 TUI 里运行 /wechat 完成扫码登录 + 配对 + 推送目标（全自动引导）
3. 重启电脑或运行 yiA\scripts\win\start-daemon.bat 让提醒守护生效
"@
