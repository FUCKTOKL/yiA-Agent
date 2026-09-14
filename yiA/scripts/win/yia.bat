@echo off
rem yiA TUI 启动器（Windows）：独立 agent 运行时启动 pi，与个人 %USERPROFILE%\.pi\agent 互不影响
rem 前置：npm i -g @earendil-works/pi-coding-agent openclaw@2026.8.2
rem 可选环境变量 YIA_ROOT 覆盖仓库根（默认从本脚本位置推导）

if defined YIA_ROOT goto run
rem scripts\win\yia.bat -> 上三层 = 仓库根
set "YIA_ROOT=%~dp0..\..\.."

:run
set "PI_CODING_AGENT_DIR=%YIA_ROOT%\runtime\agent"
cd /d "%YIA_ROOT%"
pi %*
