import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { normalizeModelSettings, publicModelSettings } from '../server/providers.mjs';
import { SettingsStore } from '../server/settings.mjs';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEEPSEEK_URL = 'https://api.deepseek.com';
const LOCAL_ENDPOINTS = [
  {provider:'ollama',baseUrl:'http://127.0.0.1:11434/v1'},
  {provider:'lmstudio',baseUrl:'http://127.0.0.1:1234/v1'}
];
const knownProviders = new Set(['codex','doubao','deepseek','ollama','lmstudio','openai-compatible']);
const nonempty = value => typeof value === 'string' && value.trim() !== '';
const value = (env,key) => typeof env[key] === 'string' ? env[key].trim() : '';
function error(message) { return Object.assign(new Error(message),{publicMessage:message}); }
function canonical(provider) { return provider === 'deepseek' ? 'openai-compatible' : provider; }
function incomplete(candidate,missing,message) {
  return {...candidate,complete:false,missing,message};
}
function candidate(input,source) {
  let settings;
  try { settings = normalizeModelSettings(input,{allowIncomplete:true}); }
  catch { return {source,complete:false,missing:['validSettings'],message:'模型来源、地址或参数格式不正确，请核对后重试'}; }
  const base = {settings,source};
  const missing = [];
  if (settings.provider !== 'codex') {
    if (!settings.baseUrl) missing.push('baseUrl');
    if (!settings.model) missing.push('model');
  }
  if (missing.length) return incomplete(base,missing,'还缺少完整的模型连接信息');
  try { normalizeModelSettings(settings); }
  catch { return incomplete(base,['apiKey'],'还缺少所选模型服务的 API Key'); }
  return {...base,complete:true};
}
function summary(item) {
  const settings = item.settings ? publicModelSettings(item.settings) : {provider:'',baseUrl:'',model:'',hasApiKey:false};
  return {provider:settings.provider,baseUrl:settings.baseUrl,model:settings.model,source:item.source,hasApiKey:settings.hasApiKey};
}
function outcome(items) {
  const complete = items.filter(item=>item.complete);
  if (complete.length === 1) {
    const found = complete[0];
    return {status:'ready',settings:found.settings,source:found.source,candidates:items.map(summary),message:'已找到一组完整模型配置；尚未调用模型'};
  }
  if (complete.length > 1) return {status:'ambiguous',candidates:items.map(summary),message:'检测到多组可用模型配置，请明确选择来源；未自动写入'};
  if (items.length) return {status:'incomplete',candidates:items.map(summary),missing:[...new Set(items.flatMap(item=>item.missing || []))],message:items.length===1 ? items[0].message : '检测到的配置尚不完整，请补充模型名称、地址或所选来源的密钥'};
  return {status:'none',candidates:[],message:'没有检测到明确提供的模型连接信息，请选择来源或在模型设置页填写'};
}
function envGroups(env) {
  return [
    {source:'OPENAI_*',seen:['OPENAI_BASE_URL','OPENAI_MODEL','OPENAI_API_KEY'],settings:{provider:'openai-compatible',baseUrl:value(env,'OPENAI_BASE_URL'),model:value(env,'OPENAI_MODEL'),apiKey:value(env,'OPENAI_API_KEY')}},
    {source:'ARK_*',seen:['ARK_MODEL','ARK_API_KEY'],settings:{provider:'doubao',model:value(env,'ARK_MODEL'),apiKey:value(env,'ARK_API_KEY')}},
    {source:'DEEPSEEK_*',seen:['DEEPSEEK_MODEL','DEEPSEEK_API_KEY'],settings:{provider:'openai-compatible',baseUrl:DEEPSEEK_URL,model:value(env,'DEEPSEEK_MODEL'),apiKey:value(env,'DEEPSEEK_API_KEY')}},
    {source:'OLLAMA_*',seen:['OLLAMA_HOST','OLLAMA_MODEL'],settings:{provider:'ollama',baseUrl:ollamaBase(value(env,'OLLAMA_HOST')),model:value(env,'OLLAMA_MODEL')}},
    {source:'LMSTUDIO_*',seen:['LMSTUDIO_BASE_URL','LMSTUDIO_MODEL'],settings:{provider:'lmstudio',...(value(env,'LMSTUDIO_BASE_URL') ? {baseUrl:value(env,'LMSTUDIO_BASE_URL')} : {}),model:value(env,'LMSTUDIO_MODEL')}}
  ];
}
function ollamaBase(host) {
  if (!host) return 'http://127.0.0.1:11434/v1';
  try {
    const address = new URL(host.includes('://') ? host : 'http://'+host);
    if (address.hostname === '0.0.0.0') address.hostname='127.0.0.1';
    if (address.hostname === '[::]') address.hostname='[::1]';
    if (address.pathname === '/' || !address.pathname) return address.origin+'/v1';
    return address.href;
  } catch { /* Validation below rejects invalid addresses. */ }
  return host;
}
function selectedCandidate(options,env) {
  const selected = options.provider || value(env,'BOSS_HELPER_PROVIDER') || 'openai-compatible';
  if (!knownProviders.has(selected)) return candidate({provider:selected},'explicit');
  const keyVariable = options.apiKeyEnv;
  if (keyVariable !== undefined && (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyVariable))) return incomplete({source:'explicit'},['apiKeyEnv'],'密钥环境变量名格式不正确');
  const bossProvider = value(env,'BOSS_HELPER_PROVIDER');
  const bossApplies = !options.provider || (bossProvider && bossProvider === selected);
  if (selected === 'codex') return candidate({provider:'codex'},options.provider ? 'explicit provider' : 'BOSS_HELPER_*');
  const group = selected === 'deepseek' ? envGroups(env).find(item=>item.source === 'DEEPSEEK_*') :
    selected === 'doubao' ? envGroups(env).find(item=>item.source === 'ARK_*') :
    selected === 'ollama' ? envGroups(env).find(item=>item.source === 'OLLAMA_*') :
    selected === 'lmstudio' ? envGroups(env).find(item=>item.source === 'LMSTUDIO_*') :
    selected === 'openai-compatible' ? envGroups(env).find(item=>item.source === 'OPENAI_*') : {settings:{}};
  const base = group.settings;
  const pick = (explicit,bossKey,fallback) => explicit !== undefined ? explicit : (bossApplies && value(env,bossKey) ? value(env,bossKey) : fallback);
  const chosen = {
    ...base,provider:canonical(selected),
    baseUrl:pick(options.baseUrl,'BOSS_HELPER_BASE_URL',selected === 'deepseek' ? DEEPSEEK_URL : base.baseUrl),
    model:pick(options.model,'BOSS_HELPER_MODEL',base.model || ''),
    apiKey:''
  };
  // undefined preserves the normalizer's provider-specific Base URL defaults.
  if (chosen.baseUrl === undefined) delete chosen.baseUrl;
  const endpoint = input => {
    try { return normalizeModelSettings({...input,apiKey:''},{allowIncomplete:true}).baseUrl; }
    catch { return ''; }
  };
  const chosenEndpoint=endpoint(chosen);
  const groupEndpoint=endpoint({...base,provider:canonical(selected)});
  const bossHasTarget=bossApplies && (value(env,'BOSS_HELPER_BASE_URL') || value(env,'BOSS_HELPER_PROVIDER'));
  const bossEndpoint=bossHasTarget ? endpoint({provider:canonical(selected),...(value(env,'BOSS_HELPER_BASE_URL') ? {baseUrl:value(env,'BOSS_HELPER_BASE_URL')} : {})}) : '';
  // A URL override alone never authorizes forwarding an inherited key elsewhere.
  if (keyVariable) chosen.apiKey=value(env,keyVariable);
  else if (options.apiKey !== undefined) chosen.apiKey=options.apiKey;
  else if (bossApplies && value(env,'BOSS_HELPER_API_KEY')) chosen.apiKey=chosenEndpoint && chosenEndpoint===bossEndpoint ? value(env,'BOSS_HELPER_API_KEY') : '';
  else chosen.apiKey=chosenEndpoint && chosenEndpoint===groupEndpoint ? (base.apiKey || '') : '';
  return candidate(chosen,options.provider ? 'explicit provider' : 'BOSS_HELPER_*');
}

