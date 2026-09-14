/* 提醒页：日程簿列表 / 行内完成取消 / 新建弹层 */
// ponytail: NL 时间解析原型期不做，新建项时间原样展示；接 runtime/jobs.json 后由后端解析
let rems=REMS.slice();

const remList=$('#remList'),remEmpty=$('#remEmpty');
function renderRems(){
  remList.innerHTML=rems.map((r,i)=>`
    <div class="rem-row ${r.done?'done':''}">
      <div class="rem-time"><b>${r.d}</b><span>${r.t}</span>${r.rep?'<span class="rep">重复</span>':''}</div>
      <div class="rem-txt">${r.txt}</div>
      <span class="badge ${r.ch}">${r.ch==='wechat'?'微信':'TUI'}</span>
      <div class="rem-ops">${r.done
        ?`<button class="link-btn danger" data-rm="${i}">删除</button>`
        :`<button class="link-btn" data-ok="${i}">完成</button><button class="link-btn" data-rm="${i}">取消</button>`}</div>
    </div>`).join('');
  remList.querySelectorAll('[data-ok]').forEach(b=>b.onclick=()=>{rems[b.dataset.ok].done=true;renderRems()});
  remList.querySelectorAll('[data-rm]').forEach(b=>b.onclick=()=>{rems.splice(+b.dataset.rm,1);renderRems()});
  remEmpty.hidden=rems.length>0;
  remList.style.display=rems.length?'':'none';
}

const remOv=$('#remOv');
$('#newRemBtn').onclick=$('#remEmptyNew').onclick=()=>{remOv.classList.add('show');setTimeout(()=>$('#nrTxt').focus(),50)};
$$('.seg').forEach(s=>s.onclick=()=>$$('.seg').forEach(x=>x.classList.toggle('sel',x===s)));
$('#nrSave').onclick=()=>{
  const txt=$('#nrTxt').value.trim(),tm=$('#nrTime').value.trim();
  if(!txt||!tm)return;
  rems.push({d:'待解析',t:tm,txt,ch:$('.seg.sel').dataset.ch});
  $('#nrTxt').value=$('#nrTime').value='';
  remOv.classList.remove('show');renderRems();
};
$('#nrTime').addEventListener('keydown',e=>{if(e.key==='Enter')$('#nrSave').click()});

renderRems();
