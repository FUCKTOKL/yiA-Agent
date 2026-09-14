/** 状态浮层数据（标签轨底部） */
import { $ } from "./api.js";

export async function refreshStatus() {
  try {
    const s = await (await fetch("/api/status")).json();
    const ok = (v) => v === "online";
    $("#stDaemon").textContent = s.daemon === "online" ? "在线" : s.daemon;
    $("#stGw").textContent = s.gateway === "online" ? "在线" : "离线";
    $("#sdDaemon").className = "sdot " + (ok(s.daemon) ? "ok" : "bad");
    $("#sdGw").className = "sdot " + (ok(s.gateway) ? "ok" : "bad");
    $("#stMem").textContent = s.memCount;
    $("#stRem").textContent = s.pendingRems;
  } catch (e) {
    $("#stDaemon").textContent = $("#stGw").textContent = "不可达";
  }
}
