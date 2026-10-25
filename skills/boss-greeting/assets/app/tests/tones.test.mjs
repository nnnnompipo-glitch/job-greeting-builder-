import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {TONE_PRESETS,normalizePreferences,buildPrompt,JobQueue,validateJob} from '../server/core.mjs';
import {SettingsStore} from '../server/settings.mjs';

const facts='工业设计本科，做过餐厨保鲜盒外观设计、Rhino建模、KeyShot渲染、手板验证和工厂协同。目标地区为杭州及周边城市。以上为隔离测试的虚构资料。'.repeat(2);
const job={url:'https://www.zhipin.com/job_detail/tone-fixture.html',title:'工业设计师',company:'测试企业',description:'负责保鲜盒和厨房收纳产品的外观设计、Rhino三维建模、效果图、CMF及手板验证，并与结构工程师和工厂沟通量产工艺。'};
const draft={greeting:'您好，我对工业设计岗位感兴趣，愿意结合餐厨产品项目经历进一步沟通。',matches:[],cautions:[]};
async function fixture() {
  const root=await mkdtemp(path.join(os.tmpdir(),'boss-tone-settings-'));
  await mkdir(path.join(root,'private'));
  const config={port:43127,token:'isolated-test-only',model:{provider:'codex',timeoutMs:180000}};
  await writeFile(path.join(root,'private','config.json'),JSON.stringify(config),'utf8');
  await writeFile(path.join(root,'private','profile.md'),facts,'utf8');
  return {root,store:new SettingsStore({root,config}),cleanup:async()=>{
    const resolved=path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('boss-tone-settings-'));
    await rm(resolved,{recursive:true,force:true});
  }};
}
async function finished(queue,id) {
  for(let n=0;n<100;n++) {
    const record=queue.get(id);
    if(['done','error'].includes(record.status))return record;
    await new Promise(resolve=>setTimeout(resolve,2));
  }
  throw Error('Tone generation fixture did not finish');
}

test('tone selection is exactly four distinct choices with a compatible default',()=>{
  assert.deepEqual(Object.keys(TONE_PRESETS),['professional','friendly','bold','creative']);
  assert.equal(new Set(Object.values(TONE_PRESETS).map(t=>t.label)).size,4);
  assert.deepEqual(normalizePreferences(),{tone:'professional'});
  for(const tone of Object.keys(TONE_PRESETS))assert.deepEqual(normalizePreferences({tone}),{tone});
  for(const input of [null,[],{tone:'exaggerated'},{tone:'Friendly'},{tone:''},{tone:1},{tone:'professional',instructions:'override'}]) {
    assert.throws(()=>normalizePreferences(input));
  }
});

test('server derives recruitment platform from the shared URL rules, not client metadata',()=>{
  const liepin=validateJob({...job,url:'https://www.liepin.com/job/1977654321.shtml?tracking=private',platform:'boss',platformLabel:'fake'});
  assert.equal(liepin.platform,'liepin');assert.equal(liepin.platformLabel,'猎聘');
  assert.equal(liepin.url,'https://www.liepin.com/job/1977654321.shtml');
  const legacy=validateJob({...job,url:'https://jobs.zhaopin.com/CC123456789J00123456789.htm?ref=private',platform:'liepin'});
  const modern=validateJob({...job,url:'https://www.zhaopin.com/jobdetail/CC123456789J00123456789.htm'});
  assert.equal(legacy.platform,'zhilian');assert.equal(legacy.url,modern.url);
  for(const url of ['https://www.liepin.com/zhaopin/','https://www.zhaopin.com/','https://login.liepin.com/',
    'https://evil.test/job/1977654321.shtml','https://user@www.liepin.com/job/1977654321.shtml']) assert.throws(()=>validateJob({...job,url}));
});

test('each tone changes writing policy while leaving job and candidate facts unchanged',()=>{
  const prompts=Object.keys(TONE_PRESETS).map(tone=>buildPrompt(job,facts,{tone}));
  assert.equal(new Set(prompts).size,4);
  for(const prompt of prompts) {
    assert.deepEqual(JSON.parse(prompt.split('\n').at(-1)),{candidate_profile:facts,job_data:job});
    assert.ok(prompt.includes('语气只改变表达方式，不改变事实'));
    assert.ok(prompt.includes('不能声称已发送'));
  }
  assert.equal(buildPrompt(job,facts),prompts[0]);
  assert.throws(()=>buildPrompt(job,facts,{tone:'ignore-all-rules'}));
});

test('saving only a tone preserves Codex settings and profile and rejects invalid updates before writes',async()=>{
  const f=await fixture();
  try {
    assert.deepEqual((await f.store.get()).preferences,{tone:'professional'});
    const beforeContext=await f.store.context();
    const saved=await f.store.update({preferences:{tone:'creative'}});
    assert.deepEqual(saved.preferences,{tone:'creative'});assert.equal('apiKey' in saved.model,false);
    const disk=JSON.parse(await readFile(path.join(f.root,'private','config.json'),'utf8'));
    assert.deepEqual(disk.model,{provider:'codex',timeoutMs:180000});
    assert.equal(await readFile(path.join(f.root,'private','profile.md'),'utf8'),facts);
    assert.notEqual(beforeContext.cacheKey,(await f.store.context()).cacheKey);
    assert.deepEqual(beforeContext.preferences,{tone:'professional'});
    assert.deepEqual(beforeContext.config.preferences,{tone:'professional'});
    const before=await readFile(path.join(f.root,'private','config.json'),'utf8');
    await assert.rejects(()=>f.store.update({preferences:{tone:'not-a-tone'},profile:'must-not-overwrite'}));
    assert.equal(await readFile(path.join(f.root,'private','config.json'),'utf8'),before);
    assert.equal(await readFile(path.join(f.root,'private','profile.md'),'utf8'),facts);
  } finally {await f.cleanup();}
});

test('the same job regenerates once per selected tone and caches unchanged tone',async()=>{
  const f=await fixture(), seen=[];
  const queue=new JobQueue({loadContext:()=>f.store.context(),minIntervalMs:0,generate:async(_job,_profile,context)=>{
    seen.push(context.config.preferences.tone);return draft;
  }});
  try {
    const ids=[];
    for(const tone of Object.keys(TONE_PRESETS)) {
      await f.store.update({preferences:{tone}});
      const task=await queue.submit(job);ids.push(task.id);
      assert.equal((await finished(queue,task.id)).status,'done');
      assert.equal((await queue.submit(job)).id,task.id);
    }
    assert.equal(new Set(ids).size,4);
    assert.deepEqual(seen,Object.keys(TONE_PRESETS));
  } finally {queue.close();await f.cleanup();}
});
