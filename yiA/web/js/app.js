/** 全局壳：导航 / 状态浮层 / 主题切换 / 背景上传 / 弹层通用开闭 */
import { $, $$ } from "./api.js";
import { refreshStatus } from "./status.js";

export function initShell() {
  /* 导航切换 */
  $$(".nav-btn").forEach((b) => (b.onclick = () => {
    $$(".nav-btn").forEach((x) => x.classList.toggle("active", x === b));
    $$(".page").forEach((p) => p.classList.toggle("active", p.dataset.page === b.dataset.page));
  }));

  /* 系统状态浮层（打开时拉最新数据） */
  const statusPop = $("#statusPop");
  $("#statusBtn").onclick = (e) => { e.stopPropagation(); refreshStatus(); statusPop.classList.toggle("show"); };
  document.addEventListener("click", (e) => { if (!statusPop.contains(e.target)) statusPop.classList.remove("show"); });

  /* 主题切换（localStorage 记忆） */
  const applyTheme = (t) => {
    document.body.classList.toggle("light", t === "light");
    $("#iconMoon").style.display = t === "light" ? "none" : "";
    $("#iconSun").style.display = t === "light" ? "" : "none";
    localStorage.setItem("yia-theme", t);
  };
  $("#themeBtn").onclick = () => applyTheme(document.body.classList.contains("light") ? "dark" : "light");
  applyTheme(localStorage.getItem("yia-theme") || "dark");

  /* 背景上传：即选即用 + 服务端持久化（runtime/web/bg.img，刷新/换浏览器都继承；
     存文件而非 dataURL，不受 localStorage 5MB 限制）。双击背景按钮=恢复默认 */
  const bgInput = $("#bgInput");
  const setBg = (url) => { const env = $(".env"); env.classList.add("custom"); env.style.background = `url(${url}) center/cover no-repeat`; };
  $("#bgBtn").onclick = (e) => {
    if (e.detail === 2) { // 双击恢复默认并清存档
      const env = $(".env"); env.classList.remove("custom"); env.style.background = "";
      fetch("/api/bg", { method: "DELETE" }).catch(() => {});
      return;
    }
    bgInput.click();
  };
  bgInput.onchange = (e) => {
    const f = e.target.files[0]; if (!f) return;
    fetch("/api/bg", { method: "POST", headers: { "content-type": f.type }, body: f })
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); setBg("/api/bg?t=" + Date.now()); })
      .catch((err) => alert("背景保存失败：" + err.message));
    e.target.value = "";
  };
  // 启动恢复存档背景
  fetch("/api/bg").then((r) => { if (r.ok) setBg("/api/bg?t=" + Date.now()); }).catch(() => {});

  /* 弹层通用：[data-open] / [data-close] / 点遮罩 / Esc 最上层优先 */
  $$("[data-open]").forEach((b) => (b.onclick = () => $("#" + b.dataset.open).classList.add("show")));
  $$("[data-close]").forEach((b) => (b.onclick = () => $("#" + b.dataset.close).classList.remove("show")));
  $$(".overlay").forEach((ov) => ov.addEventListener("click", (e) => { if (e.target === ov) ov.classList.remove("show"); }));
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const open = $$(".overlay.show");
    if (open.length) open[open.length - 1].classList.remove("show");
    else statusPop.classList.remove("show");
  });
}

/* ===== 启动入口（原 main.js 并入，减一层转发；动态 import 避免环） ===== */
const { initChat } = await import("./chat.js");
const { initMemory } = await import("./memory.js");
const { initReminders } = await import("./reminders.js");
const { initWechat } = await import("./wechat.js");
initShell();
initChat();
initMemory();
initReminders();
initWechat();
refreshStatus();
