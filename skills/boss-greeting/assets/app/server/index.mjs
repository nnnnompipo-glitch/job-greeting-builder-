import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JobQueue } from './core.mjs';
import { createHelperServer } from './http.mjs';
import { generateGreeting } from './model.mjs';
import { SettingsStore } from './settings.mjs';
import { DocumentImportManager } from './imports.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const privateDir = path.join(root, 'private');
await mkdir(privateDir, {recursive:true});
const configPath = path.join(privateDir,'config.json');
let config;
try { config = JSON.parse(await readFile(configPath,'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  let defaults = {};
  try { defaults = JSON.parse(await readFile(path.join(root,'templates','config.default.json'),'utf8')); }
  catch(defaultError) { if (defaultError.code !== 'ENOENT') throw defaultError; }
  config = {...defaults,port:43127, token: randomBytes(32).toString('hex'), codexPath:'codex', timeoutMs:120000};
  await writeFile(configPath,JSON.stringify(config,null,2),'utf8');
}
if (config.port !== 43127 || !/^[a-f0-9]{64}$/.test(config.token)) throw new Error('本地配置格式不正确');
await writeFile(path.join(privateDir,'pairing.txt'),config.token,'utf8');
const profilePath = path.join(privateDir,'profile.md');
try { await readFile(profilePath,'utf8'); }
catch(error) {
  if (error.code !== 'ENOENT') throw error;
  try { await writeFile(profilePath,await readFile(path.join(root,'templates','profile.example.md'),'utf8'),'utf8'); }
  catch(templateError) { if (templateError.code !== 'ENOENT') throw templateError; }
}
const settings = new SettingsStore({root,config,configPath});
const imports = new DocumentImportManager({root});
const queue = new JobQueue({loadContext:()=>settings.context(),generate:(job,profile,context) => generateGreeting(job,profile,context.config)});
const server = createHelperServer({token:config.token,queue,profileReady:()=>settings.ready(),settings,imports,port:config.port});
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? '端口43127已使用，请检查助手是否已启动' : '本地服务启动失败'); process.exitCode = 1; });
server.listen(config.port,'127.0.0.1',() => console.log('BOSS招呼语助手已启动，仅监听127.0.0.1:43127。配对码保存在private/pairing.txt。'));
function shutdown() { queue.close(); imports.close(); server.close(); }
process.on('SIGINT',shutdown); process.on('SIGTERM',shutdown);
