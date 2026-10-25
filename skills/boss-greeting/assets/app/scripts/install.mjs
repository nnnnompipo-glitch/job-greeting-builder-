import { readFile, writeFile, mkdir, access, copyFile, realpath } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { normalizeModelSettings, publicModelSettings } from '../server/providers.mjs';
import { isProfileReady, atomicWrite } from '../server/settings.mjs';
import { detectHostModel, redactDetection } from './configure-host.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const runtimeFiles = [
  'package.json','启动助手.cmd','停止助手.cmd',
  'server/core.mjs','server/http.mjs','server/index.mjs','server/model.mjs','server/providers.mjs','server/settings.mjs','server/imports.mjs','server/greeting.schema.json',
  'extension/manifest.json','extension/platforms.cjs','extension/platforms.js','extension/background.js','extension/extract.js','extension/code-rain.js','extension/content.js',
  'extension/popup.html','extension/popup.js','extension/popup.css','extension/settings.html','extension/settings.js','extension/settings.css',
  'scripts/install.mjs','scripts/configure-host.mjs','scripts/codex.mjs','scripts/bootstrap.ps1','scripts/start.ps1','scripts/stop.ps1','scripts/import-document.ps1',
  'templates/config.default.json','templates/profile.example.md'
];
function failure(message) {return Object.assign(new Error(message),{publicMessage:message});}
async function exists(filename) {try {await access(filename);return true;} catch {return false;}}

export function parseInstallArguments(args) {
  const {values} = parseArgs({args,options:{
    root:{type:'string'},'install-dir':{type:'string'},diagnose:{type:'boolean'},start:{type:'boolean'},
    provider:{type:'string'},'replace-model':{type:'boolean'},help:{type:'boolean'}
  },strict:true,allowPositionals:false});
  if (values.diagnose && (values.start || values['replace-model'])) throw failure('诊断模式不启动或更改配置，请分开运行');
  if (values.provider && values.provider !== 'codex') throw failure('此版本统一使用 Codex 登录，不支持其他模型或 API Key');
  return {root:values.root,installDir:values['install-dir'],diagnose:Boolean(values.diagnose),start:Boolean(values.start),provider:values.provider,help:Boolean(values.help)};
}

export function defaultInstallRoot(env=process.env) {
  return path.resolve(env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA,'BOSS-Greeting-Helper') :
    process.platform === 'win32' ? path.join(env.USERPROFILE || os.homedir(),'AppData','Local','BOSS-Greeting-Helper') : path.join(os.homedir(),'.local','share','BOSS-Greeting-Helper'));
}

export async function deployRuntime(sourceRoot,targetRoot) {
  sourceRoot=path.resolve(sourceRoot);targetRoot=path.resolve(targetRoot);
  if (sourceRoot === targetRoot) return {copied:false,filesUpdated:0};
  for(const relative of runtimeFiles) if (!(await exists(path.join(sourceRoot,relative)))) throw failure('技能程序不完整，无法部署到本机目录');
  let filesUpdated=0;
  for(const relative of runtimeFiles) {
    const source=path.join(sourceRoot,relative),target=path.join(targetRoot,relative);
    const incoming=await readFile(source);
    try {if((await readFile(target)).equals(incoming)) continue;} catch(error) {if(error.code !== 'ENOENT') throw failure('本机程序文件无法读取，未删除任何个人资料');}
    await mkdir(path.dirname(target),{recursive:true});
    await copyFile(source,target); filesUpdated++;
  }
  return {copied:true,filesUpdated};
}