async function localCandidates(fetchImpl) {
  const groups = await Promise.all(LOCAL_ENDPOINTS.map(async endpoint=>{
    try {
      const response = await fetchImpl(endpoint.baseUrl+'/models',{method:'GET',headers:{Accept:'application/json'},credentials:'omit',redirect:'error',signal:AbortSignal.timeout(2000)});
      if (!response.ok || Number(response.headers?.get?.('content-length')) > 262144) return [];
      const chunks=[]; let bytes=0;
      if (!response.body) return [];
      for await (const chunk of response.body) {
        bytes+=chunk.length;
        if(bytes>262144) throw error('本机模型列表过长');
        chunks.push(chunk);
      }
      const text = Buffer.concat(chunks).toString('utf8');
      if (Buffer.byteLength(text,'utf8') > 262144) return [];
      const data = JSON.parse(text)?.data;
      if (!Array.isArray(data)) return [];
      return [...new Set(data.slice(0,200).filter(item=>typeof item?.id === 'string' && item.id.trim().length > 0 && item.id.length <= 256).map(item=>item.id.trim()))]
        .map(model=>candidate({...endpoint,model},'loopback /models'));
    } catch { return []; }
  }));
  return groups.flat();
}

export async function detectHostModel(options = {}) {
  const {env=process.env,detectLocal=false,fetchImpl=globalThis.fetch} = options;
  const bossKeys = ['BOSS_HELPER_PROVIDER','BOSS_HELPER_BASE_URL','BOSS_HELPER_MODEL','BOSS_HELPER_API_KEY'];
  const explicit = options.provider !== undefined || options.baseUrl !== undefined || options.model !== undefined || options.apiKey !== undefined || options.apiKeyEnv !== undefined || bossKeys.some(key=>nonempty(env[key]));
  if (explicit) {
    const item = selectedCandidate(options,env);
    if (!item.complete && detectLocal && ['ollama','lmstudio'].includes(item.settings?.provider) && !item.settings.model) {
      const locals = (await localCandidates(fetchImpl)).filter(local=>local.settings.provider === item.settings.provider && local.settings.baseUrl === item.settings.baseUrl);
      if (locals.length) return outcome(locals);
    }
    return outcome([item]);
  }
  const items = envGroups(env).filter(group=>group.seen.some(key=>nonempty(env[key]))).map(group=>candidate(group.settings,group.source));
  if (detectLocal) items.push(...await localCandidates(fetchImpl));
  // The same local model may be described by env and discovery; it remains one target.
  const deduped = [];
  for (const item of items) {
    const identical = item.complete && deduped.find(other=>other.complete && JSON.stringify(other.settings) === JSON.stringify(item.settings));
    if (!identical) deduped.push(item);
  }
  return outcome(deduped);
}

