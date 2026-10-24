import { readFile, writeFile, mkdir, access, copyFile, realpath } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { normalizeModelSettings, publicModelSettings } from '../server/providers.mjs';
import { isProfileReady } from '../server/settings.mjs';
import { detectHostModel, configureHost, redactDetection } from './configure-host.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const runtimeFiles = [
  'package.json','启动助手.cmd','停止助手.cmd',
  'server/core.mjs','server/http.mjs','server/index.mjs','server/model.mjs','server/providers.mjs','server/settings.mjs','server/greeting.schema.json',
  'extension/manifest.json','extension/background.js','extension/extract.js','extension/content.js',
  'extension/popup.html','extension/popup.js','extension/popup.css','extension/settings.html','extension/settings.js','extension/settings.css',
  'scripts/install.mjs','scripts/configure-host.mjs','scripts/bootstrap.ps1','scripts/start.ps1','scripts/stop.ps1',
  'templates/config.default.json','templates/profile.example.md'
];
function failure(message) {return Object.assign(new Error(message),{publicMessage:message});}
async function exists(filename) {try {await access(filename);return true;} catch {return false;}}

export function parseInstallArguments(args) {
  const {values} = parseArgs({args,options:{
    root:{type:'string'},'install-dir':{type:'string'},diagnose:{type:'boolean'},'detect-local':{type:'boolean'},
    'apply-host-env':{type:'boolean'},'replace-model':{type:'boolean'},start:{type:'boolean'},
    provider:{type:'string'},model:{type:'string'},'base-url':{type:'string'},'api-key-env':{type:'string'},help:{type:'boolean'}
  },strict:true,allowPositionals:false});
  if (values.diagnose && (values.start || values['apply-host-env'] || values['replace-model'])) throw failure('诊断模式不启动或更改配置，请分开运行');
  return {root:values.root,installDir:values['install-dir'],diagnose:Boolean(values.diagnose),detectLocal:Boolean(values['detect-local']),
    applyHostEnv:Boolean(values['apply-host-env']),replaceModel:Boolean(values['replace-model']),start:Boolean(values.start),
    provider:values.provider,model:values.model,baseUrl:values['base-url'],apiKeyEnv:values['api-key-env'],help:Boolean(values.help)};
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
  const required = ['server/index.mjs','server/providers.mjs','server/settings.mjs','extension/manifest.json','scripts/start.ps1','scripts/stop.ps1','templates/config.default.json','templates/profile.example.md'];
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
  const profilePath = path.join(privateDir,'profile.md');
  if (!(await exists(profilePath))) await writeFile(profilePath,await readFile(path.join(root,'templates','profile.example.md'),'utf8'),{encoding:'utf8',flag:'wx',mode:0o600});
  await writeFile(path.join(privateDir,'pairing.txt'),config.token,{encoding:'utf8',mode:0o600});
  let configured = false;
  try { normalizeModelSettings(config.model || {provider:'codex'}); configured=true; } catch {}
  return {config,createdConfig,configured,profileReady:isProfileReady(await readFile(profilePath,'utf8'))};
}

async function startWindowsService(root,{restart=false}={}) {
  if (process.platform !== 'win32') throw failure('当前常驻助手仅支持 Windows；此设备不能报告浏览器自动化安装完成');
  const executable = process.env.SystemRoot ? path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe') : 'powershell.exe';
  async function run(script) {
    const child=spawn(executable,['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts',script)],{cwd:root,shell:false,windowsHide:true,env:{...process.env,BOSS_HELPER_NODE_PATH:process.execPath},stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',()=>{});child.stderr.on('data',()=>{});
    const deadline=setTimeout(()=>child.kill(),20000);
    try {return await new Promise((resolve,reject)=>{child.once('error',()=>reject(failure('无法启动本地服务，请检查 Windows PowerShell')));child.once('close',resolve);});}
    finally {clearTimeout(deadline);}
  }
  if (restart && (await exists(path.join(root,'private','server.pid')))) {
    if (await run('stop.ps1') !== 0) throw failure('无法安全停止本目录的旧服务，未停止其他实例');
  }
  if (await run('start.ps1') !== 0) throw failure('本地服务启动失败，可能已有另一份助手占用端口43127；未接管或停止其他实例');
  return true;
}

export async function install({root,sourceRoot=defaultRoot,options={},env=process.env,startService=startWindowsService,detectModel=detectHostModel,configureModel=configureHost}={}) {
  const inPlace=root !== undefined;
  root=path.resolve(root || options.installDir || defaultInstallRoot(env));
  if (Number(process.versions.node.split('.')[0]) < 22) throw failure('需要 Node.js 22 或更高版本');
  const detectOptions={env,provider:options.provider,model:options.model,baseUrl:options.baseUrl,apiKeyEnv:options.apiKeyEnv,detectLocal:Boolean(options.detectLocal)};
  if (options.diagnose) {
    const detection=await detectModel(detectOptions);
    return {mode:'diagnose',platform:process.platform,nodeVersion:process.versions.node,sourceRoot:path.resolve(sourceRoot),appRoot:root,hostConnection:redactDetection(detection),changed:false,serviceStarted:false};
  }
  const deployment=inPlace ? {copied:false,filesUpdated:0} : await deployRuntime(sourceRoot,root);
  const state=await prepareInstallation(root);
  let connection={status:'not-requested',applied:false,message:'未申请更改模型连接，可在扩展设置中选择模型'};
  if (options.applyHostEnv || options.provider) {
    if (state.configured && !options.replaceModel) connection={status:'preserved',applied:false,message:'已有可用格式的模型配置，已保留；确认更换时使用 --replace-model'};
    else connection=await configureModel({root,options:{...detectOptions,apply:true},env});
  }
  const serviceStarted=options.start ? await startService(root,{restart:deployment.filesUpdated > 0}) : false;
  let current;
  try {current=JSON.parse(await readFile(path.join(root,'private','config.json'),'utf8'));} catch {throw failure('无法读取安装后的配置');}
  let modelConfigured=false;
  try {normalizeModelSettings(current.model || {provider:'codex'});modelConfigured=true;} catch {}
  return {mode:'install',appRoot:root,deployment,extensionPath:path.join(root,'extension'),pairingFile:path.join(root,'private','pairing.txt'),
    createdConfig:state.createdConfig,serviceStarted,profileReady:state.profileReady,
    modelConfigured,
    model:publicModelSettings(current.model || {provider:'codex'}),connection:redactDetection(connection),
    modelConnectionVerified:false,browserLoaded:false,
    nextSteps:['在 Chrome 或 Edge 正常加载 extensionPath，完成一次配对','在扩展的模型与个人资料设置填写真实资料并测试所选模型','开启前台检测，刷新岗位详情；由本人核对并手动发送']};
}

if (process.argv[1] && (await realpath(path.resolve(process.argv[1])).catch(()=>null)) === fileURLToPath(import.meta.url)) {
  try {
    const options=parseInstallArguments(process.argv.slice(2));
    if (options.help) console.log('node scripts/install.mjs [--diagnose] [--apply-host-env | --provider PROVIDER] [--model ID] [--base-url URL] [--api-key-env NAME] [--detect-local] [--replace-model] [--install-dir DIRECTORY] [--start]');
    else console.log(JSON.stringify(await install({root:options.root,options}),null,2));
  } catch(error) {console.error(error.publicMessage || '安装未完成，请检查参数或运行环境；未输出账号凭据');process.exitCode=1;}
}