export async function prepareInstallation(root) {
  const required = ['server/index.mjs','server/providers.mjs','server/settings.mjs','extension/manifest.json','scripts/start.ps1','scripts/stop.ps1','scripts/codex.mjs','templates/config.default.json','templates/profile.example.md'];
  for (const relative of required) if (!(await exists(path.join(root,relative)))) throw failure('技能安装不完整，请取得包含 assets/app 的完整技能目录');
  const privateDir = path.join(root,'private');
  await mkdir(privateDir,{recursive:true});
  const configPath = path.join(privateDir,'config.json');
  let config, createdConfig = false;
  try {config=JSON.parse((await readFile(configPath,'utf8')).replace(/^\uFEFF/,''));}
  catch(error) {
    if (error.code !== 'ENOENT') throw failure('现有本地配置无法读取，已保留原文件，请检查格式');
    let defaults;
    try {defaults=JSON.parse(await readFile(path.join(root,'templates','config.default.json'),'utf8'));}
    catch {throw failure('默认配置缺失或格式不正确');}
    config={...defaults,port:43127,token:randomBytes(32).toString('hex')};
    await writeFile(configPath,JSON.stringify(config,null,2),{encoding:'utf8',flag:'wx',mode:0o600});
    createdConfig=true;
  }
  if (config.port !== 43127 || !/^[a-f0-9]{64}$/.test(config.token || '')) throw failure('现有配对配置不正确，安装器不会覆盖它');
  let migrated=false, backupFile=null;
  const previousModel=config.model;
  let needsMigration=false;
  if (previousModel) {try {normalizeModelSettings(previousModel);}catch{needsMigration=true;}}
  if (needsMigration) {
    backupFile=path.join(privateDir,'config.before-codex-only.'+randomUUID()+'.json');
    await writeFile(backupFile,JSON.stringify(config,null,2),{encoding:'utf8',flag:'wx',mode:0o600});
    const timeoutMs=Number.isInteger(previousModel.timeoutMs) && previousModel.timeoutMs>=1000 && previousModel.timeoutMs<=600000 ? previousModel.timeoutMs : 120000;
    config={...config,model:{provider:'codex',timeoutMs}};
    await atomicWrite(configPath,JSON.stringify(config,null,2));
    migrated=true;
  }
  const profilePath = path.join(privateDir,'profile.md');
  if (!(await exists(profilePath))) await writeFile(profilePath,await readFile(path.join(root,'templates','profile.example.md'),'utf8'),{encoding:'utf8',flag:'wx',mode:0o600});
  await writeFile(path.join(privateDir,'pairing.txt'),config.token,{encoding:'utf8',mode:0o600});
  let configured = false;
  try { normalizeModelSettings(config.model || {provider:'codex'}); configured=true; } catch {}
  return {config,createdConfig,configured,migrated,backupFile,profileReady:isProfileReady(await readFile(profilePath,'utf8'))};
}

export function runLauncher(executable,args,{cwd,env,timeoutMs=20000,spawnImpl=spawn}={}) {
  return new Promise((resolve,reject)=>{
    let child, settled=false, deadline;
    const finish=(error,code)=>{
      if (settled) return;
      settled=true;
      clearTimeout(deadline);
      // A background service may inherit these pipes after the launcher exits.
      child?.stdout?.destroy(); child?.stderr?.destroy();
      if (error) reject(error); else resolve(code);
    };
    try {child=spawnImpl(executable,args,{cwd,shell:false,windowsHide:true,env,stdio:['ignore','pipe','pipe']});}
    catch {finish(failure('无法启动本地服务，请检查 Windows PowerShell'));return;}
    child.stdout?.on('data',()=>{});child.stderr?.on('data',()=>{});
    child.once('error',()=>finish(failure('无法启动本地服务，请检查 Windows PowerShell')));
    // close waits for every inherited pipe; exit describes the launcher itself.
    child.once('exit',code=>finish(null,code));
    deadline=setTimeout(()=>{
      try {child.kill();} catch {}
      finish(failure('本地服务启动程序超时，请检查运行状态后重试'));
    },timeoutMs);
  });
}

