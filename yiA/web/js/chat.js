/** 对话页：真实会话（SSE）+ ContextPack 折叠条 + 历史岛（runtime/chats/ 各通道） */
import { $, $$, esc, api } from "./api.js";
import { openFocus } from "./memory.js";

const chatScroll = $("#chatScroll"), chatInput = $("#chatInput"), sendBtn = $("#sendBtn");
const ID_RE = /\b(\d{8}\d{6}-[a-z0-9]{4,8})\b/g; // 条目 id 形如 20260914135201-k7x9mf

let memIndex = []; // id→{title,sum} 缓存，供引用芯片悬浮
api.memory().then((d) => { memIndex = d.entries; }).catch(() => {});

const now = () => new Date().toTimeString().slice(0, 5);
const linkIds = (html) =>
  html.replace(ID_RE, (id) => `<span class="hl" data-id="${id}">${id}</span>`);

function appendMsg(who, html, t = now()) {
  if (who === "user") {
    chatScroll.insertAdjacentHTML("beforeend", `<div class="msg user"><div class="who">我 · ${t}</div><div class="bubble">${esc(html)}</div></div>`);
  } else {
    chatScroll.insertAdjacentHTML("beforeend", `<div class="msg ai"><div class="who">yiA · ${t}</div><div class="body">${linkIds(html)}</div></div>`);
  }
  chatScroll.scrollTop = chatScroll.scrollHeight;
}

async function loadHistory() {
  const { msgs } = await api.chatHistory();
  if (msgs.length) {
    $("#chatEmpty").hidden = true; chatScroll.style.display = "";
    for (const m of msgs.slice(-20)) appendMsg(m.who === "user" ? "user" : "ai", m.who === "user" ? esc(m.text) : m.text, m.t);
  } else {
    $("#chatEmpty").hidden = false; chatScroll.style.display = "none";
  }
}

async function loadCtx() {
  const c = await api.context();
  const secs = [
    ["当前时间", c.now],
    ["用户画像", Object.values(c.profile ?? {}).flat().join("；").slice(0, 80) || "（空）"],
    ["相关记忆", c.recent.map((r) => r.id).join(" · ") || "（无）"],
    ["待办提醒", c.reminders.map((r) => `${r.at.slice(5, 16)} ${r.title}（${r.channel}）`).join(" · ") || "（无）"],
  ];
  $("#ctxGrid").innerHTML = secs.map(([k, v]) => `<div><b>${k}</b>　${esc(v)}</div>`).join("");
  $("#ctxBar .t").textContent = `ContextPack 已注入 · ${secs.length} sections`;
}

let busy = false;
async function send() {
  const v = chatInput.value.trim();
  if (!v || busy) return;
  busy = true; sendBtn.disabled = true;
  $("#chatEmpty").hidden = true; chatScroll.style.display = "";
  appendMsg("user", v);
  chatInput.value = "";
  appendMsg("ai", '<span style="opacity:.55">思考中…</span>');
  const think = chatScroll.lastElementChild;
  await api.chat(v, (evt, data) => {
    if (evt === "done") { think.querySelector(".body").innerHTML = linkIds(esc(data.text)); }
    if (evt === "error") { think.querySelector(".body").innerHTML = `<span style="color:#E26252">${esc(data.error)}</span>`; }
    chatScroll.scrollTop = chatScroll.scrollHeight;
  });
  busy = false; sendBtn.disabled = false; chatInput.focus();
}

sendBtn.onclick = send;
chatInput.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
$$(".quick").forEach((b) => (b.onclick = () => { chatInput.value = b.textContent; chatInput.focus(); }));
$("#ctxBar").onclick = () => $("#ctxBar").classList.toggle("open");

/* 引用高亮 id → 打开聚焦阅读层（与记忆页共用） */
chatScroll.addEventListener("click", (e) => {
  const h = e.target.closest(".hl");
  if (h && memIndex.some((m) => m.id === h.dataset.id)) openFocus(h.dataset.id);
});

/* 历史岛：runtime/chats/ 会话清单（含微信/CLI 通道的连续会话） */
async function loadSessions() {
  const { sessions } = await (await fetch("/api/status").then(() => ({ sessions: [] }))).catch(() => ({ sessions: [] }));
  // ponytail: 会话清单接口暂缺（M6.1 加 GET /api/sessions），先展示当前 web 会话
  $("#histList").innerHTML = `<div class="hist-item glass-sub active"><h4>Web 会话</h4><div class="mono">runtime/chats/web.jsonl</div></div>`;
}

export async function initChat() {
  chatInput.disabled = false; sendBtn.disabled = false;
  loadCtx().catch(() => {});
  await loadHistory().catch(() => {});
  loadSessions();
}
