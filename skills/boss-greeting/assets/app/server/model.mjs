import { spawn } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { buildPrompt, validateResult } from './core.mjs';
import { normalizeModelSettings } from './providers.mjs';
import { findCodex, checkCodexLogin } from '../scripts/codex.mjs';

function publicError(message) { return Object.assign(new Error(message), {publicMessage:message}); }

const ACTION_FEATURES=['shell_tool','apps','plugins','hooks','multi_agent','multi_agent_v2','browser_use','computer_use',
  'image_generation','code_mode_host','code_mode','tool_suggest','view_image','shell_snapshot','skill_search','workspace_dependencies'];
const defaultCapabilities={rootFlags:['--no-daemon','--ask-for-approval','--config'],execFlags:[
  '--ignore-user-config','--ignore-rules','--ephemeral','--skip-git-repo-check','--sandbox','--strict-config','--cd','--output-schema'
],features:ACTION_FEATURES};
const capabilityCache=new Map();
const compatibilityMessage='Codex 版本不支持安全生成参数，请更新 Codex 后重启助手；未改用其他模型。';

export function parseCodexCapabilities(rootHelp,execHelp,featureList) {
  const flags=text=>[...new Set(text.match(/--[a-z][a-z0-9-]+/g)||[])];
  const rootFlags=flags(rootHelp),execFlags=flags(execHelp),all=new Set([...rootFlags,...execFlags]);
  const features=[];
  for(const line of featureList.split(/\r?\n/)) {
    const match=/^([a-z][a-z0-9_]*)\s+.+?\s+(?:true|false)\s*$/.exec(line);
    if(match)features.push(match[1]);
  }
  for(const required of ['--ask-for-approval','--config','--sandbox','--cd','--output-schema','--skip-git-repo-check',
    '--ephemeral','--ignore-user-config','--ignore-rules']) {
    if(!all.has(required))throw publicError(compatibilityMessage);
  }
  if(!features.includes('shell_tool'))throw publicError(compatibilityMessage);
  return {rootFlags,execFlags,features};
}

function readCodexMetadata(executable,args,{env,spawnImpl=spawn,timeoutMs=3000}={}) {
  return new Promise((resolve,reject)=>{
    let child,timer,settled=false,output='';
    const finish=(error)=>{
      if(settled)return;settled=true;clearTimeout(timer);
      child?.stdout?.destroy();child?.stderr?.destroy();
      if(error){output='';reject(publicError(compatibilityMessage));}else resolve(output);
    };
    const stop=()=>{try{child?.kill();}catch{}finish(true);};
    try {child=spawnImpl(executable,args,{env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});}
    catch {finish(true);return;}
    for(const stream of [child.stdout,child.stderr]) {
      stream?.setEncoding('utf8');stream?.on('data',chunk=>{if(settled)return;output+=chunk;if(output.length>131072)stop();});
    }
    child.once('error',()=>finish(true));child.once('close',code=>finish(code!==0));
    timer=setTimeout(stop,timeoutMs);
  });
}

export async function probeCodexCapabilities(executable,{env=process.env,spawnImpl=spawn,statImpl=stat,timeoutMs=3000}={}) {
  let identity;
  try {const info=await statImpl(executable);identity=executable+'\0'+info.mtimeMs+'\0'+info.size;}
  catch {throw publicError(compatibilityMessage);}
  if(capabilityCache.has(identity))return capabilityCache.get(identity);
  const pending=(async()=>{
    const options={env,spawnImpl,timeoutMs};
    const [rootHelp,execHelp]=await Promise.all([
      readCodexMetadata(executable,['--help'],options),readCodexMetadata(executable,['exec','--help'],options)
    ]);
    if(!/^\s*features\s+/m.test(rootHelp))throw publicError(compatibilityMessage);
    const featureList=await readCodexMetadata(executable,['features','list'],options);
    return parseCodexCapabilities(rootHelp,execHelp,featureList);
  })();
  capabilityCache.set(identity,pending);
  while(capabilityCache.size>8)capabilityCache.delete(capabilityCache.keys().next().value);
  try{return await pending;}catch(error){capabilityCache.delete(identity);throw error;}
}

