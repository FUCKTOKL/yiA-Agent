/* 微信页：发测试消息 / 换绑确认 */
function wxFeedback(text){
  const f=$('#wxFeedback');f.textContent=text;
  f.classList.add('show');clearTimeout(f._t);f._t=setTimeout(()=>f.classList.remove('show'),2600);
}
$('#testMsgBtn').onclick=()=>wxFeedback('已投递测试消息 → wxid_9f2k…m4z1（演示）');
$('#rebindOk').onclick=()=>{
  $('#rebindOv').classList.remove('show');
  wxFeedback('已登出全部账号，请重新扫码（演示）');
};
