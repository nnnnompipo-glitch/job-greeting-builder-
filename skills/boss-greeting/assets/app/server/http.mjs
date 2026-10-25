import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

function authorized(actual, expected) {
  if (typeof actual !== 'string') return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req, maxBytes = 262144) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw Object.assign(new Error('需要 JSON 格式'),{status:415});
  let bytes = 0; const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw Object.assign(new Error('提交内容过长'),{status:413});
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('JSON 格式不正确'),{status:400}); }
}

export function createHelperServer({token, queue, profileReady, settings, imports, port = 43127}) {
  return createServer(async (req, res) => {
    const origin = req.headers.origin;
    const host = req.headers.host;
    const reply = (status, body) => {
      res.writeHead(status, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store',
        'X-Content-Type-Options':'nosniff'});
      res.end(JSON.stringify(body));
    };
    if (host !== `127.0.0.1:${port}` || (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin))) {
      reply(403, {error:'仅允许本机配对的扩展访问'}); return;
    }
    if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary','Origin'); }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {'Access-Control-Allow-Methods':'GET, POST, PUT, OPTIONS',
        'Access-Control-Allow-Headers':'Content-Type, X-Boss-Helper-Token', 'Access-Control-Max-Age':'600'});
      res.end(); return;
    }
    if (!authorized(req.headers['x-boss-helper-token'], token)) { reply(401,{error:'配对码不正确，请在扩展设置里重新填写'}); return; }
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (req.method === 'GET' && url.pathname === '/api/health') {
      try { reply(200,{app:'boss-greeting-helper', profileReady: await profileReady(), generator:settings?.model().provider || 'codex', version:3,
        supportedPlatforms:['boss','liepin','zhilian'],preferences:settings?.preferences?.() || {tone:'professional'}}); }
      catch { reply(500,{error:'本地模型配置格式不正确，请检查配置文件'}); }
      return;
    }
    if (settings && req.method === 'GET' && url.pathname === '/api/settings') {
      try { reply(200,await settings.get()); }
      catch { reply(500,{error:'无法读取本地设置，请检查配置文件格式'}); }
      return;
    }
    if (settings && url.pathname === '/api/preferences' && ['GET','PUT'].includes(req.method)) {
      try {
        if (req.method === 'PUT') {
          const preferences=await readJson(req,4096);
          queue.cancelPending?.('语气已更新，请重新检测岗位');
          await settings.update({preferences});
          queue.cancelPending?.('语气已更新，请重新检测岗位');
        }
        reply(200,settings.preferences());
      } catch(error) {reply(error.status || 400,{error:error.publicMessage || (error.code ? '无法保存语气设置' : error.message)});}
      return;
    }
    if (imports && req.method === 'POST' && url.pathname === '/api/imports') {
      try {reply(200,await imports.submit(await readJson(req,36*1024*1024)));}
      catch(error) {reply(error.status || 400,{error:error.publicMessage || '文件无法导入，请检查格式、文件大小和本机识别组件'});}
      return;
    }
    if (imports && req.method === 'GET' && /^\/api\/imports\/[\w-]+$/.test(url.pathname)) {
      const task=imports.get(url.pathname.split('/').at(-1));
      reply(task?200:404,task || {error:'识别结果已过期，请重新选择文件'});return;
    }
    if (settings && ((req.method === 'PUT' && url.pathname === '/api/settings') || (req.method === 'POST' && url.pathname === '/api/model/test'))) {
      try {
        const body = await readJson(req);
        let result;
        if (url.pathname === '/api/settings') {
          queue.cancelPending?.();
          result = await settings.update(body);
          queue.cancelPending?.();
        } else result = await settings.test(body);
        reply(200,result);
      } catch(error) { reply(error.status || 400,{error:error.publicMessage || (error.code ? '无法保存本地设置，请检查目录写入权限' : error.message)}); }
      return;
    }
    if (req.method === 'GET' && /^\/api\/jobs\/[\w-]+$/.test(url.pathname)) {
      const record = queue.get(url.pathname.split('/').at(-1));
      reply(record ? 200 : 404, record || {error:'岗位结果已过期，请重新生成'}); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/jobs') {
      try {
        const result = await queue.submit(await readJson(req,100000));
        reply(200,result);
      } catch (error) { reply(error.status || 400,{error:error.publicMessage || error.message}); }
      return;
    }
    reply(404,{error:'接口不存在'});
  });
}
