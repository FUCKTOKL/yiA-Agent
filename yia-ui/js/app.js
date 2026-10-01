/* 全局壳：路由 / 导航 / 主题 / 背景 / 状态浮层 / 弹层通用开关（ES 模块入口） */
import { $, $$ } from './lib/dom.js';
import { memories, rems } from './data.js';

/* ===== 路由：按需加载页面碎片 + 视图模块 ===== */
const PAGES = ['chat', 'memory', 'reminders', 'wechat'];
const stage = $('#stage');
const loaded = new Set();
let current = null;

async function show(name) {
  if (!PAGES.includes(name) || name === current) return;
  current = name;
  for (const b of $$('.nav-btn')) b.classList.toggle('active', b.dataset.page === name);
  if (!loaded.has(name)) {
    const html = await (await fetch(`pages/${name}.html`)).text();
    const frag = new DOMParser().parseFromString(html, 'text/html');  // 解析器文档中的脚本不执行，天然防注入
    for (const el of [...frag.body.children]) stage.appendChild(el);
    loaded.add(name);
    for (const p of $$('#stage .page')) p.classList.toggle('active', p.dataset.page === name);
    (await import(`./pages/${name}.js`)).mount();  // 挂载在 .active 之后，保证可测量
  } else {
    for (const p of $$('#stage .page')) p.classList.toggle('active', p.dataset.page === name);
  }
}

for (const b of $$('.nav-btn')) b.onclick = () => { location.hash = b.dataset.page; show(b.dataset.page); };
addEventListener('hashchange', () => show(location.hash.slice(1)));
show(location.hash.slice(1) || 'chat');

/* ===== 系统状态浮层 ===== */
const statusPop = $('#statusPop');
$('#statusBtn').onclick = e => {
  e.stopPropagation();
  $('#stMem').textContent = memories.length;
  $('#stRem').textContent = rems.filter(r => !r.done).length;
  statusPop.classList.toggle('show');
};
document.addEventListener('click', e => { if (!statusPop.contains(e.target)) statusPop.classList.remove('show') });

/* ===== 主题切换：暗 / 亮，记忆在 localStorage；首次访问跟随系统 prefers-color-scheme ===== */
function applyTheme(t) {
  document.body.classList.toggle('light', t === 'light');
  $('#iconMoon').style.display = t === 'light' ? 'none' : '';
  $('#iconSun').style.display = t === 'light' ? '' : 'none';
  localStorage.setItem('yia-theme', t);
}
$('#themeBtn').onclick = () => applyTheme(document.body.classList.contains('light') ? 'dark' : 'light');
applyTheme(localStorage.getItem('yia-theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));

/* ===== 轻提示：一次性确认浮条 ===== */
function toast(msg) {
  let t = $('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast glass-sub'; document.body.appendChild(t) }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2400);
}

/* ===== 背景上传：canvas 降采样到 1920 宽 JPEG 后存 localStorage，持久生效
   ponytail: 降采样+localStorage 够用；要存原图/多张轮换再上 IndexedDB ===== */
const BG_KEY = 'yia-bg';
function applyBg(url) {
  const env = $('.env');
  env.classList.add('custom');
  env.style.background = `url(${url}) center/cover no-repeat`;
}
const savedBg = localStorage.getItem(BG_KEY);
if (savedBg) applyBg(savedBg);
const bgInput = $('#bgInput');
$('#bgBtn').onclick = () => bgInput.click();
bgInput.onchange = e => {
  const f = e.target.files[0]; if (!f) return;
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(img.src);
    const k = Math.min(1, 1920 / img.width);   // 只缩不放，大图压到 1920 宽
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const url = c.toDataURL('image/jpeg', .82);
    applyBg(url);
    try { localStorage.setItem(BG_KEY, url); toast('背景已固定，下次自动恢复') }
    catch { toast('存储配额不足，背景仅本次生效') }
  };
  img.src = URL.createObjectURL(f);
};

/* ===== 弹层通用开关（事件委托：页面碎片后加载的弹层同样生效）
   [data-open] 打开 / [data-close] 关闭 / 点遮罩空白关闭 ===== */
document.addEventListener('click', e => {
  const opener = e.target.closest('[data-open]');
  if (opener) { $('#' + opener.dataset.open).classList.add('show'); return }
  const closer = e.target.closest('[data-close]');
  if (closer) { $('#' + closer.dataset.close).classList.remove('show'); return }
  if (e.target.classList && e.target.classList.contains('overlay')) e.target.classList.remove('show');
});

/* Esc：关最上层弹层，无弹层则收状态浮层 */
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const open = $$('.overlay.show');
  if (open.length) open[open.length - 1].classList.remove('show');
  else statusPop.classList.remove('show');
});
