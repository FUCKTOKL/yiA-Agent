/** 对话页：回复与失败状态都明确显示，历史和实时消息使用相同的安全文本渲染。 */
import { $, $$, api } from "./api.js";
import { openFocus } from "./memory.js";
import { openBookCitation } from "./books.js";

const chatScroll = $("#chatScroll"), chatInput = $("#chatInput"), sendBtn = $("#sendBtn");
const ID_RE = /\b(?:\d{14}-[a-z0-9]{4,8}|bk_[a-f0-9]{24}:[1-9]\d*)\b/g;
let memIndex = [];
api.memory().then((d) => { memIndex = d.entries; }).catch(() => {});
let activeSession = "web", busy = false;
const now = () => new Date().toTimeString().slice(0, 5);
const fmtTs = (iso) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
};
const node = (tag, className, text) => {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
};

function renderBody(body, text, error = false) {
  body.replaceChildren();
  body.classList.remove("is-thinking");
  body.classList.toggle("reply-error", error);
  if (error) body.setAttribute("role", "alert");
  else body.removeAttribute("role");
  const value = String(text ?? "");
  let offset = 0;
  for (const match of value.matchAll(ID_RE)) {
    body.append(document.createTextNode(value.slice(offset, match.index)));
    const isBook = match[0].startsWith("bk_");
    const ref = node(isBook ? "button" : "span", isBook ? "book-cite" : "hl", match[0]);
    if (isBook) {
      ref.type = "button";
      ref.setAttribute("aria-label", "查看书籍原文 " + match[0]);
      ref.onclick = () => { const [id, n] = match[0].split(":"); void openBookCitation(id, Number(n)); };
    } else ref.dataset.id = match[0];
    body.append(ref);
    offset = match.index + match[0].length;
  }
  body.append(document.createTextNode(value.slice(offset)));
}

function appendMsg(who, text, t = now(), error = false) {
  const message = node("div", `msg ${who === "user" ? "user" : "ai"}`);
  const body = node("div", who === "user" ? "bubble" : "body");
  message.append(node("div", "who", `${who === "user" ? "我" : "yiA"} · ${t}`), body);
  renderBody(body, text, error);
  chatScroll.append(message);
  chatScroll.scrollTop = chatScroll.scrollHeight;
  return body;
}

async function loadHistory() {
  const { msgs } = await api.chatHistory(activeSession);
  $$("#chatScroll .msg").forEach((el) => el.remove());
  $("#chatEmpty").hidden = !!msgs.length;
  chatScroll.style.display = msgs.length ? "" : "none";
  for (const m of msgs.slice(-20)) appendMsg(m.who, m.text, m.t ? fmtTs(m.t) : undefined, m.error === true);
}

async function loadCtx() {
  const c = await api.context();
  const sections = [
    ["当前时间", c.now],
    ["用户画像", Object.values(c.profile ?? {}).flat().join("；").slice(0, 80) || "（空）"],
    ["相关记忆", (c.recent ?? []).map((r) => r.id).join(" · ") || "（无）"],
    ["待办提醒", (c.reminders ?? []).map((r) => `${r.at.slice(5, 16)} ${r.title}（${r.channel}）`).join(" · ") || "（无）"],
  ];
  $("#ctxGrid").replaceChildren(...sections.map(([key, value]) => {
    const row = node("div", "");
    row.append(node("b", "", key), document.createTextNode(`　${value ?? ""}`));
    return row;
  }));
  $("#ctxBar .t").textContent = `ContextPack 已注入 · ${sections.length} 项`;
}

