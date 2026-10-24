const el = Object.fromEntries(['status','settings-form','fields','provider','provider-help','http-fields','base-url','model','api-key','key-state','key-help','clear-key','response-format','timeout','data-note','test-model','profile','profile-note','save','reload','retry-load'].map(id => [id,document.getElementById(id)]));
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
el['base-url'].addEventListener('input',() => updateProvider());
el['settings-form'].addEventListener('submit',async event => {
  event.preventDefault();
  if (!loaded) return;
  el.fields.disabled = true;
  status('正在保存设置…');
  try {
    const data = await ask('saveModelSettings',{model:modelPayload(),profile:profileText()});
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
load();
