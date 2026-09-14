/* 记忆图谱页：档案列表 + SVG 图谱 + 双向联动 + 搜索过滤 + 聚焦阅读层 + 降级开关 */
const byId=id=>memories.find(m=>m.id===id);
const neighbors=id=>byId(id)?byId(id).links:[];
const fileList=$('#fileList'),memCount=$('#memCount'),memEmpty=$('#memEmpty');
let query='',hoverId=null;

/* ===== 左岛列表 ===== */
function renderList(){
  fileList.innerHTML=memories.map(m=>`
    <div class="file-row glass-sub" data-id="${m.id}">
      <h3>${m.title}${m.links.length>=3?'<span class="hub-badge">枢纽</span>':''}</h3>
      <p>${m.sum}</p>
      <div class="meta">${m.id} · ↔${m.links.length} · ${m.tags.join(' · ')}</div>
    </div>`).join('');
  $$('#fileList .file-row').forEach(r=>{
    const id=r.dataset.id;
    r.onmouseenter=()=>{hoverId=id;applyState()};
    r.onmouseleave=()=>{hoverId=null;applyState()};
    r.onclick=()=>openFocus(byId(id));
  });
  applyState();
}

/* ===== 右岛图谱 ===== */
const svg=$('#graph'),gview=$('#gview'),tip=$('#graphTip');
let nodeEls={},edgeEls=[],view={x:0,y:0};

const edgePairs=()=>{
  const es=[];
  memories.forEach((m,i)=>m.links.forEach(l=>{
    const j=memories.findIndex(x=>x.id===l);
    if(j>i)es.push([m.id,l]);
  }));
  return es;
};

function renderGraph(){
  gview.setAttribute('transform','');
  view={x:0,y:0};
  const es=edgePairs();
  let h=es.map(([a,b])=>`<line class="edge" data-a="${a}" data-b="${b}" x1="${byId(a).x}" y1="${byId(a).y}" x2="${byId(b).x}" y2="${byId(b).y}"/>`).join('');
  h+=memories.map(m=>{
    const hub=m.links.length>=3;
    return `<g class="node" data-id="${m.id}">${hub?`<circle class="hub-halo" cx="${m.x}" cy="${m.y}" r="15" fill="#E26252"/>`:''}
      <circle class="${hub?'hubc':'core'}" cx="${m.x}" cy="${m.y}" r="${hub?9:5.5}"/></g>`;
  }).join('');
  gview.innerHTML=h;
  nodeEls={};edgeEls=[...gview.querySelectorAll('.edge')];
  gview.querySelectorAll('.node').forEach(g=>{
    nodeEls[g.dataset.id]=g;
    g.addEventListener('mouseenter',()=>{hoverId=g.dataset.id;showTip(g);applyState();hlRow(g.dataset.id)});
    g.addEventListener('mousemove',()=>showTip(g));
    g.addEventListener('mouseleave',()=>{hoverId=null;tip.classList.remove('show');applyState();hlRow(null)});
  });
  applyState();
}

function showTip(g){
  const m=byId(g.dataset.id); if(!m)return;
  const c=g.querySelector('circle:last-child'),wr=$('#graphWrap').getBoundingClientRect(),cr=c.getBoundingClientRect();
  tip.querySelector('h4').textContent=m.title;
  tip.querySelector('.mono').textContent=`${m.id} · ↔${m.links.length}`;
  tip.style.left=(cr.left-wr.left+cr.width/2)+'px';
  tip.style.top=(cr.top-wr.top-10)+'px';
  tip.classList.add('show');
}

function hlRow(id){
  $$('#fileList .file-row').forEach(r=>{
    r.classList.toggle('hl',r.dataset.id===id);
    if(r.dataset.id===id)r.scrollIntoView({block:'nearest',behavior:'smooth'});
  });
}

/* 搜索 + hover 的统一视觉状态 */
const match=m=>!query||[m.title,m.sum,m.tags.join(' '),m.id].join(' ').toLowerCase().includes(query);

function applyState(){
  memories.forEach(m=>{
    const g=nodeEls[m.id]; if(!g)return;
    let dimmed=query&&!match(m);
    if(!dimmed&&hoverId&&m.id!==hoverId&&!neighbors(hoverId).includes(m.id))dimmed=true;
    g.classList.toggle('dim',dimmed);
    g.classList.toggle('lit',hoverId===m.id);
  });
  edgeEls.forEach(l=>{
    const touch=hoverId&&(l.dataset.a===hoverId||l.dataset.b===hoverId);
    const okSearch=!query||(match(byId(l.dataset.a))&&match(byId(l.dataset.b)));
    l.classList.toggle('dim',!(okSearch&&(!hoverId||touch)));
  });
  let n=0;
  $$('#fileList .file-row').forEach(r=>{const show=!query||match(byId(r.dataset.id));r.style.display=show?'':'none';if(show)n++});
  memCount.textContent=`${n} 条目`;
  memEmpty.hidden=!(query&&n===0);
  fileList.style.display=(query&&n===0)?'none':'';
}
$('#memSearch').oninput=e=>{query=e.target.value.trim().toLowerCase();applyState()};
$('#memSearchBtn').onclick=()=>{query=$('#memSearch').value.trim().toLowerCase();applyState()};
$('#memSearch').addEventListener('keydown',e=>{if(e.key==='Enter')$('#memSearchBtn').click()});
$('#memReset').onclick=()=>{$('#memSearch').value='';query='';applyState()};