export function redactDetection(result) {
  const output = {status:result.status,message:result.message};
  if (result.source) output.source=result.source;
  if (result.settings) output.settings=publicModelSettings(result.settings);
  if (result.candidates) output.candidates=result.candidates.map(item=>({provider:item.provider,baseUrl:item.baseUrl,model:item.model,source:item.source,hasApiKey:Boolean(item.hasApiKey)}));
  if (result.missing) output.missing=[...result.missing];
  if (typeof result.applied === 'boolean') output.applied=result.applied;
  if (result.via) output.via=result.via;
  return output;
}

async function loadConfig(root) {
  const configPath=path.join(root,'private','config.json');
  try { return {configPath,config:JSON.parse((await readFile(configPath,'utf8')).replace(/^\uFEFF/,''))}; }
  catch (cause) {
    if (cause.code !== 'ENOENT') throw error('本机助手配置无法读取，请检查 private/config.json 格式');
  }
  await mkdir(path.dirname(configPath),{recursive:true});
  const config={port:43127,timeoutMs:120000,token:randomBytes(32).toString('hex')};
  await writeFile(configPath,JSON.stringify(config,null,2),{encoding:'utf8',mode:0o600});
  return {configPath,config};
}

export async function configureHost({root=DEFAULT_ROOT,options={},env=process.env,fetchImpl=globalThis.fetch}={}) {
  const detected=await detectHostModel({...options,env,fetchImpl});
  if (detected.status !== 'ready' || !options.apply) return {...redactDetection(detected),applied:false};
  const {configPath,config}=await loadConfig(path.resolve(root));
  if (config.port !== 43127 || !/^[a-f0-9]{64}$/.test(config.token)) throw error('本机助手配置不正确，尚未应用模型设置');
  const endpoint='http://127.0.0.1:43127';
  const headers={'X-Boss-Helper-Token':config.token};
  let offline=false;
  try {
    const response=await fetchImpl(endpoint+'/api/health',{headers,redirect:'error',credentials:'omit',signal:AbortSignal.timeout(2000)});
    if (!response.ok || (await response.json())?.app !== 'boss-greeting-helper') throw error('助手端口已被其他实例使用或无法验证，请关闭另一份助手后重试');
  } catch(cause) {
    if (cause.code === 'ECONNREFUSED' || cause.cause?.code === 'ECONNREFUSED') offline=true;
    else throw error(cause.publicMessage || '无法确认助手运行状态，尚未写入模型设置；请先检查本地服务');
  }
  const model={...detected.settings,clearApiKey:!detected.settings.apiKey};
  if (offline) {
    const store=new SettingsStore({root:path.resolve(root),config,configPath});
    await store.update({model});
  } else {
    let response;
    try { response=await fetchImpl(endpoint+'/api/settings',{method:'PUT',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({model}),redirect:'error',credentials:'omit',signal:AbortSignal.timeout(10000)}); }
    catch { throw error('连接助手失败，模型设置尚未应用；请检查本地服务'); }
    if (!response.ok) throw error('助手拒绝了模型配置，尚未确认应用成功；请在设置页检查');
  }
  return {...redactDetection(detected),applied:true,via:offline?'local-file':'running-helper',message:'已应用所选模型连接信息；个人资料未更改，尚未调用模型'};
}

