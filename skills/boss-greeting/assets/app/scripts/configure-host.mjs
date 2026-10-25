import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { checkCodexLogin } from './codex.mjs';

function failure(message) { return Object.assign(new Error(message),{publicMessage:message}); }

// A read-only diagnostic entrypoint retained for existing installations.
export async function detectHostModel(options={}) {
  if ((options.provider && options.provider !== 'codex') || options.apiKeyEnv || options.baseUrl || options.model || options.detectLocal) {
    throw failure('此版本统一使用 Codex 的 ChatGPT 登录，不再检测或连接其他模型');
  }
  const check=options.checkLogin || checkCodexLogin;
  return redactDetection(await check({codexPath:options.codexPath,env:options.env || process.env}));
}

export function redactDetection(result={}) {
  return {ok:result.ok===true,status:typeof result.status==='string'?result.status:'error',
    message:typeof result.message==='string'?result.message:'无法确认 Codex 登录状态',
    ...(typeof result.codexPath==='string'?{codexPath:result.codexPath}:{})};
}

export async function configureHost({options={},env=process.env}={}) {
  if (options.apply) throw failure('不再写入模型接口设置，请运行 install.mjs --start；登录使用 codex login');
  return detectHostModel({...options,env});
}

if(process.argv[1] && (await realpath(path.resolve(process.argv[1])).catch(()=>null))===fileURLToPath(import.meta.url)) {
  try {
    const {values}=parseArgs({options:{help:{type:'boolean'},provider:{type:'string'}},strict:true,allowPositionals:false});
    if(values.help) console.log('node scripts/configure-host.mjs：只检查 Codex 安装和 ChatGPT 登录，不读取任何模型 API Key。');
    else console.log(JSON.stringify(await detectHostModel({provider:values.provider}),null,2));
  }catch(error){console.error(error.publicMessage || '只支持 Codex 登录检查；其他模型与 API Key 参数已移除');process.exitCode=1;}
}
