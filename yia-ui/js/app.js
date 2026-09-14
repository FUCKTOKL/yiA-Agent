/* 全局壳：导航 / 状态浮层 / 主题切换 / 背景上传 / 弹层通用关闭 */

/* 导航切换（乳白圆托底随 .active 过渡） */
$$('.nav-btn').forEach(b=>b.onclick=()=>{
  $$('.nav-btn').forEach(x=>x.classList.toggle('active',x===b));
  $$('.page').forEach(p=>p.classList.toggle('active',p.dataset.page===b.dataset.page));
});

/* 系统状态浮层 */
const statusPop=$('#statusPop');
$('#statusBtn').onclick=e=>{
  e.stopPropagation();
  $('#stMem').textContent=memories.length;
  $('#stRem').textContent=rems.filter(r=>!r.done).length;
  statusPop.classList.toggle('show');
};
document.addEventListener('click',e=>{if(!statusPop.contains(e.target))statusPop.classList.remove('show')});

/* 主题切换：暗（默认）/ 亮，记忆在 localStorage */
function applyTheme(t){
  document.body.classList.toggle('light',t==='light');
  $('#iconMoon').style.display=t==='light'?'none':'';
  $('#iconSun').style.display=t==='light'?'':'none';
  localStorage.setItem('yia-theme',t);
}
$('#themeBtn').onclick=()=>applyTheme(document.body.classList.contains('light')?'dark':'light');
applyTheme(localStorage.getItem('yia-theme')||'dark');

/* 背景上传：图片即选即用（ponytail: 不做持久化，dataURL 超 localStorage 配额，需要时换 IndexedDB） */
const bgInput=$('#bgInput');
$('#bgBtn').onclick=()=>bgInput.click();
bgInput.onchange=e=>{
  const f=e.target.files[0]; if(!f)return;
  const r=new FileReader();
  r.onload=()=>{
    const env=$('.env');
    env.classList.add('custom');
    env.style.background=`url(${r.result}) center/cover no-repeat`;
  };
  r.readAsDataURL(f);
};

/* 弹层通用打开：[data-open] → 对应 overlay */
$$('[data-open]').forEach(b=>b.onclick=()=>$('#'+b.dataset.open).classList.add('show'));

/* 弹层通用关闭：[data-close] 按钮 / 点遮罩空白 / Esc（最上层优先） */
$$('[data-close]').forEach(b=>b.onclick=()=>$('#'+b.dataset.close).classList.remove('show'));
$$('.overlay').forEach(ov=>ov.addEventListener('click',e=>{if(e.target===ov)ov.classList.remove('show')}));
document.addEventListener('keydown',e=>{
  if(e.key!=='Escape')return;
  const open=$$('.overlay.show');
  if(open.length)open[open.length-1].classList.remove('show');
  else statusPop.classList.remove('show');
});
