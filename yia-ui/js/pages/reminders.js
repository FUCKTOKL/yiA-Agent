/* 提醒页视图：日程簿列表 / 行内完成取消 / 新建弹层（碎片挂载后执行一次） */
// ponytail: NL 时间解析原型期不做，新建项时间原样展示；接 runtime/jobs.json 后由后端解析
import { $, $$, setHtml } from '../lib/dom.js';
import { rems } from '../data.js';

let mounted=false;
export function mount(){
  if(mounted)return; mounted=true;
  const remList=$('#remList'),remEmpty=$('#remEmpty');

  function renderRems(){
    setHtml(remList,rems.map((r,i)=>`
      <div class="rem-row ${r.done?'done':''}">
        <div class="rem-time"><b>${r.d}</b><span>${r.t}</span>${r.rep?'<span class="rep">重复</span>':''}</div>
        <div class="rem-txt">${r.txt}</div>
        <span class="badge ${r.ch}">${r.ch==='wechat'?'微信':'TUI'}</span>
        <div class="rem-ops">${r.done
          ?`<button class="link-btn danger" data-rm="${i}">删除</button>`
          :`<button class="link-btn" data-ok="${i}">完成</button><button class="link-btn" data-rm="${i}">取消</button>`}</div>
      </div>`).join(''));
    for(const b of remList.querySelectorAll('[data-ok]'))b.onclick=()=>{rems[b.dataset.ok].done=true;renderRems()};
    for(const b of remList.querySelectorAll('[data-rm]'))b.onclick=()=>{rems.splice(+b.dataset.rm,1);renderRems()};
    remEmpty.hidden=rems.length>0;
    remList.style.display=rems.length?'':'none';
  }

  const remOv=$('#remOv');
  $('#newRemBtn').onclick=$('#remEmptyNew').onclick=()=>{remOv.classList.add('show');setTimeout(()=>$('#nrTxt').focus(),50)};
  for(const s of $$('.seg'))s.onclick=()=>{for(const x of $$('.seg')){const sel=x===s;x.classList.toggle('sel',sel);x.setAttribute('aria-pressed',sel)}};
  $('#nrSave').onclick=()=>{
    const txt=$('#nrTxt').value.trim(),tm=$('#nrTime').value.trim();
    if(!txt||!tm)return;
    rems.push({d:'待解析',t:tm,txt,ch:$('.seg.sel').dataset.ch});
    $('#nrTxt').value=$('#nrTime').value='';
    remOv.classList.remove('show');renderRems();
  };
  $('#nrTime').addEventListener('keydown',e=>{if(e.key==='Enter')$('#nrSave').click()});

  renderRems();
}