/* 节点拖拽 + 画布平移 */
let drag=null,pan=null;
svg.addEventListener('pointerdown',e=>{
  const g=e.target.closest('g.node');
  svg.setPointerCapture(e.pointerId);
  if(g){const m=byId(g.dataset.id);drag={m,sx:e.clientX,sy:e.clientY,ox:m.x,oy:m.y};}
  else{pan={sx:e.clientX,sy:e.clientY,ox:view.x,oy:view.y};svg.classList.add('panning');}
});
svg.addEventListener('pointermove',e=>{
  const k=800/svg.getBoundingClientRect().width;
  if(drag){
    drag.m.x=drag.ox+(e.clientX-drag.sx)*k; drag.m.y=drag.oy+(e.clientY-drag.sy)*k;
    const g=nodeEls[drag.m.id];
    g.querySelectorAll('circle').forEach(c=>{c.setAttribute('cx',drag.m.x);c.setAttribute('cy',drag.m.y)});
    edgeEls.forEach(l=>{
      if(l.dataset.a===drag.m.id){l.setAttribute('x1',drag.m.x);l.setAttribute('y1',drag.m.y)}
      if(l.dataset.b===drag.m.id){l.setAttribute('x2',drag.m.x);l.setAttribute('y2',drag.m.y)}
    });
    if(tip.classList.contains('show'))showTip(g);
  }else if(pan){
    view.x=pan.ox+(e.clientX-pan.sx);view.y=pan.oy+(e.clientY-pan.sy);
    gview.setAttribute('transform',`translate(${view.x},${view.y})`);
  }
});
svg.addEventListener('pointerup',()=>{drag=null;pan=null;svg.classList.remove('panning')});

/* 降级开关：图谱不可用时显示关联列表 */
const fbToggle=$('#fbToggle'),fbList=$('#fbList'),graphWrap=$('#graphWrap');
fbToggle.onclick=()=>{
  const on=fbToggle.classList.toggle('on');
  graphWrap.style.display=on?'none':'';
  fbList.hidden=!on;
  if(on)renderFb();
};
function renderFb(){
  fbList.innerHTML=memories.map(m=>`
    <div class="fb-row glass-sub">${m.title}
      <span class="mono">↔${m.links.length} · ${m.links.map(l=>l.split('-')[1]).join(' ')||'—'}</span>
    </div>`).join('')||'<div class="empty-block"><p>没有记忆条目</p></div>';
}

/* ===== 聚焦阅读层 ===== */
const focusOv=$('#focusOv');let focusItem=null,deleting=null;
const yaml=m=>`---\nid: ${m.id}\ntitle: ${m.title}\ntags: [${m.tags.join(', ')}]\nlinks: [${m.links.join(', ')}]\ncreated: ${m.created}\n---`;

function openFocus(m){
  focusItem=m;
  $('#fTitle').textContent=m.title;$('#fId').textContent=m.id;
  $('#fFm').textContent=yaml(m);
  const b=$('#fBody');b.textContent=m.body;b.contentEditable=false;
  $('#fEdit').textContent='编辑';
  focusOv.classList.add('show');
}
function closeFocus(){focusOv.classList.remove('show')}
$('#fClose').onclick=closeFocus;
focusOv.addEventListener('click',e=>{if(e.target===focusOv)closeFocus()});
$('#fEdit').onclick=()=>{
  const b=$('#fBody'),on=b.contentEditable!=='true';
  b.contentEditable=on;$('#fEdit').textContent=on?'完成':'编辑';
  if(on)b.focus();
};
$('#fDel').onclick=()=>{
  deleting=focusItem;
  $('#delTxt').textContent=`「${focusItem.title}」将从档案与图谱中移除。`;
  $('#delId').textContent=focusItem.id;
  $('#delOv').classList.add('show');
};
$('#delOk').onclick=()=>{
  memories=memories.filter(m=>m.id!==deleting.id);
  renderList();renderGraph();
  $('#delOv').classList.remove('show');closeFocus();
};

renderList();renderGraph();
