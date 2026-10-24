import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { buildPrompt, validateResult } from './core.mjs';
import { generateWithProvider } from './providers.mjs';

function publicError(message) { return Object.assign(new Error(message), {publicMessage:message}); }

export function classifyFailure(stderr) {
  if (/not logged in|unauthori[sz]ed|authentication|\b401\b/i.test(stderr)) return 'Codex 登录不可用，请先在 Codex 中重新登录后重启助手';
  if (/usage limit|rate limit|quota|\b429\b/i.test(stderr)) return 'Codex 当前额度或频率受限，请稍后重试';
  if (/unknown configuration|unrecognized|unexpected argument/i.test(stderr)) return 'Codex 版本与助手参数不兼容，需要更新启动参数';
  if (/timed out|timeout|stream disconnected|connection|\bDNS\b/i.test(stderr)) return 'Codex 网络连接失败，请检查网络后重试';
  return 'Codex 未能生成草稿，请检查登录状态和网络后重试';
}

export function codexArguments(isolatedDir, schemaPath, useDaemon = false) {
  return [
    ...(!useDaemon ? ['--no-daemon'] : []), '-a','never','exec',
    '--ignore-user-config','--ignore-rules','--ephemeral','--skip-git-repo-check',
    '--sandbox','read-only','--strict-config','-C',isolatedDir,'--output-schema',schemaPath,
    ...['shell_tool','apps','plugins','hooks','multi_agent','browser_use','computer_use','image_generation',
      'code_mode_host','tool_suggest','view_image','shell_snapshot'].flatMap(key => ['-c',`features.${key}=false`]),
    '-c','web_search="disabled"','-'
  ];
}

export async function generateGreeting(job, profile, config) {
  if (config.model?.provider && config.model.provider !== 'codex') return generateWithProvider(job,profile,config);
  const isolatedDir = path.join(config.root,'private','model-workspace');
  await mkdir(isolatedDir,{recursive:true});
  const env = {...process.env};
  for (const key of Object.keys(env)) if (/^CODEX_/i.test(key) && key !== 'CODEX_HOME') delete env[key];
  const proxy = config.proxyUrl || config.systemProxyUrl;
  if (proxy) {
    for (const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy']) env[key] = proxy;
    env.NO_PROXY = env.no_proxy = [...new Set(['127.0.0.1','localhost',...(env.NO_PROXY || env.no_proxy || '').split(',')])].filter(Boolean).join(',');
  }
  const args = codexArguments(isolatedDir,path.join(config.root,'server','greeting.schema.json'),config.useDaemon);
  const child = spawn(config.codexPath || process.env.BOSS_CODEX_PATH || 'codex',args,{
    cwd:isolatedDir,env,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']
  });
  let output = '', diagnostic = '', timedOut = false, tooLarge = false;
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data',data => { output += data; if (output.length > 40000) {tooLarge = true; child.kill();} });
  // stderr may echo personal inputs; keep only a short memory buffer, never log it.
  child.stderr.on('data',data => { diagnostic = (diagnostic + data).slice(-12000); });
  const deadline = setTimeout(() => {timedOut = true; child.kill();},config.model?.timeoutMs || config.timeoutMs || 120000);
  const done = new Promise((resolve,reject) => {
    child.once('error',error => reject(publicError(error.code === 'ENOENT' ? '找不到 Codex 命令行，请重新运行启动助手' : '无法启动 Codex 生成进程')));
    child.once('close',code => resolve(code));
  });
  child.stdin.on('error',() => {});
  child.stdin.end(buildPrompt(job,profile),'utf8');
  try {
    const code = await done;
    if (timedOut) throw publicError('Codex 生成超时，请检查网络后点击重新生成');
    if (tooLarge) throw publicError('生成内容异常，已停止本次任务');
    if (code !== 0) throw publicError(classifyFailure(diagnostic));
    try { return validateResult(JSON.parse(output.trim())); }
    catch { throw publicError('生成结果格式异常，请点击重新生成'); }
  } finally { clearTimeout(deadline); output = ''; diagnostic = ''; }
}
