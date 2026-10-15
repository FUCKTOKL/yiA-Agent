/** 书架：原文永远用 textContent 呈现；不渲染上传文件里的 HTML/脚本。 */
import { $, $$, api } from "./api.js";
import { openDialog, closeDialog } from "./dialogs.js";

let library = [], current = null, passage = 1, activeId = "";
let readRequest = 0, listRequest = 0, searchRequest = 0, importing = false, deleting = false, pendingDelete = null;
const node = (tag, className, text) => { const el = document.createElement(tag); el.className = className; if (text !== undefined) el.textContent = text; return el; };
const countText = n => n >= 10000 ? `${(n / 10000).toFixed(1)} 万字符` : `${n.toLocaleString()} 字符`;
function feedback(text, error = false) {
  const el = $("#bookFeedback"); el.hidden = !text; el.textContent = text;
  el.classList.toggle("is-error", error); el.setAttribute("role", error ? "alert" : "status");
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
      button.onclick = () => { void openPassage(hit.bookId, hit.passage); };
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
  readRequest++; current = null; activeId = "";
  $("#bookReadTitle").textContent = "原文"; $("#bookReadMeta").textContent = "从书架或检索结果中打开一段文字";
  $("#bookReadContent").hidden = true; $("#bookReadError").hidden = true;
  $("#bookReadEmpty").hidden = false; $("#bookReadEmpty p").textContent = "选择一本书，从原文开始";
  $("#bookText").textContent = "";
}
async function openPassage(id, number) {
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
    $("#bookPosition").textContent = `${passage} / ${current.passageCount}`;
    $("#bookWarning").textContent = current.warnings.join("；"); $("#bookWarning").hidden = !current.warnings.length;
    $("#bookOriginal").href = api.bookOriginal(current.id);
    $("#bookPrev").disabled = passage <= 1; $("#bookNext").disabled = passage >= current.passageCount;
    $("#bookDelete").disabled = deleting;
    $("#bookReadEmpty").hidden = true; $("#bookReadContent").hidden = false; markActive();
    if (window.innerWidth <= 760) $(".book-reader").scrollIntoView({ block: "start" });
  } catch (e) {
    if (token !== readRequest) return;
    $("#bookReadTitle").textContent = "原文"; $("#bookReadMeta").textContent = "读取失败，请重新打开书籍或检索结果";
    $("#bookReadEmpty").hidden = true; $("#bookReadError").hidden = false; $("#bookReadError").textContent = e.message;
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
      feedback(data.duplicate ? "这本书已在书架中，无需重复导入。" : `已导入，共 ${data.book.passageCount} 段可检索原文。${data.book.warnings.length ? "部分页面或章节的文字提取有提示，请查看原文区。" : ""}`);
    } catch (e) { feedback(`导入失败：${e.message}`, true); }
    finally { importing = false; $("#importBookBtn").disabled = false; $("#bookFileInput").disabled = false; }
  };
  $("#bookSearchForm").onsubmit = event => { event.preventDefault(); void search(); };
  $("#bookScope").onchange = () => { if ($("#bookSearch").value.trim()) void search(); };
  $("#bookReset").onclick = () => { searchRequest++; $("#bookSearchBtn").disabled = false; $("#bookSearch").value = ""; $("#bookScope").value = ""; if (!importing) feedback(""); showLibrary(); };
  $("#bookPrev").onclick = () => { if (current && passage > 1) void openPassage(current.id, passage - 1); };
  $("#bookNext").onclick = () => { if (current && passage < current.passageCount) void openPassage(current.id, passage + 1); };
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