async function send() {
  const text = chatInput.value.trim();
  if (!text || busy) return;
  busy = true; sendBtn.disabled = true;
  try {
    if (text.startsWith("/")) {
      chatInput.value = ""; hideCmd(); sysMsg(`$ ${text}`);
      const [cmd, ...args] = text.split(/\s+/);
      const command = COMMANDS.find((c) => c.cmd === cmd);
      await (command ? command.run(args.join(" ")) : sysMsg(`未知命令 ${cmd}，/help 看清单`));
      return;
    }
    $("#chatEmpty").hidden = true;
    $("#newChatBtn").disabled = true;
    chatScroll.style.display = "";
    appendMsg("user", text);
    chatInput.value = "";
    const body = appendMsg("ai", "思考中…");
    body.classList.add("is-thinking");
    let settled = false;
    try {
      await api.chat(text, (event, data) => {
        if (event === "done" || event === "error") {
          settled = true;
          const empty = event === "done" && (typeof data.text !== "string" || !data.text.trim());
          renderBody(body, event === "error" ? (data.error || "回复失败，请重试。") : empty ? "模型没有返回可显示的回复，请重试或更换模型。" : data.text, event === "error" || empty);
          void loadSessions();
        }
        chatScroll.scrollTop = chatScroll.scrollHeight;
      }, activeSession);
      if (!settled) renderBody(body, "连接已中断，回复未完成，请重新发送。", true);
    } catch (e) {
      renderBody(body, `回复失败：${e.message}`, true);
    }
  } catch (e) {
    sysMsg(`出错：${e.message}`);
  } finally {
    busy = false; sendBtn.disabled = false; $("#newChatBtn").disabled = false; chatInput.focus();
  }
}

sendBtn.onclick = send;
const cmdMenu = $("#cmdMenu");
const COMMANDS = [
  { cmd: "/login", desc: "模型接入（查看/更新 key）", run: () => runLogin() },
  { cmd: "/model", desc: "查看/切换默认模型", arg: "模型id（留空看清单）", run: (a) => runModel(a) },
  { cmd: "/status", desc: "系统状态", run: async () => sysMsg(JSON.stringify(await api.status())) },
  { cmd: "/reminders", desc: "待办提醒清单", run: async () => {
    const { pending } = await api.reminders();
    sysMsg(pending.length ? pending.map((r) => `${r.at.slice(5, 16)} ${r.title}（${r.channel === "tui" ? "TUI" : "微信"}）`).join("\n") : "当前没有排期中的提醒");
  } },
  { cmd: "/memory", desc: "检索知识库", arg: "关键词", run: async (a) => {
    const { entries } = await api.memory(a || "");
    sysMsg(entries.length ? entries.slice(0, 8).map((m) => `${m.id} ${m.title}`).join("\n") : "没有匹配的条目");
  } },
  { cmd: "/new", desc: "新开一个对话", run: () => $("#newChatBtn").click() },
  { cmd: "/help", desc: "列出全部命令", run: () => sysMsg(COMMANDS.map((c) => `${c.cmd}${c.arg ? ` ${c.arg}` : ""} — ${c.desc}`).join("\n")) },
];
const sysMsg = (text) => appendMsg("ai", text);
const hideCmd = () => { cmdMenu.style.display = "none"; };

