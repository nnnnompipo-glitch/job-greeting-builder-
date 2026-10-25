import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {SettingsStore,isProfileReady} from '../server/settings.mjs';
import {JobQueue} from '../server/core.mjs';
import {createHelperServer} from '../server/http.mjs';

const profile='测试候选人为工业设计本科，有餐厨产品外观、Rhino建模、KeyShot渲染及工厂打样沟通经历。目标地区为杭州及周边城市。本段为隔离测试的虚构事实资料。'.repeat(2);
const job={url:'https://www.zhipin.com/job_detail/settings-test.html',title:'工业设计师',company:'测试企业',description:'负责厨房收纳用品的工业设计，进行用户调研、三维建模、外观方案和打样，并与工厂沟通生产工艺。'};
async function fixture({checkCodex}={}){
  const root=await mkdtemp(path.join(os.tmpdir(),'boss-helper-settings-'));
  await mkdir(path.join(root,'private'));
  const config={port:43127,token:'test-token-not-real',codexPath:'/test/codex.exe'};
  await writeFile(path.join(root,'private','config.json'),JSON.stringify(config),'utf8');
  await writeFile(path.join(root,'private','profile.md'),profile,'utf8');
  return {root,store:new SettingsStore({root,config,checkCodex}),cleanup:async()=>{
    const absolute=path.resolve(root);
    assert.ok(absolute.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(absolute).startsWith('boss-helper-settings-'));
    await rm(absolute,{recursive:true,force:true});
  }};
}

test('legacy Codex config stays usable and saving never stores another model or API key',async()=>{
  const f=await fixture();
  try{
    assert.equal((await f.store.get()).model.provider,'codex');
    const before=await readFile(path.join(f.root,'private/config.json'),'utf8');
    for(const model of [{provider:'doubao',apiKey:'must-never-echo'},{provider:'ollama',model:'local'},{provider:'codex',apiKey:'must-never-echo'}]){
      await assert.rejects(()=>f.store.update({model,profile:'must-not-overwrite'}),error=>!error.message.includes('must-never-echo'));
    }
    assert.equal(await readFile(path.join(f.root,'private/config.json'),'utf8'),before);
    assert.equal(await readFile(path.join(f.root,'private/profile.md'),'utf8'),profile);
    const saved=await f.store.update({model:{provider:'codex',timeoutMs:180000},profile});
    assert.equal(saved.model.provider,'codex');assert.equal(saved.model.hasApiKey,false);assert.equal('apiKey'in saved.model,false);
    assert.equal(saved.profileReady,true);
    assert.equal(JSON.parse(await readFile(path.join(f.root,'private/config.json'),'utf8')).model.apiKey,'');
  }finally{await f.cleanup();}
});

test('old HTTP configuration cannot be read as a valid connection or silently generate',async()=>{
  const f=await fixture();
  try{
    f.store.config.model={provider:'doubao',apiKey:'old-test-secret',model:'old'};
    await assert.rejects(()=>f.store.get(),error=>!error.message.includes('old-test-secret'));
    await assert.rejects(()=>f.store.context(),/统一使用 Codex/);
    const reset=await f.store.update({model:{provider:'codex'}});
    assert.equal(reset.model.provider,'codex');assert.equal(reset.model.hasApiKey,false);
    assert.equal(JSON.stringify(reset).includes('old-test-secret'),false);
  }finally{await f.cleanup();}
});

test('placeholder profile still blocks generation and invalid updates do not overwrite facts',async()=>{
  const f=await fixture();
  try{
    const saved=await f.store.update({model:{provider:'codex'},profile:'<!-- PROFILE_NOT_CONFIGURED -->\n'+profile});
    assert.equal(saved.profileReady,false);await assert.rejects(()=>f.store.context(),/真实资料/);
    assert.equal(isProfileReady('short'),false);
    const before=await f.store.get();
    await assert.rejects(()=>f.store.update({model:{provider:'unknown'},profile:'bad overwrite'}));
    assert.equal((await f.store.get()).profile,before.profile);
  }finally{await f.cleanup();}
});

test('Codex timeout and profile changes update cache without mutating frozen request context',async()=>{
  const f=await fixture(),seen=[];
  const queue=new JobQueue({loadContext:()=>f.store.context(),minIntervalMs:0,generate:async(_job,_profile,context)=>{
    seen.push(context.config.model.timeoutMs);return {greeting:'您好，希望进一步了解工业设计岗位。',matches:[],cautions:[]};
  }});
  try{
    const first=await queue.submit(job);await new Promise(resolve=>setTimeout(resolve,10));
    const before=await f.store.context();
    await f.store.update({model:{provider:'codex',timeoutMs:180000}});
    const second=await queue.submit(job);await new Promise(resolve=>setTimeout(resolve,10));
    assert.notEqual(first.id,second.id);assert.deepEqual(seen,[120000,180000]);
    assert.equal(before.config.model.timeoutMs,120000);assert.notEqual(before.cacheKey,(await f.store.context()).cacheKey);
  }finally{queue.close();await f.cleanup();}
});

test('connection check reports real Codex login status without a model request or profile',async()=>{
  let received;const status={ok:false,status:'not-logged-in',message:'请使用 ChatGPT 账号登录 Codex'};
  const f=await fixture({checkCodex:async input=>{received=input;return status;}});
  try{
    assert.deepEqual(await f.store.test({model:{provider:'codex'}}),status);
    assert.equal(received.codexPath,'/test/codex.exe');assert.equal('profile'in received,false);
    await assert.rejects(()=>f.store.test({model:{provider:'doubao',apiKey:'not-real'}}),/统一使用 Codex/);
  }finally{await f.cleanup();}
});

test('settings API remains paired, exposes only Codex, and rejects HTTP model reconfiguration',async()=>{
  const f=await fixture(),port=45100+Math.floor(Math.random()*1000);
  let cancelled=0;
  const server=createHelperServer({token:'http-test-token',settings:f.store,queue:{cancelPending(){cancelled++;}},profileReady:()=>f.store.ready(),port});
  server.listen(port,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${port}`,headers={'Content-Type':'application/json','X-Boss-Helper-Token':'http-test-token'};
  try{
    assert.equal((await fetch(base+'/api/settings')).status,401);
    const rejected=await fetch(base+'/api/settings',{method:'PUT',headers,body:JSON.stringify({model:{provider:'doubao',apiKey:'never-echo-test'},profile:'must-not-save'})});
    assert.equal(rejected.status,400);assert.equal((await rejected.text()).includes('never-echo-test'),false);
    const accepted=await fetch(base+'/api/settings',{method:'PUT',headers,body:JSON.stringify({model:{provider:'codex',timeoutMs:180000},profile})});
    assert.equal(accepted.status,200);assert.ok(cancelled>=2);
    const saved=await(await fetch(base+'/api/settings',{headers})).json();
    assert.equal(saved.model.provider,'codex');assert.equal(saved.model.hasApiKey,false);assert.equal('apiKey'in saved.model,false);
    const health=await(await fetch(base+'/api/health',{headers})).json();assert.equal(health.generator,'codex');
    const preflight=await fetch(base+'/api/settings',{method:'OPTIONS',headers:{Origin:'chrome-extension://'+'a'.repeat(32)}});
    assert.ok(preflight.headers.get('Access-Control-Allow-Methods').includes('PUT'));
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await f.cleanup();}
});