export function classifyFailure(stderr) {
  if (/not logged in|unauthori[sz]ed|authentication|\b401\b/i.test(stderr)) return 'Codex 登录不可用，请先在 Codex 中重新登录后重启助手';
  if (/usage limit|rate limit|quota|\b429\b/i.test(stderr)) return 'Codex 当前额度或频率受限，请稍后重试';
  if (/unknown configuration|unrecognized|unexpected argument/i.test(stderr)) return 'Codex 版本与助手参数不兼容，需要更新启动参数';
  if (/timed out|timeout|stream disconnected|connection|\bDNS\b/i.test(stderr)) return 'Codex 网络连接失败，请检查网络后重试';
  return 'Codex 未能生成草稿，请检查登录状态和网络后重试';
}

export function codexArguments(isolatedDir, schemaPath, useDaemon = false,capabilities=defaultCapabilities) {
  const rootFlags=new Set(capabilities.rootFlags),execFlags=new Set(capabilities.execFlags),features=new Set(capabilities.features);
  return [
    ...(!useDaemon && rootFlags.has('--no-daemon') ? ['--no-daemon'] : []), '-a','never','exec',
    '--ignore-user-config','--ignore-rules','--ephemeral','--skip-git-repo-check',
    '--sandbox','read-only',...(execFlags.has('--strict-config')?['--strict-config']:[]),'-C',isolatedDir,'--output-schema',schemaPath,
    ...ACTION_FEATURES.filter(key=>features.has(key)).flatMap(key => ['-c',`features.${key}=false`]),
    '-c','project_doc_max_bytes=0','-c','web_search="disabled"','-'
  ];
}

export async function generateGreeting(job, profile, config, {spawnImpl=spawn,findCodexImpl=findCodex,checkCodexLoginImpl=checkCodexLogin,probeCapabilitiesImpl=probeCodexCapabilities} = {}) {
  const settings=normalizeModelSettings(config.model || {provider:'codex',timeoutMs:config.timeoutMs || 120000});
  const isolatedDir = path.join(config.root,'private','model-workspace');
  await mkdir(isolatedDir,{recursive:true});
  const env = {...process.env};
  for (const key of Object.keys(env)) if (/^CODEX_/i.test(key) && key !== 'CODEX_HOME') delete env[key];
  for (const key of ['OPENAI_API_KEY','OPENAI_BASE_URL','OPENAI_MODEL']) delete env[key];
  const proxy = config.proxyUrl || config.systemProxyUrl;
  if (proxy) {
    for (const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy']) env[key] = proxy;
    env.NO_PROXY = env.no_proxy = [...new Set(['127.0.0.1','localhost',...(env.NO_PROXY || env.no_proxy || '').split(',')])].filter(Boolean).join(',');
  }
  const codexPath=await findCodexImpl({codexPath:config.codexPath || process.env.BOSS_CODEX_PATH,env});
  if (!codexPath) throw publicError('找不到 Codex 命令行，请安装 Codex 并使用 ChatGPT 账号登录后重试');
  const login=await checkCodexLoginImpl({codexPath,env});
  if (!login.ok || login.status !== 'ready') throw publicError(login.message || 'Codex 登录不可用，请使用 ChatGPT 账号登录后重试');
  const capabilities=await probeCapabilitiesImpl(codexPath,{env});
  const args = codexArguments(isolatedDir,path.join(config.root,'server','greeting.schema.json'),config.useDaemon,capabilities);
  const child = spawnImpl(codexPath,args,{
    cwd:isolatedDir,env,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']
  });
  let output = '', diagnostic = '', timedOut = false, tooLarge = false;
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data',data => { output += data; if (output.length > 40000) {tooLarge = true; child.kill();} });
  // stderr may echo personal inputs; keep only a short memory buffer, never log it.
  child.stderr.on('data',data => { diagnostic = (diagnostic + data).slice(-12000); });
  const deadline = setTimeout(() => {timedOut = true; child.kill();},settings.timeoutMs);
  const done = new Promise((resolve,reject) => {
    child.once('error',error => reject(publicError(error.code === 'ENOENT' ? '找不到 Codex 命令行，请重新运行启动助手' : '无法启动 Codex 生成进程')));
    child.once('close',code => resolve(code));
  });
  child.stdin.on('error',() => {});
  child.stdin.end(buildPrompt(job,profile,config.preferences),'utf8');
  try {
    const code = await done;
    if (timedOut) throw publicError('Codex 生成超时，请检查网络后点击重新生成');
    if (tooLarge) throw publicError('生成内容异常，已停止本次任务');
    if (code !== 0) throw publicError(classifyFailure(diagnostic));
    try { return validateResult(JSON.parse(output.trim())); }
    catch { throw publicError('生成结果格式异常，请点击重新生成'); }
  } finally { clearTimeout(deadline); output = ''; diagnostic = ''; }
}
