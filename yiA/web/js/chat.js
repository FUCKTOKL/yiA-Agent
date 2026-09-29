/** 对话页：真实会话（SSE）+ ContextPack 折叠条 + 历史岛（runtime/chats/ 各通道） */
import { $, $$, esc, api } from "./api.js";
import { openFocus } from "./memory.js";

const chatScroll = $("#chatScroll"), chatInput = $("#chatInput"), sendBtn = $("#sendBtn");
const ID_RE = /\b(\d{8}\d{6}-[a-z0-9]{4,8})\b/g; // 条目 id 形如 20260914135201-k7x9mf

let memIndex = []; // id→{title,sum} 缓存，供引用芯片悬浮
api.memory().then((d) => { memIndex = d.entries; }).catch(() => {});

/** 当前会话：右岛可切换/新建，发送与历史都跟随 */
let activeSession = "web";
const fmtTs = (iso) => { try { return new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }); } catch { return ""; } };

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
  const { msgs } = await api.chatHistory(activeSession);
  // 清旧消息（保留 ctxBar），一次只显示当前会话的历史
  $$("#chatScroll .msg").forEach((el) => el.remove());
  if (msgs.length) {
    $("#chatEmpty").hidden = true; chatScroll.style.display = "";
    for (const m of msgs.slice(-20)) appendMsg(m.who === "user" ? "user" : "ai", m.who === "user" ? esc(m.text) : m.text, m.t ? fmtTs(m.t) : undefined);
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
  // 斜杠命令兜底：面板被关（如点外）时手敲完整命令也能执行，绝不发给模型
  if (v.startsWith("/")) {
    busy = true;
    chatInput.value = "";
    hideCmd();
    sysMsg(`$ ${v}`);
    const [cmd, ...rest] = v.split(/\s+/);
    const c = COMMANDS.find((x) => x.cmd === cmd);
    try { await Promise.resolve(c ? c.run(rest.join(" ")) : sysMsg(`未知命令 ${cmd}，/help 看清单`)); }
    catch (e) { sysMsg("出错：" + e.message); }
    busy = false; sendBtn.disabled = false; chatInput.focus();
    return;
  }
  busy = true; sendBtn.disabled = true;
  $("#chatEmpty").hidden = true; chatScroll.style.display = "";
  appendMsg("user", v);
  chatInput.value = "";
  appendMsg("ai", '<span style="opacity:.55">思考中…</span>');
  const think = chatScroll.lastElementChild;
  await api.chat(v, (evt, data) => {
    if (evt === "done") { think.querySelector(".body").innerHTML = linkIds(esc(data.text)); loadSessions(); }
    if (evt === "error") { think.querySelector(".body").innerHTML = `<span style="color:#E26252">${esc(data.error)}</span>`; }
    chatScroll.scrollTop = chatScroll.scrollHeight;
  }, activeSession);
  busy = false; sendBtn.disabled = false; chatInput.focus();
}

sendBtn.onclick = send;
chatInput.addEventListener("keydown", (e) => {
  // 命令面板键盘导航（面板可见时拦截方向键/Enter/Tab/Esc）
  if (cmdMenu.style.display !== "none") {
    const opts = [...$$("#cmdMenu .cmd-row")];
    let i = opts.findIndex((o) => o.classList.contains("sel"));
    if (e.key === "ArrowDown") { e.preventDefault(); opts[i]?.classList.remove("sel"); opts[(i + 1) % opts.length].classList.add("sel"); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); opts[i]?.classList.remove("sel"); opts[(i - 1 + opts.length) % opts.length].classList.add("sel"); return; }
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); opts[i]?.click(); return; }
    if (e.key === "Escape") { hideCmd(); return; }
  }
  if (e.key === "Enter") send();
});

/* ===== 斜杠命令：yiA 功能直达（客户端拦截，不发给模型） ===== */
const cmdMenu = $("#cmdMenu");
const COMMANDS = [
  { cmd: "/login", desc: "模型接入（查看/更新 key）", run: () => runLogin() },
  { cmd: "/model", desc: "查看/切换默认模型", arg: "模型id（留空看清单）", run: (a) => runModel(a) },
  { cmd: "/status", desc: "系统状态", run: async () => sysMsg(JSON.stringify(await api.status(), null, 0)) },
  { cmd: "/reminders", desc: "待办提醒清单", run: async () => {
      const { pending } = await api.reminders();
      sysMsg(pending.length ? pending.map((r) => `${r.at.slice(5, 16)} ${r.title}（${r.channel === "tui" ? "TUI" : "微信"}）`).join("\n") : "当前没有排期中的提醒");
    } },
  { cmd: "/memory", desc: "检索知识库", arg: "关键词", run: async (a) => {
      const { entries } = await api.memory(a || "");
      sysMsg(entries.length ? entries.slice(0, 8).map((m) => `${m.id} ${m.title}`).join("\n") : "没有匹配的条目");
    } },
  { cmd: "/new", desc: "新开一个对话", run: () => $("#newChatBtn").click() },
  { cmd: "/help", desc: "列出全部命令", run: () => sysMsg(COMMANDS.map((c) => c.cmd + (c.arg ? ` ${c.arg}` : "") + " — " + c.desc).join("\n")) },
];
const sysMsg = (text) => appendMsg("ai", esc(text).replace(/\n/g, "<br>"));
const hideCmd = () => { cmdMenu.style.display = "none"; };

