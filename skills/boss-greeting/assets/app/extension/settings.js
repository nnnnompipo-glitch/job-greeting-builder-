const el = Object.fromEntries(['status','settings-form','fields','provider','provider-help','http-fields','base-url','model','api-key','key-state','key-help','clear-key','response-format','timeout','data-note','test-model','profile','profile-note','save','reload','retry-load','tone','tone-help','documents','import-files','import-status','import-review','import-preview','import-warnings','append-import'].map(id => [id,document.getElementById(id)]));
const toneHelp={professional:'正式、客观、以经历和能力为主，不用感叹号或比喻。',friendly:'自然口语，表达友好与沟通意愿，不做夸张修辞。',bold:'用有张力的表达突出热情和行动意愿；能力、经历和指标不能夸大。',creative:'允许一句贴合行业的巧思或比喻，随后回到具体项目和事实。'};
function updateTone(){el['tone-help'].textContent=toneHelp[el.tone.value] || toneHelp.professional;}
const presets = {
  codex: { baseUrl: '', help: '使用电脑上已登录的 Codex 命令行。仅选择其他模型时才需要填写接口地址。', note: '岗位文字和提炼后的个人资料会交给已登录的 Codex 生成。' },
  doubao: { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', help: '在火山方舟开通模型服务，填写 API Key，以及控制台提供的模型名称或接入点 ID。', placeholder: '填写火山方舟控制台中的模型名称或 ep-… 接入点 ID', note: '岗位文字和个人资料会发送到所填的火山方舟接口，使用你自己的 API 额度。' },
  ollama: { baseUrl: 'http://127.0.0.1:11434/v1', help: '先启动 Ollama，并在本机下载一个支持中文的对话模型。模型名称填写本机已安装的完整名称。', placeholder: '填写 ollama list 中的完整模型名称', note: '使用本机地址时，生成请求交给电脑上的模型服务处理；不会自动切换到云端模型。' },
  lmstudio: { baseUrl: 'http://127.0.0.1:1234/v1', help: '先在 LM Studio 中加载模型，并开启 Local Server。模型名称填写该服务提供的模型 ID。', placeholder: '填写 LM Studio 中已加载模型的 ID', note: '使用本机地址时，生成请求交给电脑上的模型服务处理；不会自动切换到云端模型。' },
  'openai-compatible': { baseUrl: '', help: '支持 Chat Completions 协议的模型服务，例如你部署的本地服务或其他云端服务。', placeholder: '填写服务商提供的模型 ID', note: '岗位文字和个人资料会发送到你填写的接口。请核对它是否为你要使用的云端或本地服务。' }
};
let loaded = false, initialProfile = '', savedModel = null;

function status(message,kind = '') { el.status.textContent = message; el.status.dataset.kind = kind; }
async function ask(action,values = {}) {
  const reply = await chrome.runtime.sendMessage({action,...values});
  if (!reply?.ok) throw new Error(reply?.error || '扩展后台没有响应，请重新加载扩展。');
  return reply.data;
}
function updateProvider(reset = false) {
  const provider = el.provider.value, preset = presets[provider];
  el['provider-help'].textContent = preset.help;
  el['data-note'].textContent = preset.note;
  el['http-fields'].hidden = provider === 'codex';
  if (reset) {
    el['base-url'].value = preset.baseUrl;
    el.model.value = '';
    el['api-key'].value = '';
    el['clear-key'].checked = false;
    el['response-format'].value = 'auto';
  }
  el.model.placeholder = preset.placeholder || '';
  const keyStored = savedModel?.provider === provider && savedModel?.baseUrl === el['base-url'].value.trim() && savedModel?.hasApiKey;
  el['key-state'].textContent = keyStored ? '已保存，留空保留' : ['ollama','lmstudio'].includes(provider) ? '本地服务通常无需填写' : '';
  el['api-key'].placeholder = keyStored ? '已保存，留空即可保留；填写新值可替换' : ['ollama','lmstudio'].includes(provider) ? '本地服务未设认证时留空' : '填写模型服务商提供的密钥';
  el['key-help'].textContent = '密钥保存在本机助手配置中，页面不会回显。更换模型来源或接口地址后，需要重新填写对应密钥。';
}
function modelPayload() {
  const model = {
    provider: el.provider.value,
    baseUrl: el['base-url'].value.trim(),
    model: el.model.value.trim(),
    responseFormat: el['response-format'].value,
    timeoutMs: Number(el.timeout.value)*1000
  };
  const key = el['api-key'].value.trim();
  if (key) model.apiKey = key;
  if (el['clear-key'].checked) model.clearApiKey = true;
  return model;
}
function profileText() {
  const value = el.profile.value;
  const strip = text => text.replace(/^\uFEFF?\s*<!-- PROFILE_NOT_CONFIGURED -->\s*\r?\n?/,'');
  return strip(value).replace(/\s/g,'') !== strip(initialProfile).replace(/\s/g,'') ? strip(value) : value;
}
function apply(data) {
  savedModel = data.model || {provider:'codex'};
  el.provider.value = presets[savedModel.provider] ? savedModel.provider : 'codex';
  el['base-url'].value = savedModel.baseUrl || presets[el.provider.value].baseUrl;
  el.model.value = savedModel.model || '';
  el['api-key'].value = '';
  el['clear-key'].checked = false;
  el['response-format'].value = savedModel.responseFormat || 'auto';
  el.timeout.value = (savedModel.timeoutMs || 120000)/1000;
  el.tone.value=toneHelp[data.preferences?.tone] ? data.preferences.tone : 'professional';
  updateTone();
  initialProfile = data.profile || '';
  el.profile.value = initialProfile;
  el['profile-note'].textContent = data.profileReady ? '已有个人资料。请只保留真实、有证据支撑的经历。' : '个人资料尚未完成。请将示例内容替换为你的真实经历；编辑后保存会移除模板占位标记。';
  updateProvider();
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
    status('已读取本地设置。选择模型后可先测试，再保存应用。');
  } catch (error) {
    status(error.message + '\n请先在浏览器工具栏的助手弹窗中填写配对码；本地助手也需要保持运行。','error');
    el['retry-load'].hidden = false;
  }
}
el.provider.addEventListener('change',() => updateProvider(true));
el.tone.addEventListener('change',updateTone);
el['base-url'].addEventListener('input',() => updateProvider());
el['settings-form'].addEventListener('submit',async event => {
  event.preventDefault();
  if (!loaded) return;
  el.fields.disabled = true;
  status('正在保存设置…');
  try {
    const data = await ask('saveModelSettings',{model:modelPayload(),profile:profileText(),preferences:{tone:el.tone.value}});
    apply(data);
    status(data.profileReady ? '已保存并应用。返回岗位页，点击“重新检测”即可使用当前模型。' : '模型设置已保存。个人资料仍未完成，请补充真实经历后再生成。');
  } catch (error) { status(error.message,'error'); }
  finally { el.fields.disabled = false; }
});
el['test-model'].addEventListener('click',async () => {
  if (!loaded) return;
  el.fields.disabled = true;
  status('正在测试所选模型，仅发送模拟请求。首次加载本地模型可能需要等待…');
  try {
    const result = await ask('testModelSettings',{model:modelPayload()});
    status(result.message || '模型连接成功。设置尚未保存时，请点击“保存并应用”。',result.ok ? '' : 'error');
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