async function startWindowsService(root,{restart=false}={}) {
  if (process.platform !== 'win32') throw failure('当前常驻助手仅支持 Windows；此设备不能报告浏览器自动化安装完成');
  const executable = process.env.SystemRoot ? path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe') : 'powershell.exe';
  async function run(script) {
    return runLauncher(executable,['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts',script)],{
      cwd:root,env:{...process.env,BOSS_HELPER_NODE_PATH:process.execPath}
    });
  }
  if (restart && (await exists(path.join(root,'private','server.pid')))) {
    if (await run('stop.ps1') !== 0) throw failure('无法安全停止本目录的旧服务，未停止其他实例');
  }
  if (await run('start.ps1') !== 0) throw failure('本地服务启动失败，可能已有另一份助手占用端口43127；未接管或停止其他实例');
  return true;
}

export async function install({root,sourceRoot=defaultRoot,options={},env=process.env,startService=startWindowsService,detectModel=detectHostModel}={}) {
  const inPlace=root !== undefined;
  root=path.resolve(root || options.installDir || defaultInstallRoot(env));
  if (Number(process.versions.node.split('.')[0]) < 22) throw failure('需要 Node.js 22 或更高版本');
  if (options.provider && options.provider !== 'codex' || options.applyHostEnv || options.apiKeyEnv || options.model || options.baseUrl || options.detectLocal) throw failure('此版本统一使用 Codex 登录，不再接入其他模型或 API Key');
  const detectOptions={env,provider:'codex'};
  if (options.diagnose) {
    const detection=await detectModel(detectOptions);
    return {mode:'diagnose',platform:process.platform,nodeVersion:process.versions.node,sourceRoot:path.resolve(sourceRoot),appRoot:root,hostConnection:redactDetection(detection),changed:false,serviceStarted:false};
  }
  const deployment=inPlace ? {copied:false,filesUpdated:0} : await deployRuntime(sourceRoot,root);
  const state=await prepareInstallation(root);
  const connection=await detectModel({...detectOptions,codexPath:state.config.codexPath});
  if (connection.codexPath && connection.codexPath !== state.config.codexPath) {
    state.config.codexPath=connection.codexPath;
    await atomicWrite(path.join(root,'private/config.json'),JSON.stringify(state.config,null,2));
  }
  const serviceStarted=options.start ? await startService(root,{restart:deployment.filesUpdated > 0 || state.migrated}) : false;
  let current;
  try {current=JSON.parse(await readFile(path.join(root,'private','config.json'),'utf8'));} catch {throw failure('无法读取安装后的配置');}
  let modelConfigured=false;
  try {normalizeModelSettings(current.model || {provider:'codex'});modelConfigured=true;} catch {}
  return {mode:'install',appRoot:root,deployment,extensionPath:path.join(root,'extension'),pairingFile:path.join(root,'private','pairing.txt'),
    createdConfig:state.createdConfig,serviceStarted,profileReady:state.profileReady,migratedToCodex:state.migrated,legacyBackupFile:state.backupFile,
    modelConfigured,
    model:publicModelSettings(current.model || {provider:'codex'}),connection:redactDetection(connection),
    modelConnectionVerified:false,codexLoginVerified:connection.ok===true,browserLoaded:false,
    nextSteps:[...(connection.ok ? [] : [connection.message || '安装 Codex 命令行后运行 codex login，使用自己的 ChatGPT 账号登录']),
      '在 Chrome 或 Edge 正常加载或重新加载 extensionPath，完成一次配对','在扩展的 Codex 与个人资料设置核对登录、资料和语气','开启前台检测，刷新岗位详情；由本人核对并手动发送']};
}

if (process.argv[1] && (await realpath(path.resolve(process.argv[1])).catch(()=>null)) === fileURLToPath(import.meta.url)) {
  try {
    const options=parseInstallArguments(process.argv.slice(2));
    if (options.help) console.log('node scripts/install.mjs [--diagnose] [--install-dir DIRECTORY] [--start]。统一使用 Codex 命令行的 ChatGPT 登录，不需要 API Key。');
    else console.log(JSON.stringify(await install({root:options.root,options}),null,2));
  } catch(error) {console.error(error.publicMessage || '安装未完成，请检查参数或运行环境；未输出账号凭据');process.exitCode=1;}
}
