/* 对话页视图：会话模型 / 历史岛 / 发送 / 引用浮卡 / pi Agent 命令（碎片挂载后执行一次） */
import { $, $$, esc, setHtml } from '../lib/dom.js';

const CHIP_SVG='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>';

/* 会话数据（原型静态；接 runtime/session 后由后端提供） */
const CONVS=[
 {name:'论文开题冲刺',msgs:[
   {who:'user',t:'14:18',text:'记住：周五要交开题报告初稿'},
   {who:'ai',t:'14:18',html:'已存好 ✅ 条目 <span class="hl">20260914135201-k7x9mf</span>，已自动关联「论文进度」2 条旧记忆'},
   {who:'user',t:'14:20',text:'开题的实验设计有依据吗？'},
   {who:'ai',t:'14:20',html:'有。实验设计的可行性论证引用了 GLM 上下文规格（200K tokens），并计划复用《卡片笔记写作法》的三条文献摘录组织综述。',
    chip:{id:'20260914043333-vnpddz',title:'论文进度 · 周报摘要',sum:'开题报告初稿计划周五前完成；研究背景已整理 70%，实验设计引用 GLM 上下文规格做可行性论证。'}},
 ]},
 {name:'咖啡与读书',msgs:[
   {who:'user',t:'09:12',text:'我之前说过什么关于咖啡的？'},
   {who:'ai',t:'09:12',html:'说过：燕麦拿铁、无糖、双份浓缩，豆子偏中深烘、带坚果调 <span class="hl">20260811093012-a3k2p9</span>'},
 ]},
 {name:'微信换绑复盘',msgs:[
   {who:'user',t:'前天',text:'把换绑事故记进复盘'},
   {who:'ai',t:'前天',html:'已存好 ✅ 条目 <span class="hl">20260905180233-wx9d4m</span>，改进项已关联「开源检查清单」'},
 ]},
];

/* pi Agent 命令 */
const PI_CMDS=[
  ['/pi chat','与 pi Agent 开启无头会话（SSE）'],
  ['/pi remember <内容>','把一句话存入记忆档案'],
  ['/pi recall <关键词>','BM25 检索记忆条目'],
  ['/pi remind <时间> <事项>','自然语言设置提醒并推送微信'],
  ['/pi graph','打开记忆图谱'],
  ['/pi wechat','查看微信通道状态'],
  ['/pi status','调度守护 · 网关 · 待发队列'],
];

let mounted=false;
export function mount(){
  if(mounted)return; mounted=true;
  const chatScroll=$('#chatScroll'),chatInput=$('#chatInput');
  let convs=CONVS.slice(),activeIdx=0;

  const msgHtml=m=>{
    if(m.who==='user')return `<div class="msg user"><div class="who">我 · ${m.t}</div><div class="bubble">${m.text}</div></div>`;
    const chip=m.chip?`<span class="chip" data-id="${m.chip.id}" data-title="${m.chip.title}" data-sum="${m.chip.sum}">${CHIP_SVG}来源 ${m.chip.id}</span>`:'';
    return `<div class="msg ai"><div class="who">yiA · ${m.t}</div><div class="body">${m.html}${chip}</div></div>`;
  };

  function renderHist(){
    setHtml($('#histList'),convs.map((c,i)=>`
      <div class="hist-item glass-sub ${i===activeIdx?'active':''}" data-i="${i}">
        <h4>${esc(c.name)}</h4>
        <div class="mono">${c.msgs.length} 条消息</div>
      </div>`).join(''));
    for(const el of $$('#histList .hist-item'))el.onclick=()=>{activeIdx=+el.dataset.i;renderConv();scrollChat()};
  }

  function renderConv(){
    const c=convs[activeIdx],has=c.msgs.length>0;
    $('#convName').textContent=c.name;
    chatScroll.style.display=has?'':'none';
    $('#chatEmpty').hidden=!has;
    setHtml($('#msgFlow'),c.msgs.map(msgHtml).join(''));
    renderHist();
  }

  function scrollChat(){chatScroll.scrollTop=chatScroll.scrollHeight}

  function sendChat(){
    const v=chatInput.value.trim(); if(!v)return;
    const c=convs[activeIdx],t=new Date().toTimeString().slice(0,5);
    c.msgs.push({who:'user',t,text:esc(v)});
    chatInput.value='';
    renderConv();scrollChat();
    setTimeout(()=>{
      const id=new Date().toISOString().slice(0,19).replace(/[-T:]/g,'')+'-'+Math.random().toString(36).slice(2,8);
      c.msgs.push({who:'ai',t:new Date().toTimeString().slice(0,5),
        html:`已存好 ✅ 条目 <span class="hl">${id}</span>，已自动关联「论文进度」2 条旧记忆`});
      renderConv();scrollChat();
    },500);
  }
  $('#sendBtn').onclick=sendChat;
  chatInput.addEventListener('keydown',e=>{if(e.key==='Enter')sendChat()});
  for(const b of $$('.quick'))b.onclick=()=>{chatInput.value=b.textContent;chatInput.focus()};
  $('#ctxBar').onclick=()=>$('#ctxBar').classList.toggle('open');

  /* New：新建会话（顶入历史并激活） */
  $('#newChatBtn').onclick=()=>{
    convs.unshift({name:'新的对话',msgs:[]});
    activeIdx=0;renderConv();chatInput.focus();
  };

  /* 引用浮卡（事件委托，随会话重渲染） */
  const citeCard=$('#citeCard');
  chatScroll.addEventListener('click',e=>{
    const c=e.target.closest('.chip'); if(!c)return;
    e.stopPropagation();
    $('#cTitle').textContent=c.dataset.title;$('#cId').textContent=c.dataset.id;$('#cSum').textContent=c.dataset.sum;
    const r=c.getBoundingClientRect();
    citeCard.style.left=Math.min(r.left,innerWidth-330)+'px';
    citeCard.style.top=Math.max(12,r.top-150)+'px';
    citeCard.classList.add('show');
  });
  document.addEventListener('click',e=>{if(!citeCard.contains(e.target))citeCard.classList.remove('show')});
  document.addEventListener('keydown',e=>{if(e.key==='Escape')citeCard.classList.remove('show')});

  setHtml($('#cmdsList'),PI_CMDS.map(([cmd,desc],i)=>`
    <div class="cmd-row" data-i="${i}">
      <span class="mono">${cmd}</span><span>${desc}</span>
    </div>`).join(''));
  for(const el of $$('#cmdsList .cmd-row'))el.onclick=()=>{
    chatInput.value=PI_CMDS[el.dataset.i][0];
    $('#cmdsOv').classList.remove('show');
    chatInput.focus();
  };
  $('#piCmdsBtn').onclick=()=>$('#cmdsOv').classList.add('show');

  renderConv();
}
