import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { SettingsStore, isProfileReady } from '../server/settings.mjs';
import { JobQueue } from '../server/core.mjs';
import { createHelperServer } from '../server/http.mjs';

const profile = '测试候选人为工业设计本科，有餐厨产品外观、Rhino建模、KeyShot渲染及工厂打样沟通经历。目标地区为杭州及周边城市。本段为隔离测试的虚构事实资料。'.repeat(2);
const job = {url:'https://www.zhipin.com/job_detail/settings-test.html',title:'工业设计师',company:'测试企业',description:'负责厨房收纳用品的工业设计，进行用户调研、三维建模、外观方案和打样，并与工厂沟通生产工艺。'};
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(),'boss-helper-settings-'));
  await mkdir(path.join(root,'private'));
  const config = {port:43127,token:'test-token-not-real',codexPath:'codex'};
  await writeFile(path.join(root,'private','config.json'),JSON.stringify(config),'utf8');
  await writeFile(path.join(root,'private','profile.md'),profile,'utf8');
  return {root,store:new SettingsStore({root,config}),cleanup:async()=>{
    const absolute = path.resolve(root);
    assert.ok(absolute.startsWith(path.resolve(os.tmpdir())+path.sep) && path.basename(absolute).startsWith('boss-helper-settings-'));
    await rm(absolute,{recursive:true,force:true});
  }};
}

test('legacy config preserves Codex and settings read never reveals API keys',async()=>{
  const f = await fixture();
  try {
    assert.equal((await f.store.get()).model.provider,'codex');
    const result = await f.store.update({model:{provider:'doubao',model:'test-model',apiKey:'test-only-secret'},profile});
    assert.equal(result.model.hasApiKey,true);
    assert.equal(JSON.stringify(result).includes('test-only-secret'),false);
    assert.equal(result.profileReady,true);
    assert.equal(JSON.parse(await readFile(path.join(f.root,'private','config.json'),'utf8')).model.apiKey,'test-only-secret');
  } finally {await f.cleanup();}
});

test('key preservation is bound to same provider AND endpoint, clear is explicit',async()=>{
  const f = await fixture();
  try {
    await f.store.update({model:{provider:'openai-compatible',baseUrl:'https://one.example/v1',model:'first',apiKey:'private-test-key'}});
    const same = f.store.prepareModel({provider:'openai-compatible',baseUrl:'https://one.example/v1/',model:'second'});
    assert.equal(same.apiKey,'private-test-key');
    const changed = f.store.prepareModel({provider:'openai-compatible',baseUrl:'https://two.example/v1',model:'second'});
    assert.equal(changed.apiKey,'');
    const local = f.store.prepareModel({provider:'ollama',model:'local-model'});
    assert.equal(local.apiKey,'');
    const cleared = f.store.prepareModel({provider:'openai-compatible',baseUrl:'https://one.example/v1',model:'second',clearApiKey:true});
    assert.equal(cleared.apiKey,'');
  } finally {await f.cleanup();}
});

test('portable model may be saved incomplete, but placeholder profile cannot generate',async()=>{
  const f = await fixture();
  try {
    const result = await f.store.update({model:{provider:'ollama',model:''},profile:'<!-- PROFILE_NOT_CONFIGURED -->\n'+profile});
    assert.equal(result.model.provider,'ollama'); assert.equal(result.profileReady,false);
    await assert.rejects(()=>f.store.context(),/真实资料/);
    assert.equal(isProfileReady('short'),false);
    const before = await f.store.get();
    await assert.rejects(()=>f.store.update({model:{provider:'unknown'},profile:'bad overwrite'}));
    assert.equal((await f.store.get()).profile,before.profile);
  } finally {await f.cleanup();}
});

