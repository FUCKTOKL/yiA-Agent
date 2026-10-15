/** 弹窗共用键盘行为：打开后聚焦、Tab 不跳出窗口、关闭后回到入口。 */
const previousFocus = new WeakMap();
const focusable = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]';

export function openDialog(id) {
  const overlay = document.getElementById(id);
  previousFocus.set(overlay, document.activeElement);
  overlay.classList.add("show");
  overlay.querySelector(focusable)?.focus();
}

export function closeDialog(overlay) {
  overlay.classList.remove("show");
  previousFocus.get(overlay)?.focus();
  previousFocus.delete(overlay);
}

export function handleDialogKey(event, overlay) {
  if (event.key === "Escape") {
    event.preventDefault();
    closeDialog(overlay);
  }
  if (event.key !== "Tab") return;
  const items = [...overlay.querySelectorAll(focusable)].filter((el) => el.getClientRects().length);
  if (!items.length) { event.preventDefault(); return; }
  const first = items[0], last = items[items.length - 1];
  if (event.shiftKey && (document.activeElement === first || !overlay.contains(document.activeElement))) {
    event.preventDefault(); last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !overlay.contains(document.activeElement))) {
    event.preventDefault(); first.focus();
  }
}
