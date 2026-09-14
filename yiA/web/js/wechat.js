/** 微信页：通道状态 / 测试消息（真实推送）/ 换绑引导（扫码流在 TUI） */
import { $, esc, api } from "./api.js";

const setV = (sel, text, cls = "") => { const el = $(sel); el.textContent = text; el.className = "v " + cls; };

async function reload() {
  try {
    const w = await api.wechat();
    if (!w.enabled) {
      setV("#wxAccount", "未配置", "bad"); setV("#wxGateway", "—"); setV("#wxTarget", "—"); setV("#wxToken", "—");
      return;
    }
    setV("#wxAccount", w.account ? `${w.account.slice(0, 18)}…` : "未绑定", w.account ? "ok" : "bad");
    setV("#wxGateway", w.gateway === "online" ? "在线" : "离线", w.gateway === "online" ? "ok" : "bad");
    setV("#wxTarget", w.targetPeer ? w.targetPeer.slice(0, 22) + "…" : "未设置", w.targetPeer ? "" : "bad");
    setV("#wxToken", w.tokenConfigured ? "已配置" : "缺失", w.tokenConfigured ? "ok" : "bad");
  } catch (e) {
    setV("#wxAccount", "读取失败：" + e.message, "bad");
  }
}

const fb = (msg, bad = false) => { const el = $("#wxFeedback"); el.textContent = msg; el.style.color = bad ? "#E26252" : ""; };

$("#testMsgBtn").onclick = async () => {
  fb("发送中…");
  try { await api.wechatTest(); fb(`已送达 ✓ ${new Date().toTimeString().slice(0, 8)}`); }
  catch (e) { fb(`失败：${e.message}`, true); }
};

export async function initWechat() { await reload(); }
