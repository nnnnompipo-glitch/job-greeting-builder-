import { stat, readdir, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const messages = {
  ready:'Codex 已通过 ChatGPT 账号登录，可以生成招呼语。',
  missing:'未找到 Codex 命令行。请先安装 Codex，再运行 codex login 使用 ChatGPT 账号登录。',
  'not-logged-in':'Codex 尚未通过 ChatGPT 账号登录，请运行 codex login 完成浏览器登录。',
  'api-key-login':'Codex 当前使用 API Key。此助手使用 ChatGPT 账号登录，请在 Codex 中切换登录方式。',
  error:'无法确认 Codex 的 ChatGPT 登录状态，请在终端运行 codex login status 检查。'
};

function cleanPath(input) {
  if(typeof input !== 'string' || !input.trim() || input.includes('\0')) return '';
  return input.trim().replace(/^"(.*)"$/,'$1');
}

async function nativeExecutable(input,platform) {
  if(!input || (platform === 'win32' && path.extname(input).toLowerCase() !== '.exe')) return null;
  try {
    const resolved=await realpath(input);
    if(platform === 'win32' && path.extname(resolved).toLowerCase() !== '.exe') return null;
    return (await stat(resolved)).isFile() ? resolved : null;
  } catch { return null; }
}

function packageExecutables(modulesRoot,platform,arch) {
  const triples={
    'win32-x64':'x86_64-pc-windows-msvc','win32-arm64':'aarch64-pc-windows-msvc',
    'linux-x64':'x86_64-unknown-linux-musl','linux-arm64':'aarch64-unknown-linux-musl',
    'darwin-x64':'x86_64-apple-darwin','darwin-arm64':'aarch64-apple-darwin'
  };
  const triple=triples[`${platform}-${arch}`];
  if(!triple) return [];
  const executable=platform === 'win32' ? 'codex.exe' : 'codex';
  const base=path.join(modulesRoot,'@openai');
  return [
    path.join(base,`codex-${platform}-${arch}`,'vendor',triple,'codex',executable),
    path.join(base,'codex','node_modules','@openai',`codex-${platform}-${arch}`,'vendor',triple,'codex',executable),
    path.join(base,'codex','vendor',triple,'codex',executable)
  ];
}

/** Locate only launchers and native package executables; never inspect credentials. */
export async function findCodex({codexPath,env=process.env,platform=process.platform,arch=process.arch}={}) {
  const executable=platform === 'win32' ? 'codex.exe' : 'codex';
  const pathValue=env.PATH || env.Path || '';
  const pathEntries=pathValue.split(platform === 'win32' ? ';' : ':').map(cleanPath).filter(Boolean);
  const explicit=[cleanPath(codexPath),cleanPath(env.BOSS_CODEX_PATH)].filter(Boolean);
  const npmRoots=[];
  const consider=async candidate=>{
    // npm's codex.cmd/PS1 wrapper is not executed through a shell. Resolve its native package instead.
    if(/\.(?:cmd|bat|ps1)$/i.test(candidate)) {
      npmRoots.push(path.join(path.dirname(candidate),'node_modules'));
      return null;
    }
    return nativeExecutable(candidate,platform);
  };
  for(const candidate of explicit) {
    const direct=await consider(candidate);
    if(direct) return direct;
    if(path.basename(candidate)===candidate && !path.extname(candidate)) {
      for(const directory of pathEntries) {
        const found=await nativeExecutable(path.join(directory,candidate+(platform==='win32'?'.exe':'')),platform);
        if(found) return found;
      }
    }
    // An explicitly selected npm shim takes precedence over unrelated installations.
    if(/\.(?:cmd|bat|ps1)$/i.test(candidate)) for(const candidatePath of packageExecutables(path.join(path.dirname(candidate),'node_modules'),platform,arch)) {
      const found=await nativeExecutable(candidatePath,platform);
      if(found) return found;
    }
  }
  for(const directory of pathEntries) {
    const found=await nativeExecutable(path.join(directory,executable),platform);
    if(found) return found;
    npmRoots.push(path.join(directory,'node_modules'));
  }
  if(platform === 'win32' && env.LOCALAPPDATA) {
    const desktopBin=path.join(env.LOCALAPPDATA,'OpenAI','Codex','bin');
    const direct=await nativeExecutable(path.join(desktopBin,executable),platform);
    if(direct) return direct;
    let versions=[];
    try {versions=await readdir(desktopBin,{withFileTypes:true});} catch {}
    const candidates=await Promise.all(versions.filter(item=>item.isDirectory()).slice(0,256).map(async item=>{
      const candidate=path.join(desktopBin,item.name,executable);
      try {return {candidate,modified:(await stat(candidate)).mtimeMs};} catch {return null;}
    }));
    for(const item of candidates.filter(Boolean).sort((a,b)=>b.modified-a.modified)) {
      const found=await nativeExecutable(item.candidate,platform);
      if(found) return found;
    }
    // The standalone Windows installer updates User PATH, which this process may not have inherited yet.
    const standalone=await nativeExecutable(path.join(env.LOCALAPPDATA,'Programs','OpenAI','Codex','bin',executable),platform);
    if(standalone) return standalone;
  }
  const userDirectory=env.USERPROFILE || env.HOME;
  if(userDirectory) {
    const found=await nativeExecutable(path.join(userDirectory,'.local','bin',executable),platform);
    if(found) return found;
  }
  if(env.APPDATA) npmRoots.push(path.join(env.APPDATA,'npm','node_modules'));
  if(env.NPM_CONFIG_PREFIX || env.npm_config_prefix) npmRoots.push(path.join(env.NPM_CONFIG_PREFIX || env.npm_config_prefix,'node_modules'));
  for(const modulesRoot of new Set(npmRoots)) for(const candidate of packageExecutables(modulesRoot,platform,arch)) {
    const found=await nativeExecutable(candidate,platform);
    if(found) return found;
  }
  return null;
}

export async function checkCodexLogin({codexPath,env=process.env,timeoutMs=7000,spawnImpl=spawn,findCodexImpl=findCodex}={}) {
  let executable=null;
  try {executable=await findCodexImpl({codexPath,env});} catch {}
  const result=status=>({ok:status==='ready',status,message:messages[status],...(executable?{codexPath:executable}:{})});
  if(!executable) return result('missing');
  const deadlineMs=Math.min(10000,Math.max(20,Number(timeoutMs)||7000));
  return new Promise(resolve=>{
    let child,timer,settled=false,output='';
    const finish=status=>{
      if(settled) return;
      settled=true;
      clearTimeout(timer);
      child?.stdout?.destroy();child?.stderr?.destroy();
      output='';
      resolve(result(status));
    };
    const stop=status=>{try{child?.kill();}catch{}finish(status);};
    try {
      // The CLI owns login state. A status command does not read or print credentials in this app.
      child=spawnImpl(executable,['login','status'],{env:{...env},shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
    } catch(error) {finish(error?.code==='ENOENT'?'missing':'error');return;}
    for(const stream of [child.stdout,child.stderr]) {
      stream?.setEncoding('utf8');
      stream?.on('data',data=>{if(settled)return;output+=data;if(output.length>16384)stop('error');});
    }
    child.once('error',error=>finish(error?.code==='ENOENT'?'missing':'error'));
    // close follows pipe draining; the deadline still bounds a process that retains inherited pipes.
    child.once('close',code=>{
      if(settled)return;
      const text=output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
      if(/(?:not\s+logged\s+in|not\s+authenticated|signed\s+out|未登录)/i.test(text))finish('not-logged-in');
      else if(/(?:api[ _-]?key|API\s*密钥)/i.test(text))finish('api-key-login');
      else if(code===0 && /(?:logged\s+in\s+(?:using|with)|authenticated\s+(?:using|with)|登录.*(?:使用|通过)).{0,40}ChatGPT\b/i.test(text))finish('ready');
      else finish('error');
    });
    timer=setTimeout(()=>stop('error'),deadlineMs);
  });
}

if(process.argv[1] && (await realpath(path.resolve(process.argv[1])).catch(()=>null)) === fileURLToPath(import.meta.url)) {
  if(process.argv[2]==='--path-only') {
    const executable=await findCodex();
    if(executable)console.log(executable);else process.exitCode=1;
  } else {
    const report=await checkCodexLogin();
    console.log(JSON.stringify(report,null,2));
    if(!report.ok)process.exitCode=1;
  }
}