function showCmd(filter) {
  const list = COMMANDS.filter((c) => !filter || c.cmd.startsWith(filter));
  if (!list.length) { hideCmd(); return; }
  cmdMenu.innerHTML = list.map((c, i) =>
    `<div class="cmd-row${i === 0 ? " sel" : ""}" data-cmd="${c.cmd}"><b>${c.cmd}</b>${c.arg ? ` <span class="arg">${c.arg}</span>` : ""}<span>${c.desc}</span></div>`).join("");
  cmdMenu.style.display = "block";
  $$("#cmdMenu .cmd-row").forEach((row) => {
    row.onclick = () => execCmd(row.dataset.cmd);
  });
}
function execCmd(raw) {
  hideCmd(); chatInput.value = "";
  const [cmd, ...rest] = raw.trim().split(/\s+/);
  const c = COMMANDS.find((x) => x.cmd === cmd);
  if (!c) return;
  sysMsg(`$ ${raw}`);
  Promise.resolve(c.run(rest.join(" "))).catch((e) => sysMsg("出错：" + e.message));
}
async function runLogin() {
  const info = await api.loginInfo();
  sysMsg(`当前接入：${Object.keys(info.auth).join("、") || "（无）"} · 默认模型：${info.defaultModel || "未设"}\n在下方输入 provider 与 key 即可更新，格式：provider your-api-key`);
  loginPending = true;
}
async function runModel(arg) {
  const info = await api.loginInfo();
  if (!arg) { sysMsg(`可用模型：\n${info.models.map((m) => m.id).join("\n")}\n当前默认：${info.defaultModel || "未设"}\n切换：/model 模型id`); return; }
  const m = info.models.find((x) => x.id === arg);
  if (!m) return sysMsg(`没有模型 ${arg}，/model 看清单`);
  await api.setModel(m.id);
  sysMsg(`默认模型已切到 ${m.id}，新会话生效`);
}
let loginPending = false;

chatInput.addEventListener("input", () => {
  const v = chatInput.value;
  // /login 后等待 provider key；但新命令输入（/ 开头）取消等待，回到命令流
  if (loginPending && v.trim() && !v.startsWith("/")) {
    const [provider, ...rest] = v.trim().split(/\s+/);
    if (rest.length) {
      loginPending = false; chatInput.value = "";
      api.loginKey(provider, rest.join(" ")).then(() => sysMsg(`已更新 ${provider} 的接入，新会话生效`)).catch((e) => sysMsg("失败：" + e.message));
      return;
    }
  }
  if (v.startsWith("/") && !v.includes(" ")) showCmd(v);
  else if (v.startsWith("/")) {
    const [c, ...rest] = v.trim().split(/\s+/);
    const match = COMMANDS.find((x) => x.cmd === c);
    if (match && (rest.length || c !== "/memory" && c !== "/model")) { hideCmd(); return; }
    showCmd(c);
  } else hideCmd();
});
document.addEventListener("click", (e) => { if (!cmdMenu.contains(e.target) && e.target !== chatInput) hideCmd(); });
$$(".quick").forEach((b) => (b.onclick = () => { chatInput.value = b.textContent; chatInput.focus(); }));
$("#ctxBar").onclick = () => $("#ctxBar").classList.toggle("open");

/* 引用高亮 id → 打开聚焦阅读层（与记忆页共用） */
chatScroll.addEventListener("click", (e) => {
  const h = e.target.closest(".hl");
  if (h && memIndex.some((m) => m.id === h.dataset.id)) openFocus(h.dataset.id);
});

/* 右岛：全部历史会话（首条用户消息命名），点击切换，可新建 */
async function loadSessions() {
  try {
    const { sessions } = await api.sessions();
    $("#histList").innerHTML = sessions.map((s) => `
      <div class="hist-item glass-sub ${s.id === activeSession ? "active" : ""}" data-id="${s.id}">
        <h4>${esc(s.title)}</h4>
        <div class="mono">${s.src === "web" ? "Web" : "微信"} · ${s.count} 条 · ${esc(fmtTs(s.lastTs))}</div>
        <button class="del" title="删除此会话记录">×</button>
      </div>`).join("") || '<div class="empty-block"><p>还没有会话</p></div>';
    $$("#histList .hist-item").forEach((el) => {
      el.onclick = async () => {
        activeSession = el.dataset.id;
        $$("#histList .hist-item").forEach((x) => x.classList.toggle("active", x === el));
        await loadHistory().catch(() => {});
      };
      el.querySelector(".del").onclick = async (e) => {
        e.stopPropagation();
        const id = el.dataset.id;
        if (!confirm(`删除会话「${el.querySelector("h4").textContent}」的全部本地记录？此操作不可恢复。`)) return;
        try {
          await api.deleteSession(id);
          if (id === activeSession) {
            activeSession = "web";
            $$("#chatScroll .msg").forEach((x) => x.remove());
            await loadHistory().catch(() => {});
          }
          loadSessions();
        } catch (err) { alert("删除失败：" + err.message); }
      };
    });
  } catch (e) {
    $("#histList").innerHTML = `<div class="empty-block"><p>会话列表加载失败：${esc(e.message)}</p></div>`;
  }
}
$("#newChatBtn").onclick = () => {
  activeSession = `web-${Date.now().toString(36)}`;
  chatScroll.innerHTML = "";
  $("#chatEmpty").hidden = false; chatScroll.style.display = "none";
  loadSessions();
};

export async function initChat() {
  chatInput.disabled = false; sendBtn.disabled = false;
  loadCtx().catch(() => {});
  await loadHistory().catch(() => {});
  loadSessions();
}