function showCmd(filter) {
  const commands = COMMANDS.filter((c) => !filter || c.cmd.startsWith(filter));
  if (!commands.length) { hideCmd(); return; }
  cmdMenu.replaceChildren(...commands.map((command, index) => {
    const row = node("div", `cmd-row${index === 0 ? " sel" : ""}`);
    row.dataset.cmd = command.cmd;
    row.append(node("b", "", command.cmd));
    if (command.arg) row.append(node("span", "arg", command.arg));
    row.append(node("span", "", command.desc));
    row.onclick = () => execCmd(command.cmd);
    return row;
  }));
  cmdMenu.style.display = "block";
}
function execCmd(raw) {
  hideCmd(); chatInput.value = "";
  const [cmd, ...args] = raw.trim().split(/\s+/);
  const command = COMMANDS.find((c) => c.cmd === cmd);
  if (!command) return;
  sysMsg(`$ ${raw}`);
  Promise.resolve(command.run(args.join(" "))).catch((e) => sysMsg(`出错：${e.message}`));
}
async function runLogin() {
  const info = await api.loginInfo();
  sysMsg(`当前接入：${Object.keys(info.auth).join("、") || "（无）"} · 默认模型：${info.defaultModel || "未设"}\n在下方输入 provider 与 key 即可更新，格式：provider your-api-key`);
  loginPending = true;
}
async function runModel(arg) {
  const info = await api.loginInfo();
  if (!arg) { sysMsg(`可用模型：\n${info.models.map((m) => m.id).join("\n")}\n当前默认：${info.defaultModel || "未设"}\n切换：/model 模型id`); return; }
  const model = info.models.find((m) => m.id === arg);
  if (!model) return sysMsg(`没有模型 ${arg}，/model 看清单`);
  await api.setModel(model.id);
  sysMsg(`默认模型已切到 ${model.id}，下一条消息生效`);
}
let loginPending = false;
chatInput.addEventListener("keydown", (e) => {
  if (cmdMenu.style.display !== "none") {
    const options = $$("#cmdMenu .cmd-row");
    const i = options.findIndex((o) => o.classList.contains("sel"));
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && options.length) {
      e.preventDefault(); options[i]?.classList.remove("sel");
      options[(i + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length].classList.add("sel");
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); options[i]?.click(); return; }
    if (e.key === "Escape") { hideCmd(); return; }
  }
  if (e.key === "Enter") void send();
});
chatInput.addEventListener("input", () => {
  const value = chatInput.value;
  if (loginPending && value.trim() && !value.startsWith("/")) {
    const [provider, ...rest] = value.trim().split(/\s+/);
    if (rest.length) {
      loginPending = false; chatInput.value = "";
      api.loginKey(provider, rest.join(" ")).then(() => sysMsg(`已更新 ${provider} 的接入，新会话生效`)).catch((e) => sysMsg(`失败：${e.message}`));
      return;
    }
  }
  if (value.startsWith("/")) showCmd(value.trim().split(/\s+/)[0]);
  else hideCmd();
  if (value.startsWith("/") && value.includes(" ")) hideCmd();
});
document.addEventListener("click", (e) => { if (!cmdMenu.contains(e.target) && e.target !== chatInput) hideCmd(); });
$$(".quick").forEach((button) => { button.onclick = () => { chatInput.value = button.textContent; chatInput.focus(); }; });
$("#ctxBar").onclick = () => $("#ctxBar").classList.toggle("open");
chatScroll.addEventListener("click", (e) => {
  const ref = e.target.closest(".hl");
  if (ref && memIndex.some((m) => m.id === ref.dataset.id)) openFocus(ref.dataset.id);
});

async function loadSessions() {
  const list = $("#histList");
  try {
    const { sessions } = await api.sessions();
    list.replaceChildren(...sessions.map((session) => {
      const row = node("div", `hist-item glass-sub${session.id === activeSession ? " active" : ""}`);
      row.dataset.id = session.id;
      const title = node("h4", "", session.title);
      const meta = node("div", "mono", `${session.src === "web" ? "Web" : "微信"} · ${session.count} 条 · ${fmtTs(session.lastTs)}`);
      const del = node("button", "del", "×");
      del.title = "删除此会话记录";
      row.append(title, meta, del);
      row.onclick = async () => {
        if (busy) return;
        activeSession = session.id;
        $$("#histList .hist-item").forEach((el) => el.classList.toggle("active", el === row));
        try { await loadHistory(); } catch (e) { sysMsg(`读取会话失败：${e.message}`); }
      };
      del.onclick = async (e) => {
        e.stopPropagation();
        if (busy || !confirm(`删除会话「${session.title}」的全部本地记录？此操作不可恢复。`)) return;
        try {
          await api.deleteSession(session.id);
          if (session.id === activeSession) { activeSession = "web"; await loadHistory(); }
          void loadSessions();
        } catch (err) { sysMsg(`删除失败：${err.message}`); }
      };
      return row;
    }));
    if (!sessions.length) list.append(node("div", "empty-block", "还没有会话"));
  } catch (e) {
    list.replaceChildren(node("div", "empty-block", `会话列表加载失败：${e.message}`));
  }
}
$("#newChatBtn").onclick = () => {
  activeSession = `web-${Date.now().toString(36)}`;
  $$("#chatScroll .msg").forEach((el) => el.remove());
  $("#chatEmpty").hidden = false; chatScroll.style.display = "none";
  void loadSessions();
};

export async function initChat() {
  chatInput.disabled = false; sendBtn.disabled = false;
  void loadCtx().catch(() => {});
  try { await loadHistory(); } catch (e) { sysMsg(`读取会话失败：${e.message}`); }
  void loadSessions();
}
