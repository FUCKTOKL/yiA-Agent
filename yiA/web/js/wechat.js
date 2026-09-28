/** 微信页：通道状态 / 测试消息 / 换绑向导（Web 版 /wechat，全程免终端） */
import { $, $$, esc, api } from "./api.js";

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

/* ===== 换绑向导：五步（登出→扫码→配对→推送目标→重启），与 TUI /wechat 同一套后端操作 ===== */
const step = (n) => {
  $$(".rb-step").forEach((el, i) => el.classList.toggle("on", i === n - 1));
  $$(".rb-pane").forEach((el, i) => el.classList.toggle("show", i === n - 1));
};

$("#rbStart").onclick = async () => {
  $("#rbStart").disabled = true; $("#rbStart").textContent = "登出中…";
  try {
    const r = await api.wechatLogoutAll();
    $("#rbLog1").textContent = r.moved.length ? `已登出：${r.moved.join("、")}` : "（无在线账号，直接登录）";
    step(2);
    qrLogin();
  } catch (e) { $("#rbLog1").textContent = `失败：${e.message}`; }
  $("#rbStart").disabled = false; $("#rbStart").textContent = "开始换绑";
};

function qrLogin() {
  const qrBox = $("#rbQr"); qrBox.textContent = "等待二维码…";
  api.sse("/api/wechat/rebind/qr", {}, (evt, data) => {
    if (evt === "qr") { qrBox.textContent = data.text || "…"; $("#rbSt2").textContent = "扫码后自动进入下一步"; }
    if (evt === "done") {
      $("#rbSt2").textContent = `登录成功，发送账号已绑定：${data.account ?? "?"}`;
      setTimeout(() => step(3), 800);
    }
    if (evt === "error") { $("#rbSt2").textContent = `失败：${data.error}`; qrBox.textContent = ""; }
  });
}

$("#rbPairRefresh").onclick = async () => {
  const { text } = await api.wechatPairing();
  $("#rbPairList").textContent = text || "（无待批准配对——先用个人号给 bot 发条消息）";
};
$("#rbApprove").onclick = async () => {
  const code = $("#rbPairCode").value.trim();
  if (!code) return;
  const r = await api.wechatApprove(code);
  $("#rbPairMsg").textContent = r.ok ? "已批准 ✓" : `结果：${r.text}`;
};

$("#rbTargetSave").onclick = async () => {
  const peer = $("#rbTarget").value.trim();
  try { await api.wechatSetTarget(peer); $("#rbTargetMsg").textContent = "已保存 ✓"; step(5); }
  catch (e) { $("#rbTargetMsg").textContent = e.message; }
};

$("#rbRestart").onclick = async () => {
  $("#rbRestart").disabled = true; $("#rbRestart").textContent = "重启中…";
  await api.wechatRestart().catch(() => {});
  $("#rbRestart").disabled = false; $("#rbRestart").textContent = "重启完成 ✓";
  $("#rbDone").hidden = false;
  reload();
};

$("#rbTo4").onclick = () => step(4);

export async function initWechat() { await reload(); step(1); }
