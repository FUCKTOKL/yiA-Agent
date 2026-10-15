/** 原书阅读器：PDF.js 画原页；EPUB/文字书进入无脚本 iframe。索引片段只负责定位。 */
import { api } from "./api.js";
const PDF_ASSETS = "/api/books/assets/pdfjs/";
const normalize = text => String(text ?? "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
let pdfModule;
const pdfLibrary = () => pdfModule ??= import(PDF_ASSETS + "build/pdf.mjs").then(lib => { lib.GlobalWorkerOptions.workerSrc = PDF_ASSETS + "build/pdf.worker.mjs"; return lib; }).catch(error => { pdfModule = undefined; throw error; });
function findQuote(text, quote, offset) {
  if (!quote) return -1;
  if (offset !== undefined && text.slice(offset, offset + quote.length) === quote) return offset;
  const at = text.indexOf(quote);
  return at < 0 || text.indexOf(quote, at + 1) >= 0 ? -1 : at;
}
/** 页/章里的文字必须能唯一确认或符合已存偏移，重复段落不猜位置。 */
export function findBookTarget(text, quote, offset, query = "") {
  const head = normalize(quote).slice(0, 60), start = findQuote(text, head, offset);
  const word = normalize(query.trim().split(/\s+/)[0]);
  if (word) {
    const at = start >= 0 ? text.indexOf(word, start) : findQuote(text, word, offset);
    if (at >= 0 && (start < 0 || at < start + normalize(quote).length)) return { at, needle: word };
  }
  return { at: start, needle: head };
}
function highlightText(doc, quote, offset, query) {
  const walker = doc.createTreeWalker(doc.body, 4), nodes = [];
  let text = "", textNode;
  while ((textNode = walker.nextNode())) {
    if (textNode.parentElement?.closest("style,script,nav")) continue;
    const value = normalize(textNode.nodeValue); if (!value) continue;
    nodes.push({ node: textNode, start: text.length, end: text.length + value.length }); text += value;
  }
  const { at } = findBookTarget(text, quote, offset, query);
  if (at < 0) return false;
  const match = nodes.find(n => n.start <= at && n.end > at), element = match?.node.parentElement;
  if (!element) return false;
  const block = element.closest("p,h1,h2,h3,h4,li,pre,blockquote,td,.yia-line,[data-line-start]") ?? element;
  block.classList.add("yia-target"); block.scrollIntoView({ block: "center" }); return true;
}
export class BookReader {
  constructor(container, onChange) {
    this.container = container; this.onChange = onChange;
    this.version = 0; this.book = null; this.pdf = null; this.task = null; this.renderTask = null;
    this.textLayer = null; this.frame = null; this.frameCancel = null; this.units = []; this.unit = 1; this.total = 0; this.zoom = "fit"; this.target = null;
    let width = 0, timer;
    if (typeof ResizeObserver === "function") new ResizeObserver(() => {
      const next = this.container.clientWidth;
      if (next <= 0 || Math.abs(next - width) < 2) return;
      width = next; clearTimeout(timer);
      if (this.pdf && this.zoom === "fit") timer = setTimeout(() => { void this.go(this.unit, this.target).catch(e => this.report(e)); }, 100);
    }).observe(container);
  }
  report(error) { if (error?.name !== "RenderingCancelledException" && error?.name !== "AbortException") this.onChange({ error: error.message || "原书加载失败，请重试。" }); }
  close() {
    this.version++; this.renderTask?.cancel(); this.textLayer?.cancel(); this.frameCancel?.();
    void this.task?.destroy().catch(() => undefined);
    this.task = null; this.pdf = null; this.frame = null; this.frameCancel = null;
    this.renderTask = null; this.textLayer = null; this.book = null; this.target = null; this.units = []; this.total = 0;
    this.container.replaceChildren();
  }
  async open(book, passage, query = "") {
    const changed = this.book?.id !== book.id;
    if (changed) { this.close(); this.book = book; }
    const token = ++this.version;
    if (book.format === "pdf") {
      if (!this.pdf) {
        void this.task?.destroy().catch(() => undefined);
        const lib = await pdfLibrary(); if (token !== this.version) return;
        const task = lib.getDocument({ url: api.bookContent(book.id), cMapUrl: PDF_ASSETS + "cmaps/", cMapPacked: true, standardFontDataUrl: PDF_ASSETS + "standard_fonts/", wasmUrl: PDF_ASSETS + "wasm/", stopAtErrors: true, verbosity: 0 });
        this.task = task;
        const pdf = await task.promise; if (token !== this.version) { await task.destroy(); return; }
        this.pdf = pdf;
      }
      this.total = this.pdf.numPages;
    } else {
      if (changed || !this.units.length) { const info = await api.bookReaderInfo(book.id); if (token !== this.version) return; this.units = info.units; }
      this.total = this.units.length;
    }
    let anchor = passage.anchor ?? { kind: "unknown" };
    if (anchor.kind === "text" && query.trim()) {
      const raw = passage.text.normalize("NFKC").toLowerCase(), word = query.trim().split(/\s+/)[0].normalize("NFKC").toLowerCase(), at = raw.indexOf(word);
      if (at >= 0) {
        const prefix = raw.slice(0, at), line = anchor.line + prefix.split("\n").length - 1;
        anchor = { ...anchor, line, endLine: line, offset: anchor.offset === undefined ? undefined : anchor.offset + normalize(prefix).length };
      }
    }
    const target = { anchor, quote: passage.text, query };
    let unit = anchor.kind === "pdf" ? anchor.page : anchor.kind === "epub" ? anchor.section : 1;
    if (anchor.kind === "text") {
      const found = this.units.find(u => anchor.offset !== undefined && u.offset !== undefined ? anchor.offset >= u.offset && anchor.offset <= u.endOffset : anchor.line >= u.line && anchor.line <= u.endLine);
      if (found) unit = found.index;
    }
    if (!Number.isSafeInteger(unit) || unit < 1 || unit > this.total) throw new Error("索引位置超出了原书范围，没有跳到猜测位置。请下载原件核对。");
    await this.go(unit, target);
  }
  async go(unit, target = null, fragment = "") {
    if (!this.book || !Number.isSafeInteger(unit) || unit < 1 || unit > this.total) return;
    const token = ++this.version, book = this.book;
    this.renderTask?.cancel(); this.textLayer?.cancel(); this.frameCancel?.(); this.unit = unit; this.target = target;
    this.onChange({ loading: true });
    if (book.format === "pdf") {
      const pdf = this.pdf, page = await pdf.getPage(unit); if (token !== this.version) return;
      const lib = await pdfLibrary(); if (token !== this.version) return;
      const natural = page.getViewport({ scale: 1 }), fit = Math.max(0.2, (this.container.clientWidth - 24) / natural.width);
      const scale = this.zoom === "fit" ? fit : Number(this.zoom) * 96 / 72, viewport = page.getViewport({ scale });
      const paper = document.createElement("div"); paper.className = "book-pdf-page";
      paper.style.width = viewport.width + "px"; paper.style.height = viewport.height + "px";
      paper.style.setProperty("--total-scale-factor", String(scale * page.userUnit));
      const canvas = document.createElement("canvas"), text = document.createElement("div"); text.className = "textLayer";
      canvas.setAttribute("aria-label", `PDF 第 ${unit} 页原版页面`);
      const pixels = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(12_000_000 / (viewport.width * viewport.height)));
      canvas.width = Math.ceil(viewport.width * pixels); canvas.height = Math.ceil(viewport.height * pixels);
      canvas.style.width = viewport.width + "px"; canvas.style.height = viewport.height + "px";
      paper.append(canvas, text); this.container.replaceChildren(paper); this.container.scrollTop = 0;
      const renderTask = page.render({ canvas, viewport, transform: pixels === 1 ? null : [pixels, 0, 0, pixels, 0, 0], annotationMode: 0 });
      this.renderTask = renderTask; await renderTask.promise; if (token !== this.version) return;
      const layer = new lib.TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport });
      this.textLayer = layer; await layer.render(); if (token !== this.version) return;
      let highlighted = false;
      if (target) {
        const strings = layer.textContentItemsStr.map(normalize), full = strings.join("");
        const { at, needle } = findBookTarget(full, target.quote, target.anchor.offset, target.query);
        if (at >= 0) {
          let offset = 0, first;
          for (const [i, value] of strings.entries()) {
            if (offset + value.length > at && offset < at + needle.length) { layer.textDivs[i]?.classList.add("yia-pdf-hit"); first ??= layer.textDivs[i]; }
            offset += value.length;
          }
          if (first) { const r = first.getBoundingClientRect(), area = this.container.getBoundingClientRect(); this.container.scrollTop += r.top - area.top - area.height / 3; highlighted = true; }
        }
      }
      this.onChange({ unit, total: this.total, location: `PDF 第 ${unit} 页`, highlighted, target: Boolean(target), anchor: target?.anchor });
      return;
    }
    const frame = document.createElement("iframe"); frame.className = "book-original-frame"; frame.title = "原书排版阅读";
    frame.setAttribute("sandbox", "allow-same-origin"); frame.referrerPolicy = "no-referrer";
    this.frame = frame;
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = error => {
        if (settled) return; settled = true; clearTimeout(timer);
        if (this.frame === frame) this.frameCancel = null;
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => finish(new Error("原书页面加载超时，您可以重新打开或下载原件。")), 20000);
      this.frameCancel = () => finish();
      frame.onload = () => {
        if (token !== this.version) { finish(); return; }
        try {
          const doc = frame.contentDocument;
          if (doc?.URL === "about:blank") return;
          if (doc?.documentElement.dataset.yiaReader !== book.id || Number(doc.documentElement.dataset.yiaUnit) !== unit) { finish(new Error("原书页面未能加载，您可以查看检索文字或下载原件。")); return; }
          clearTimeout(timer); doc.body.style.zoom = this.zoom === "fit" ? "1" : String(this.zoom);
          let highlighted = false;
          if (fragment) { let id; try { id = decodeURIComponent(fragment); } catch { id = fragment; } doc.getElementById(id)?.scrollIntoView({ block: "start" }); }
          if (target?.anchor.kind === "text") {
            const info = this.units[unit - 1], line = target.anchor.line;
            const offset = target.anchor.offset !== undefined && info.offset !== undefined ? target.anchor.offset - info.offset : undefined;
            highlighted = highlightText(doc, target.quote, offset, target.query);
            if (!highlighted) {
              const blocks = [...doc.querySelectorAll("[data-line],[data-line-start]")];
              const block = blocks.find(e => e.dataset.line ? Number(e.dataset.line) === line : Number(e.dataset.lineStart) <= line && Number(e.dataset.lineEnd) >= line);
              if (block) { block.classList.add("yia-target"); block.scrollIntoView({ block: "center" }); highlighted = target.anchor.offset !== undefined; }
            }
          } else if (target) highlighted = highlightText(doc, target.quote, target.anchor.offset, target.query);
          doc.addEventListener("click", event => {
            const link = event.target.closest?.("a"); if (!link) return;
            event.preventDefault();
            const section = Number(link.dataset.yiaSection || 0), hash = link.getAttribute("href")?.slice(1) || "";
            if (section && section !== this.unit) void this.go(section, null, hash).catch(e => this.report(e));
            else if (hash) { let id; try { id = decodeURIComponent(hash); } catch { id = hash; } doc.getElementById(id)?.scrollIntoView({ block: "start" }); }
          });
          const info = this.units[unit - 1];
          this.onChange({ unit, total: this.total, location: book.format === "epub" ? `EPUB 第 ${unit} 节 · ${info.title}` : info.title, highlighted, target: Boolean(target), anchor: target?.anchor });
          finish();
        } catch (e) { finish(e); }
      };
      frame.onerror = () => finish(new Error("原书页面加载失败。"));
      frame.src = api.bookView(book.id, unit); this.container.replaceChildren(frame);
    });
  }
  async setZoom(value) {
    this.zoom = ["fit", "0.8", "1", "1.25", "1.5", "2"].includes(value) ? value : "fit";
    if (!this.book) return;
    if (this.pdf) await this.go(this.unit, this.target);
    else if (this.frame?.contentDocument?.body) this.frame.contentDocument.body.style.zoom = value === "fit" ? "1" : String(value);
  }
}
