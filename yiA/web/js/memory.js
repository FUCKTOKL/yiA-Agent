/** 记忆图谱页：真实 L2 数据 + 确定性力导向布局 + 双向联动 + 聚焦层（查看/编辑/删除走 API） */
import { $, $$, api } from "./api.js";

let memories = []; // {id,title,sum,tags,links,created,body,x,y}
const byId = (id) => memories.find((m) => m.id === id);
const neighbors = (id) => byId(id)?.links ?? [];
const fileList = $("#fileList"), memCount = $("#memCount"), memEmpty = $("#memEmpty");
let query = "", hoverId = null;

const node = (tag, className, text) => {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
};
const svgNode = (tag, attrs) => {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  return el;
};
const summarize = (e) => {
  const body = (e.content ?? "").replace(/[#*`>]/g, "").replace(/\s+/g, " ").trim();
  return { ...e, sum: body.slice(0, 72) + (body.length > 72 ? "…" : ""), body: e.content ?? "" };
};

/** 确定性布局：环形初始 + 60 轮松弛（枢纽被拉向中心），无动画一次到位 */
function layout() {
  const N = memories.length || 1;
  memories.forEach((m, i) => {
    const a = (i / N) * Math.PI * 2;
    const r = 150 + (m.links.length >= 3 ? -60 : 0) + (i % 3) * 22;
    m.x = 400 + Math.cos(a) * r; m.y = 260 + Math.sin(a) * r * 0.78;
  });
  const es = edgePairs();
  for (let it = 0; it < 60; it++) {
    for (const [a, b] of es) {
      const A = byId(a), B = byId(b); if (!A || !B) continue;
      const dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy) || 1;
      const f = ((d - 130) / d) * 0.05;
      A.x += dx * f; A.y += dy * f; B.x -= dx * f; B.y -= dy * f;
    }
    memories.forEach((m) => { // 轻微向心 + 边界收拢
      m.x += (400 - m.x) * 0.004; m.y += (260 - m.y) * 0.004;
      m.x = Math.max(50, Math.min(750, m.x)); m.y = Math.max(40, Math.min(480, m.y));
    });
  }
}

/* ===== 左岛列表 ===== */
function renderList() {
  fileList.replaceChildren(...memories.map((m) => {
    const row = node("div", "file-row glass-sub");
    row.dataset.id = m.id;
    const title = node("h3", "", m.title);
    if (m.links.length >= 3) title.append(node("span", "hub-badge", "枢纽"));
    row.append(title, node("p", "", m.sum), node("div", "meta", `${m.id} · ↔${m.links.length} · ${m.tags.join(" · ")}`));
    return row;
  }));
  $$("#fileList .file-row").forEach((r) => {
    const id = r.dataset.id;
    r.onmouseenter = () => { hoverId = id; applyState(); };
    r.onmouseleave = () => { hoverId = null; applyState(); };
    r.onclick = () => openFocus(id);
  });
  applyState();
}

/* ===== 右岛图谱 ===== */
const svg = $("#graph"), gview = $("#gview"), tip = $("#graphTip");
let nodeEls = {}, edgeEls = [], view = { x: 0, y: 0 };

const edgePairs = () => {
  const es = [];
  memories.forEach((m) => m.links.forEach((l) => { if (byId(l) && m.id < l) es.push([m.id, l]); }));
  return es;
};

function renderGraph() {
  gview.setAttribute("transform", ""); view = { x: 0, y: 0 };
  const es = edgePairs();
  const lines = es.map(([a, b]) => svgNode("line", {
    class: "edge", "data-a": a, "data-b": b,
    x1: byId(a).x, y1: byId(a).y, x2: byId(b).x, y2: byId(b).y,
  }));
  const nodes = memories.map((m) => {
    const hub = m.links.length >= 3;
    const g = svgNode("g", { class: "node", "data-id": m.id });
    if (hub) g.append(svgNode("circle", { class: "hub-halo", cx: m.x, cy: m.y, r: 15, fill: "#E26252" }));
    g.append(svgNode("circle", { class: hub ? "hubc" : "core", cx: m.x, cy: m.y, r: hub ? 9 : 5.5 }));
    return g;
  });
  gview.replaceChildren(...lines, ...nodes);
  nodeEls = {}; edgeEls = [...gview.querySelectorAll(".edge")];
  gview.querySelectorAll(".node").forEach((g) => {
    nodeEls[g.dataset.id] = g;
    g.addEventListener("mouseenter", () => { hoverId = g.dataset.id; showTip(g); applyState(); hlRow(g.dataset.id); });
    g.addEventListener("mousemove", () => showTip(g));
    g.addEventListener("mouseleave", () => { hoverId = null; tip.classList.remove("show"); applyState(); hlRow(null); });
    g.addEventListener("click", () => openFocus(g.dataset.id));
  });
  applyState();
}

function showTip(g) {
  const m = byId(g.dataset.id); if (!m) return;
  const c = g.querySelector("circle:last-child"), wr = $("#graphWrap").getBoundingClientRect(), cr = c.getBoundingClientRect();
  tip.querySelector("h4").textContent = m.title;
  tip.querySelector(".mono").textContent = `${m.id} · ↔${m.links.length}`;
  tip.style.left = (cr.left - wr.left + cr.width / 2) + "px";
  tip.style.top = (cr.top - wr.top - 10) + "px";
  tip.classList.add("show");
}

function hlRow(id) {
  $$("#fileList .file-row").forEach((r) => {
    r.classList.toggle("hl", r.dataset.id === id);
    if (r.dataset.id === id) r.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
}

const match = (m) => !query || [m.title, m.sum, m.tags.join(" "), m.id].join(" ").toLowerCase().includes(query);

function applyState() {
  memories.forEach((m) => {
    const g = nodeEls[m.id]; if (!g) return;
    let dimmed = query && !match(m);
    if (!dimmed && hoverId && m.id !== hoverId && !neighbors(hoverId).includes(m.id)) dimmed = true;
    g.classList.toggle("dim", dimmed);
    g.classList.toggle("lit", hoverId === m.id);
  });
  edgeEls.forEach((l) => {
    const touch = hoverId && (l.dataset.a === hoverId || l.dataset.b === hoverId);
    const okSearch = !query || (match(byId(l.dataset.a)) && match(byId(l.dataset.b)));
    l.classList.toggle("dim", !(okSearch && (!hoverId || touch)));
  });
  let n = 0;
  $$("#fileList .file-row").forEach((r) => { const show = !query || match(byId(r.dataset.id)); r.style.display = show ? "" : "none"; if (show) n++; });
  memCount.textContent = `${n} 条目`;
  memEmpty.hidden = !(query && n === 0);
  fileList.style.display = query && n === 0 ? "none" : "";
}
$("#memSearch").oninput = (e) => { query = e.target.value.trim().toLowerCase(); applyState(); };
$("#memReset").onclick = () => { $("#memSearch").value = ""; query = ""; serverSearch(); };

/* 搜索：输入过程本地预筛，Enter/按钮走后端 BM25（失败时退回本地过滤） */
async function serverSearch() {
  const q = $("#memSearch").value.trim();
  query = q.toLowerCase();
  if (!q) return reload();
  try {
    const { entries } = await api.memory(q);
    const saved = memories;
    memories = saved.filter((m) => keep2set(entries, m));
    layout(); renderGraph(); renderList();
    memories = saved; // 保留全量供聚焦层引用，仅可视过滤
  } catch { applyState(); }
}
const keep2set = (entries, m) => entries.some((e) => e.id === m.id);
$("#memSearchBtn").onclick = serverSearch;
$("#memSearch").addEventListener("keydown", (e) => { if (e.key === "Enter") serverSearch(); });

/* 节点拖拽 + 画布平移 */
let drag = null, pan = null;
svg.addEventListener("pointerdown", (e) => {
  const g = e.target.closest("g.node");
  svg.setPointerCapture(e.pointerId);
  if (g) { const m = byId(g.dataset.id); drag = { m, sx: e.clientX, sy: e.clientY, ox: m.x, oy: m.y }; }
  else { pan = { sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y }; svg.classList.add("panning"); }
});
svg.addEventListener("pointermove", (e) => {
  const k = 800 / svg.getBoundingClientRect().width;
  if (drag) {
    drag.m.x = drag.ox + (e.clientX - drag.sx) * k; drag.m.y = drag.oy + (e.clientY - drag.sy) * k;
    const g = nodeEls[drag.m.id];
    g.querySelectorAll("circle").forEach((c) => { c.setAttribute("cx", drag.m.x); c.setAttribute("cy", drag.m.y); });
    edgeEls.forEach((l) => {
      if (l.dataset.a === drag.m.id) { l.setAttribute("x1", drag.m.x); l.setAttribute("y1", drag.m.y); }
      if (l.dataset.b === drag.m.id) { l.setAttribute("x2", drag.m.x); l.setAttribute("y2", drag.m.y); }
    });
    if (tip.classList.contains("show")) showTip(g);
  } else if (pan) {
    view.x = pan.ox + (e.clientX - pan.sx); view.y = pan.oy + (e.clientY - pan.sy);
    gview.setAttribute("transform", `translate(${view.x},${view.y})`);
  }
});
svg.addEventListener("pointerup", () => { drag = null; pan = null; svg.classList.remove("panning"); });

/* 降级开关 */
const fbList = $("#fbList"), graphWrapEl = $("#graphWrap");
$("#fbToggle").onclick = () => {
  const on = $("#fbToggle").classList.toggle("on");
  $("#fbToggle").setAttribute("aria-checked", String(on));
  graphWrapEl.style.display = on ? "none" : "";
  fbList.hidden = !on;
  if (on) fbList.replaceChildren(...(memories.length ? memories.map((m) => {
    const row = node("div", "fb-row glass-sub", m.title + " ");
    row.append(node("span", "mono", `↔${m.links.length} · ${m.links.map((l) => l.split("-")[1]).join(" ") || "—"}`));
    return row;
  }) : [node("div", "empty-block", "没有记忆条目")]));
};

/* ===== 聚焦阅读层（导出给 chat.js 引用芯片用） ===== */
const focusOv = $("#focusOv");
let focusId = null, deleting = null, editing = null;
const yaml = (m) => `---\nid: ${m.id}\ntitle: ${m.title}\ntags: [${m.tags.join(", ")}]\nlinks: [${m.links.join(", ")}]\ncreated: ${m.created}\n---`;

export function openFocus(id) {
  const m = byId(id); if (!m) return;
  focusId = id;
  $("#fTitle").textContent = m.title; $("#fId").textContent = m.id;
  $("#fFm").textContent = yaml(m);
  $("#fBody").textContent = m.body;
  focusOv.classList.add("show");
}
const closeFocus = () => focusOv.classList.remove("show");
$("#fClose").onclick = closeFocus;
focusOv.addEventListener("click", (e) => { if (e.target === focusOv) closeFocus(); });

/* 编辑：弹层改标题/正文 → refine API（id 与创建时间不变） */
$("#fEdit").onclick = () => {
  const m = byId(focusId); if (!m) return;
  editing = m;
  $("#edTitle").value = m.title; $("#edBody").value = m.body;
  $("#editOv").classList.add("show");
};
$("#edSave").onclick = async () => {
  try {
    await api.refineMemory(editing.id, { title: $("#edTitle").value.trim() || editing.title, content: $("#edBody").value.trim(), expectedVersion: editing.version });
    $("#editOv").classList.remove("show"); closeFocus();
    await reload();
  } catch (e) { alert(`保存失败：${e.message}`); }
};

/* 删除：二次确认 → API → 双岛同步移除 */
$("#fDel").onclick = () => {
  const m = byId(focusId); if (!m) return;
  deleting = m;
  $("#delTxt").textContent = `「${m.title}」将从档案与图谱中移除（并清除其他条目的反向引用）。`;
  $("#delId").textContent = m.id;
  $("#delOv").classList.add("show");
};
$("#delOk").onclick = async () => {
  try {
    await api.deleteMemory(deleting.id);
    $("#delOv").classList.remove("show"); closeFocus();
    await reload();
  } catch (e) { alert(`删除失败：${e.message}`); }
};

/* ===== 数据加载 ===== */
export async function reload() {
  const { entries } = await api.memory();
  memories = entries.map(summarize);
  renderList(); layout(); renderGraph();
}
export async function initMemory() {
  try { await reload(); } catch (e) {
    const block = node("div", "empty-block");
    const retry = node("button", "btn-glass", "重试");
    retry.onclick = () => location.reload();
    block.append(node("p", "", `读取失败：${e.message}`), retry);
    fileList.replaceChildren(block);
  }
}
