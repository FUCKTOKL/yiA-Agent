/** 提醒页：真实 jobs（pending + 近期已触发）/ 新建（datetime-local + 渠道）/ 取消 */
import { $, esc, api } from "./api.js";

const remList = $("#remList"), remEmpty = $("#remEmpty");
let ch = "wechat";

const fmt = (iso) => {
  const d = new Date(iso);
  const md = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const today = new Date(), tm = new Date(Date.now() + 864e5);
  const day = d.toDateString() === today.toDateString() ? "今天" : d.toDateString() === tm.toDateString() ? "明天" : md;
  return { day, hm };
};

async function reload() {
  const { pending, done } = await api.reminders();
  const rows = [
    ...pending.map((j) => ({ ...j, st: "pending", ...fmt(j.at) })),
    ...done.map((j) => ({ ...j, st: j.status, ...fmt(j.at) })),
  ];
  remEmpty.hidden = rows.length > 0;
  remList.innerHTML = rows.map((r) => `
    <div class="rem-row ${r.st !== "pending" ? "done" : ""}">
      <div class="when">${esc(r.day)}<b>${r.hm}</b>${r.repeatDays ? '<span class="rep">重复</span>' : ""}</div>
      <div class="txt">${esc(r.title)}</div>
      <span class="chan ${r.channel === "tui" ? "tui" : ""}">${r.channel === "tui" ? "TUI" : "微信"}</span>
      ${r.st === "pending"
        ? `<button class="op" data-id="${r.id}">取消</button>`
        : `<span class="op" style="cursor:default;text-decoration:none">${r.st === "done" ? "已触发" : "已取消"}</span>`}
    </div>`).join("");
  remList.querySelectorAll("button.op").forEach((b) => (b.onclick = async () => {
    try { await api.cancelReminder(b.dataset.id); await reload(); } catch (e) { alert(e.message); }
  }));
}

/* 新建弹层 */
const openNew = () => { $("#remOv").classList.add("show"); $("#nrTxt").focus(); };
$("#newRemBtn").onclick = openNew;
$("#remEmptyNew").onclick = openNew;
document.querySelectorAll(".seg-row .seg").forEach((s) => (s.onclick = () => {
  document.querySelectorAll(".seg-row .seg").forEach((x) => x.classList.toggle("sel", x === s));
  ch = s.dataset.ch;
}));

$("#nrSave").onclick = async () => {
  const title = $("#nrTxt").value.trim(), tv = $("#nrTime").value;
  if (!title || !tv) { alert("内容和时间都要填"); return; }
  const at = new Date(tv).toISOString();
  try {
    await api.addReminder({ title, at, channel: ch });
    $("#remOv").classList.remove("show"); $("#nrTxt").value = ""; $("#nrTime").value = "";
    await reload();
  } catch (e) { alert(`保存失败：${e.message}`); }
};

export async function initReminders() {
  try { await reload(); } catch (e) { remList.innerHTML = `<p class="mono" style="color:#E26252;padding:16px">${esc(e.message)}</p>`; }
}