function cliOptions(args) {
  const options={}; let root=DEFAULT_ROOT;
  const takesValue={'--provider':'provider','--model':'model','--base-url':'baseUrl','--api-key-env':'apiKeyEnv'};
  for(let i=0;i<args.length;i++) {
    const arg=args[i];
    if (arg === '--apply') options.apply=true;
    else if(arg === '--detect-local') options.detectLocal=true;
    else if(arg === '--root') { if(!args[i+1] || args[i+1].startsWith('--')) throw error('--root 需要本地安装目录'); root=path.resolve(args[++i]); }
    else if(takesValue[arg]) { if(!args[i+1] || args[i+1].startsWith('--')) throw error('模型配置参数缺少值'); options[takesValue[arg]]=args[++i]; }
    else if(arg === '--help') return {help:true};
    else throw error('不支持的配置参数；密钥请通过 --api-key-env 指定，不能直接放在命令行');
  }
  return {root,options};
}

if (process.argv[1] && (await realpath(path.resolve(process.argv[1])).catch(()=>null)) === fileURLToPath(import.meta.url)) {
  try {
    const parsed=cliOptions(process.argv.slice(2));
    if(parsed.help) console.log('用法：node scripts/configure-host.mjs [--provider codex|doubao|deepseek|ollama|lmstudio|openai-compatible] [--model ID] [--base-url URL] [--api-key-env ENV_NAME] [--detect-local] [--apply] [--root DIRECTORY]');
    else {
      const result=await configureHost(parsed);
      console.log(JSON.stringify(result,null,2));
      if(parsed.options.apply && !result.applied) process.exitCode=2;
    }
  } catch(cause) { console.error(JSON.stringify({status:'error',message:cause.publicMessage || '模型配置失败，请检查输入及本地目录权限'})); process.exitCode=1; }
}
