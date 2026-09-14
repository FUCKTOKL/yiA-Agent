@echo off
rem yiA 调度守护进程（Windows 启动器）：提醒定时触发的唯一常驻进程
rem 用法：手动运行本文件，或把它的快捷方式放进 shell:startup 实现开机自启
rem （provision.ps1 已自动放置快捷方式；Linux/macOS 对应 systemd/launchd，见 yia-scheduler.service）

if not defined YIA_ROOT set "YIA_ROOT=%~dp0..\..\.."

title yiA-scheduler
cd /d "%YIA_ROOT%"
node --experimental-strip-types "%YIA_ROOT%\yiA\scripts\scheduler-daemon.ts"
