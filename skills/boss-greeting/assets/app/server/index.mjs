import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JobQueue } from './core.mjs';
import { createHelperServer } from './http.mjs';
import { generateGreeting } from './model.mjs';
import { SettingsStore } from './settings.mjs';
import { DocumentImportManager } from './imports.mjs';
import { prepareInstallation } from '../scripts/install.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(root,'private/config.json');
const {config} = await prepareInstallation(root);
const settings = new SettingsStore({root,config,configPath});
const imports = new DocumentImportManager({root});
const queue = new JobQueue({loadContext:()=>settings.context(),generate:(job,profile,context) => generateGreeting(job,profile,context.config)});
const server = createHelperServer({token:config.token,queue,profileReady:()=>settings.ready(),settings,imports,port:config.port});
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? '端口43127已使用，请检查助手是否已启动' : '本地服务启动失败'); process.exitCode = 1; });
server.listen(config.port,'127.0.0.1',() => console.log('BOSS招呼语助手已启动，仅监听127.0.0.1:43127。配对码保存在private/pairing.txt。'));
function shutdown() { queue.close(); imports.close(); server.close(); }
process.on('SIGINT',shutdown); process.on('SIGTERM',shutdown);
