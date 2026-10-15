/** 书架与检索：索引用安全纯文字；原件阅读由独立 PDF/沙箱文档阅读器负责。 */
import { $, $$, api } from "./api.js";
import { openDialog, closeDialog } from "./dialogs.js";
import { BookReader } from "./book-reader.js";

let library = [], current = null, passage = 1, activeId = "", reader = null;
let readRequest = 0, listRequest = 0, searchRequest = 0, importing = false, deleting = false, pendingDelete = null;
const node = (tag, className, text) => { const el = document.createElement(tag); el.className = className; if (text !== undefined) el.textContent = text; return el; };
const countText = n => n >= 10000 ? `${(n / 10000).toFixed(1)} 万字符` : `${n.toLocaleString()} 字符`;
function feedback(text, error = false) {
  const el = $("#bookFeedback"); el.hidden = !text; el.textContent = text;
  el.classList.toggle("is-error", error); el.setAttribute("role", error ? "alert" : "status");
}
function expandReader(expanded) {
  $('.page[data-page="books"]').classList.toggle("book-reading-wide", expanded);
  $("#bookExpand").textContent = expanded ? "返回书架" : "展开阅读";
  $("#bookExpand").setAttribute("aria-expanded", String(expanded));
}
function readerChanged(state) {
  if (state.error) {
    $("#bookReadError").hidden = false; $("#bookReadError").textContent = state.error;
    $("#bookDocument").setAttribute("aria-busy", "false");
    $("#bookReaderStatus").textContent = "原件显示未完成，可查看检索文字或下载原文件。";
    return;
  }
  $("#bookDocument").setAttribute("aria-busy", String(Boolean(state.loading)));
  if (state.loading) {
    $("#bookReaderStatus").textContent = "正在显示原书页面…";
    $("#bookPrev").disabled = $("#bookNext").disabled = $("#bookPageNumber").disabled = true;
    return;
  }
  const name = current?.format === "pdf" ? "页" : current?.format === "epub" ? "节" : "屏";
  $("#bookLocation").textContent = state.location;
  $("#bookPosition").textContent = `/ ${state.total} ${name}`;
  $("#bookPageNumber").value = state.unit; $("#bookPageNumber").max = state.total; $("#bookPageNumber").disabled = false;
  $("#bookPrev").textContent = `上一${name}`; $("#bookNext").textContent = `下一${name}`;
  $("#bookPrev").disabled = state.unit <= 1; $("#bookNext").disabled = state.unit >= state.total;
  $("#bookContents").value = String(state.unit);
  $("#bookCitation").hidden = !state.target; $("#bookExtract").hidden = !state.target;
  if (!state.target) $("#bookExtract").open = false;
  $("#bookReaderStatus").textContent = !state.target ? "原书阅读 · 模型仍使用独立文字索引"
    : state.anchor?.kind === "unknown" ? "旧索引没有可靠定位信息，当前只显示原书起始处，请对照检索文字。"
    : state.highlighted ? "已定位原书，并标记对应文字。" : "已定位到原书位置，文字未能唯一匹配；可展开检索文字核对。";
}
function originalReader() {
  if (!reader) { reader = new BookReader($("#bookDocument"), readerChanged); reader.zoom = $("#bookZoom").value || "fit"; }
  return reader;
}
function markActive() {
  $$("#bookList .book-item").forEach(el => el.classList.toggle("is-selected", el.dataset.bookId === activeId && (!el.dataset.passage || Number(el.dataset.passage) === passage)));
}
function empty(text) { $("#bookEmpty").hidden = !text; $("#bookEmptyText").textContent = text; }
function showLibrary() {
  searchRequest++; $("#bookSearchBtn").disabled = false;
  $("#bookList").replaceChildren(...library.map(book => {
    const button = node("button", "book-row book-item"); button.type = "button"; button.dataset.bookId = book.id;
    const body = node("div", "book-row-body");
    body.append(node("h3", "", book.title), node("p", "", [book.author, countText(book.charCount), `${book.passageCount} 段`].filter(Boolean).join(" · ")));
    button.append(node("span", "book-format", book.format.toUpperCase()), body);
    button.onclick = () => { $("#bookScope").value = book.id; void openPassage(book.id, 1); };
    return button;
  }));
  $("#bookCount").textContent = `${library.length} 本书`;
  empty(library.length ? "" : "书架还是空的，导入您的第一本书"); markActive();
}
function excerpt(text, query) {
  const el = node("p", "book-excerpt");
  const words = query.split(/\s+/).filter(Boolean).sort((a, b) => b.length - a.length);
  if (!words.length) { el.textContent = text; return el; }
  const lower = text.toLowerCase();
  let offset = 0;
  while (offset < text.length) {
    let at = -1, word = "";
    for (const candidate of words) {
      const index = lower.indexOf(candidate.toLowerCase(), offset);
      if (index >= 0 && (at < 0 || index < at)) { at = index; word = candidate; }
    }
    if (at < 0) break;
    el.append(document.createTextNode(text.slice(offset, at)), node("mark", "", text.slice(at, at + word.length)));
    offset = at + word.length;
  }
  el.append(document.createTextNode(text.slice(offset)));
  return el;
}
async function search() {
  const token = ++searchRequest, query = $("#bookSearch").value.trim();
  if (!query) { showLibrary(); return; }
  $("#bookSearchBtn").disabled = true;
  try {
    const { hits } = await api.searchBooks(query, $("#bookScope").value);
    if (token !== searchRequest) return;
    $("#bookList").replaceChildren(...hits.map(hit => {
      const button = node("button", "book-hit book-item"); button.type = "button";
      button.dataset.bookId = hit.bookId; button.dataset.passage = hit.passage;
      button.append(node("h3", "", hit.title), node("p", "book-hit-meta", `${hit.location} · 片段 ${hit.passage}`), excerpt(hit.text, query));
      button.onclick = () => { void openPassage(hit.bookId, hit.passage, query); };
      return button;
    }));
    $("#bookCount").textContent = hits.length === 20 ? "显示前 20 段命中" : `${hits.length} 段命中`;
    empty(hits.length ? "" : "未找到原文，换个关键词或检索范围试试"); markActive();
  } catch (e) {
    if (token !== searchRequest) return;
    feedback(`检索失败：${e.message}`, true); $("#bookList").replaceChildren(); empty("检索未完成，请重试");
  } finally { if (token === searchRequest) $("#bookSearchBtn").disabled = false; }
}
async function refreshBooks() {
  const token = ++listRequest;
  try {
    const data = await api.books();
    if (token !== listRequest) return;
    library = data.books;
    const scope = $("#bookScope"), selected = scope.value;
    scope.replaceChildren(new Option("全部书籍", ""), ...library.map(b => new Option(b.title, b.id)));
    scope.value = library.some(b => b.id === selected) ? selected : "";
    if (activeId && !library.some(b => b.id === activeId)) clearReader();
    if ($("#bookSearch").value.trim()) await search(); else showLibrary();
  } catch (e) { if (token === listRequest) feedback(`书架读取失败：${e.message}。您可以点「刷新」重试。`, true); }
}
function clearReader() {
  readRequest++; reader?.close(); current = null; activeId = ""; expandReader(false);
  $("#bookExpand").hidden = true;
  $("#bookReadTitle").textContent = "原书阅读"; $("#bookReadMeta").textContent = "保留原书排版，检索结果直接定位";
  $("#bookReadContent").hidden = true; $("#bookReadError").hidden = true;
  $("#bookReadEmpty").hidden = false; $("#bookReadEmpty p").textContent = "选择一本书，从原文开始";
  $("#bookText").textContent = "";
}
async function openPassage(id, number, query = "") {
  const token = ++readRequest; current = null; activeId = id; passage = number; markActive();
  $("#bookReadContent").hidden = true; $("#bookReadError").hidden = true;
  $("#bookReadEmpty").hidden = false; $("#bookReadEmpty p").textContent = "正在读取原文…";
  try {
    const data = await api.bookPassage(id, number);
    if (token !== readRequest) return;
    current = data.book; passage = data.passage.passage;
    $("#bookReadTitle").textContent = current.title; $("#bookReadTitle").title = current.title;
    $("#bookReadMeta").textContent = [current.author, current.format.toUpperCase(), current.format === "pdf" ? `${current.sectionCount} 页` : "", countText(current.charCount)].filter(Boolean).join(" · ");
    $("#bookLocation").textContent = data.passage.location;
    $("#bookText").textContent = data.passage.text; $("#bookText").scrollTop = 0;
    $("#bookCitation").textContent = `${current.id}:${passage}`;
    $("#bookReaderStatus").textContent = "正在载入原件…";
    $("#bookExtract").open = false; $("#bookExtract").hidden = false;
    $("#bookPrev").disabled = $("#bookNext").disabled = $("#bookPageNumber").disabled = true;
    $("#bookContents").hidden = true;
    $("#bookWarning").textContent = current.warnings.join("；"); $("#bookWarning").hidden = !current.warnings.length;
    $("#bookOriginal").href = api.bookOriginal(current.id);
    $("#bookDelete").disabled = deleting; $("#bookExpand").hidden = false;
    $("#bookReadEmpty").hidden = true; $("#bookReadContent").hidden = false; markActive();
    if (window.innerWidth <= 760) expandReader(true);
    const view = originalReader(); await view.open(current, data.passage, query);
    if (token !== readRequest) return;
    $("#bookContents").replaceChildren(...view.units.map(u => new Option(u.title, String(u.index))));
    $("#bookContents").value = String(view.unit); $("#bookContents").hidden = !view.units.length || view.units.length > 1000;
  } catch (e) {
    if (token !== readRequest || e.name === "RenderingCancelledException" || e.name === "AbortException") return;
    $("#bookReadEmpty").hidden = true; readerChanged({ error: e.message });
  }
}
export async function openBookCitation(id, number) {
  $("#booksNav").click();
  await openPassage(id, number);
}
export function initBooks() {
  $("#booksNav").addEventListener("click", () => { void refreshBooks(); });
  $("#bookRefresh").onclick = () => { if (!importing) feedback(""); void refreshBooks(); };
  $("#importBookBtn").onclick = () => $("#bookFileInput").click();
  $("#bookFileInput").onchange = async event => {
    const file = event.target.files[0]; if (!file || importing) return;
    event.target.value = "";
    if (!/\.(pdf|epub|txt|md|markdown)$/i.test(file.name)) { feedback("请选择 PDF、EPUB、TXT 或 Markdown 文件。", true); return; }
    if (!file.size || file.size > 50 * 1024 * 1024) { feedback("文件为空或超过 50 MB，请检查后再导入。", true); return; }
    importing = true; $("#importBookBtn").disabled = true; $("#bookFileInput").disabled = true;
    feedback("正在本机解析并建立索引，较大的书可能需要一两分钟…");
    try {
      const data = await api.importBook(file);
      $("#bookSearch").value = "";
      await refreshBooks(); $("#bookScope").value = data.book.id;
      await openPassage(data.book.id, 1);
      feedback(data.duplicate ? "这本书已在书架中，无需重复导入。" : `已导入，共 ${data.book.passageCount} 段可检索原文。${data.book.warnings.length ? "部分页面或章节有提取提示，可展开检索文字查看。" : ""}`);
    } catch (e) { feedback(`导入失败：${e.message}`, true); }
    finally { importing = false; $("#importBookBtn").disabled = false; $("#bookFileInput").disabled = false; }
  };
  $("#bookSearchForm").onsubmit = event => { event.preventDefault(); void search(); };
  $("#bookScope").onchange = () => { if ($("#bookSearch").value.trim()) void search(); };
  $("#bookReset").onclick = () => { searchRequest++; $("#bookSearchBtn").disabled = false; $("#bookSearch").value = ""; $("#bookScope").value = ""; if (!importing) feedback(""); showLibrary(); };
  $("#bookPrev").onclick = () => { if (reader) void reader.go(reader.unit - 1).catch(e => reader.report(e)); };
  $("#bookNext").onclick = () => { if (reader) void reader.go(reader.unit + 1).catch(e => reader.report(e)); };
  $("#bookJumpForm").onsubmit = event => { event.preventDefault(); if (reader) void reader.go(Number($("#bookPageNumber").value)).catch(e => reader.report(e)); };
  $("#bookContents").onchange = () => { if (reader) void reader.go(Number($("#bookContents").value)).catch(e => reader.report(e)); };
  $("#bookExpand").onclick = () => expandReader($("#bookExpand").getAttribute("aria-expanded") !== "true");
  const savedZoom = localStorage.getItem("yia-book-zoom");
  if (["fit", "0.8", "1", "1.25", "1.5", "2"].includes(savedZoom)) $("#bookZoom").value = savedZoom;
  $("#bookZoom").onchange = () => { const value = $("#bookZoom").value; localStorage.setItem("yia-book-zoom", value); if (reader) void reader.setZoom(value).catch(e => reader.report(e)); };
  $("#bookDelete").onclick = () => {
    if (!current || deleting) return;
    pendingDelete = current; $("#bookDeleteName").textContent = current.title; $("#bookDeleteError").hidden = true;
    openDialog("bookDeleteOv");
  };
  $("#bookDeleteConfirm").onclick = async () => {
    if (!pendingDelete || deleting) return;
    const target = pendingDelete;
    deleting = true; $("#bookDeleteConfirm").disabled = true; $("#bookDelete").disabled = true;
    try {
      await api.deleteBook(target.id); closeDialog($("#bookDeleteOv"));
      if (activeId === target.id) { clearReader(); $("#importBookBtn").focus(); }
      await refreshBooks(); feedback("已删除 yiA 中的副本和索引，原文件未改动。");
    } catch (e) { $("#bookDeleteError").hidden = false; $("#bookDeleteError").textContent = `删除失败：${e.message}`; }
    finally { deleting = false; $("#bookDeleteConfirm").disabled = false; $("#bookDelete").disabled = false; }
  };
  void refreshBooks();
}
