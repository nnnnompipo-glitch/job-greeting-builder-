const el = Object.fromEntries(['status','settings-form','fields','test-model','profile','profile-note','save','reload','retry-load','tone','tone-help','documents','import-files','import-status','import-review','import-preview','import-warnings','append-import'].map(id => [id,document.getElementById(id)]));
const toneHelp={professional:'正式、客观、以经历和能力为主，不用感叹号或比喻。',friendly:'自然口语，表达友好与沟通意愿，不做夸张修辞。',bold:'用有张力的表达突出热情和行动意愿；能力、经历和指标不能夸大。',creative:'允许一句贴合行业的巧思或比喻，随后回到具体项目和事实。'};
function updateTone(){el['tone-help'].textContent=toneHelp[el.tone.value] || toneHelp.professional;}
let loaded = false, initialProfile = '', savedModel = null;

function status(message,kind = '') { el.status.textContent = message; el.status.dataset.kind = kind; }
async function ask(action,values = {}) {
  const reply = await chrome.runtime.sendMessage({action,...values});
  if (!reply?.ok) throw new Error(reply?.error || '扩展后台没有响应，请重新加载扩展。');
  return reply.data;
}
function modelPayload() {
  return {provider:'codex',timeoutMs:savedModel?.timeoutMs || 120000};
}
function profileText() {
  const value = el.profile.value;
  const strip = text => text.replace(/^\uFEFF?\s*<!-- PROFILE_NOT_CONFIGURED -->\s*\r?\n?/,'');
  return strip(value).replace(/\s/g,'') !== strip(initialProfile).replace(/\s/g,'') ? strip(value) : value;
}
function apply(data) {
  savedModel = data.model || {provider:'codex'};
  el.tone.value=toneHelp[data.preferences?.tone] ? data.preferences.tone : 'professional';
  updateTone();
  initialProfile = data.profile || '';
  el.profile.value = initialProfile;
  el['profile-note'].textContent = data.profileReady ? '已有个人资料。请只保留真实、有证据支撑的经历。' : '个人资料尚未完成。请将示例内容替换为你的真实经历；编辑后保存会移除模板占位标记。';
}
async function load() {
  loaded = false;
  el.fields.disabled = true;
  status('正在读取本地设置…');
  try {
    apply(await ask('getModelSettings'));
    loaded = true;
    el.fields.disabled = false;
    el['retry-load'].hidden = true;
    status('已读取本地设置。可检查 Codex 登录，核对个人资料后保存。');
  } catch (error) {
    status(error.message + '\n请先在浏览器工具栏的助手弹窗中填写配对码；本地助手也需要保持运行。','error');
    el['retry-load'].hidden = false;
  }
}
el.tone.addEventListener('change',updateTone);
el['settings-form'].addEventListener('submit',async event => {
  event.preventDefault();
  if (!loaded) return;
  el.fields.disabled = true;
  status('正在保存设置…');
  try {
    const data = await ask('saveModelSettings',{model:modelPayload(),profile:profileText(),preferences:{tone:el.tone.value}});
    apply(data);
    status(data.profileReady ? '已保存并应用。返回岗位页，点击“重新检测”即可使用 Codex 生成草稿。' : '设置已保存。个人资料仍未完成，请补充真实经历后再生成。');
  } catch (error) { status(error.message,'error'); }
  finally { el.fields.disabled = false; }
});
el['test-model'].addEventListener('click',async () => {
  if (!loaded) return;
  el.fields.disabled = true;
  status('正在检查本机 Codex 安装和登录状态…');
  try {
    const result = await ask('testModelSettings',{model:modelPayload()});
    status(result.message || (result.ok ? 'Codex 登录可用。' : '请先安装并登录 Codex。'),result.ok ? '' : 'error');
  } catch (error) { status(error.message,'error'); }
  finally { el.fields.disabled = false; }
});
el.reload.addEventListener('click',load);
el['retry-load'].addEventListener('click',load);

function readFileBase64(file){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onerror=()=>reject(new Error('无法读取所选文件，请重新选择。'));
    reader.onload=()=>resolve(String(reader.result).split(',')[1] || '');
    reader.readAsDataURL(file);
  });
}
let importing=false;
el['import-files'].addEventListener('click',async()=>{
  if(!loaded || importing)return;
  const files=Array.from(el.documents.files || []);
  if(!files.length){el['import-status'].textContent='请先选择简历、作品集或图片文件。';return;}
  if(files.length>5){el['import-status'].textContent='每次最多识别5个文件，请分批导入。';return;}
  if(files.some(file=>file.size>25*1024*1024 || !/\.(pdf|png|jpe?g|bmp|txt|md)$/i.test(file.name))){
    el['import-status'].textContent='请使用支持的文件格式，每个文件不能超过25 MB。';return;
  }
  importing=true;el['import-files'].disabled=true;el.documents.disabled=true;
  el['import-review'].hidden=true;el['import-preview'].value='';
  const parts=[],warnings=[];
  try{
    for(let index=0;index<files.length;index++){
      const file=files[index];const name=file.name.replace(/[\r\n]/g,' ');
      try{
        el['import-status'].textContent=`正在读取 ${index+1}/${files.length}：${name}`;
        const payload={filename:file.name,type:file.type,base64:await readFileBase64(file)};
        let task=await ask('importDocument',payload);payload.base64='';
        const deadline=Date.now()+360000;
        while(!['done','error'].includes(task.status) && Date.now()<deadline){
          el['import-status'].textContent=`正在本机识别 ${index+1}/${files.length}：${name}${typeof task.progress==='number'?` · ${Math.round(task.progress)}%`:''}`;
          await new Promise(resolve=>setTimeout(resolve,1500));
          task=await ask('getDocumentImport',{id:task.id});
        }
        if(task.status!=='done' || !task.result?.text?.trim())throw new Error(task.error || '未识别到文字，请检查文件或改用文字输入。');
        parts.push(`## 导入材料：${name}\n${task.result.text.trim()}`);
        for(const warning of task.result.warnings || [])warnings.push(`${name}：${warning}`);
      }catch(error){warnings.push(`${name}：${error.message}`);}
    }
    el['import-preview'].value=parts.join('\n\n');
    el['import-warnings'].textContent=warnings.join('\n');
    el['import-review'].hidden=parts.length===0;
    el['import-status'].textContent=parts.length?`已识别${parts.length}个文件。请核对下方文字，再确认加入资料。`:'文件未能完成识别，请查看提示或改用文字输入。';
    if(!parts.length && warnings.length)el['import-status'].textContent+='\n'+warnings.join('\n');
  }finally{importing=false;el['import-files'].disabled=false;el.documents.disabled=false;}
});
el['append-import'].addEventListener('click',()=>{
  if(!loaded)return;
  const text=el['import-preview'].value.trim();if(!text)return;
  const draft=profileText().trim();
  const current=draft.includes('<!-- PROFILE_NOT_CONFIGURED -->')?'':draft;
  const combined=current?`${current}\n\n${text}`:text;
  if(combined.length>60000){el['import-status'].textContent='加入后超过60000字符，请先精简识别结果，只保留与你求职相关的事实。';return;}
  el.profile.value=combined;el['import-review'].hidden=true;el['import-preview'].value='';
  el['profile-note'].textContent='识别文字已加入编辑区，请继续核对并点击“保存并应用”。';
  el['import-status'].textContent='已加入个人资料编辑区，保存后用于生成。';
});
load();