test('model and profile updates change cache and freeze each queued request configuration',async()=>{
  const f = await fixture(); const seen = [];
  const queue = new JobQueue({loadContext:()=>f.store.context(),minIntervalMs:0,generate:async(_job,_profile,context)=>{
    seen.push(context.config.model.provider);
    return {greeting:'您好，想进一步了解工业设计岗位。',matches:[],cautions:[]};
  }});
  try {
    const first = await queue.submit(job); await new Promise(resolve=>setTimeout(resolve,10));
    await f.store.update({model:{provider:'ollama',model:'mock-local'}});
    const second = await queue.submit(job); await new Promise(resolve=>setTimeout(resolve,10));
    assert.notEqual(first.id,second.id); assert.deepEqual(seen,['codex','ollama']);
    const state = await f.store.context();
    await f.store.update({model:{provider:'lmstudio',model:'other-local'}});
    assert.equal(state.config.model.provider,'ollama');
    assert.notEqual(state.cacheKey,(await f.store.context()).cacheKey);
  } finally {queue.close(); await f.cleanup();}
});

test('settings HTTP API requires pairing, permits authenticated PUT, and redacts key',async()=>{
  const f = await fixture(), port = 45100+Math.floor(Math.random()*1000);
  const server = createHelperServer({token:'http-test-token',settings:f.store,queue:{},profileReady:()=>f.store.ready(),port});
  server.listen(port,'127.0.0.1'); await once(server,'listening');
  const base = `http://127.0.0.1:${port}`, headers = {'Content-Type':'application/json','X-Boss-Helper-Token':'http-test-token'};
  try {
    assert.equal((await fetch(base+'/api/settings')).status,401);
    const response = await fetch(base+'/api/settings',{method:'PUT',headers,body:JSON.stringify({model:{provider:'doubao',model:'mock',apiKey:'never-echo-test'},profile})});
    assert.equal(response.status,200);
    assert.equal((await response.text()).includes('never-echo-test'),false);
    const saved = await (await fetch(base+'/api/settings',{headers})).json();
    assert.equal(saved.model.hasApiKey,true); assert.equal('apiKey' in saved.model,false);
    const health = await (await fetch(base+'/api/health',{headers})).json();
    assert.equal(health.generator,'doubao');
    const preflight = await fetch(base+'/api/settings',{method:'OPTIONS',headers:{Origin:'chrome-extension://'+'a'.repeat(32)}});
    assert.ok(preflight.headers.get('Access-Control-Allow-Methods').includes('PUT'));
  } finally {server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); await f.cleanup();}
});

test('saving local-model settings cancels an old pending cloud request',async()=>{
  const f = await fixture(); let release; const calls = [];
  await f.store.update({model:{provider:'doubao',model:'cloud-fixture',apiKey:'fixture-not-real'}});
  const queue = new JobQueue({loadContext:()=>f.store.context(),minIntervalMs:0,generate:async(_job,_profile,context)=>{
    calls.push(context.config.model.provider);
    if (calls.length === 1) await new Promise(resolve=>{release=resolve;});
    return {greeting:'您好，希望进一步了解贵司工业设计岗位。',matches:[],cautions:[]};
  }});
  const port = 46200+Math.floor(Math.random()*1000);
  const server = createHelperServer({token:'switch-test',settings:f.store,queue,profileReady:()=>f.store.ready(),port});
  server.listen(port,'127.0.0.1'); await once(server,'listening');
  try {
    const first = await queue.submit(job);
    for(let n=0;!release && n<100;n++) await new Promise(resolve=>setTimeout(resolve,2));
    assert.equal(typeof release,'function');
    const pending = await queue.submit({...job,title:'第二个排队岗位'});
    const response = await fetch(`http://127.0.0.1:${port}/api/settings`,{method:'PUT',headers:{'Content-Type':'application/json','X-Boss-Helper-Token':'switch-test'},body:JSON.stringify({model:{provider:'ollama',model:'local-fixture'}})});
    assert.equal(response.status,200);
    assert.equal(queue.get(pending.id).status,'error');
    release();
    for(let n=0;queue.get(first.id).status === 'running' && n<100;n++) await new Promise(resolve=>setTimeout(resolve,2));
    assert.deepEqual(calls,['doubao']);
    const local = await queue.submit({...job,title:'第三个本地岗位'});
    for(let n=0;queue.get(local.id).status !== 'done' && n<100;n++) await new Promise(resolve=>setTimeout(resolve,2));
    assert.deepEqual(calls,['doubao','ollama']);
  } finally {release?.();queue.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await f.cleanup();}
});
