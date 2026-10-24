import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectHostModel, redactDetection, configureHost } from '../scripts/configure-host.mjs';

const rootPath=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const fakeKey='test-private-host-key-never-real';
const offline=async()=>{throw Object.assign(new Error('offline'),{cause:{code:'ECONNREFUSED'}});};
function json(data,status=200) {return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});}
async function workspace() {
  const root=await mkdtemp(path.join(os.tmpdir(),'boss-host-config-'));
  await mkdir(path.join(root,'private'));
  const profile='Personal profile content remains unchanged by host model configuration.';
  const config={port:43127,token:'a'.repeat(64),model:{provider:'ollama',model:'old-local-model'}};
  await writeFile(path.join(root,'private','config.json'),JSON.stringify(config),'utf8');
  await writeFile(path.join(root,'private','profile.md'),profile,'utf8');
  return {root,profile,async cleanup(){const absolute=path.resolve(root);assert.ok(absolute.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(absolute).startsWith('boss-host-config-'));await rm(absolute,{recursive:true,force:true});}};
}

test('explicit BOSS configuration wins and redacted output has no key',async()=>{
  const found=await detectHostModel({env:{BOSS_HELPER_PROVIDER:'doubao',BOSS_HELPER_MODEL:'explicit-id',BOSS_HELPER_API_KEY:fakeKey,DEEPSEEK_MODEL:'other',DEEPSEEK_API_KEY:'other-secret'}});
  assert.equal(found.status,'ready');assert.equal(found.settings.provider,'doubao');assert.equal(found.settings.apiKey,fakeKey);
  const output=redactDetection(found);
  assert.equal(output.settings.hasApiKey,true);assert.equal('apiKey' in output.settings,false);
  assert.equal(JSON.stringify(output).includes(fakeKey),false);assert.equal(output.candidates.length,1);
});

test('multiple complete host environments require choice and partial dedicated env does not silently fall through',async()=>{
  const multiple=await detectHostModel({env:{ARK_MODEL:'ark-id',ARK_API_KEY:fakeKey,DEEPSEEK_MODEL:'deep-id',DEEPSEEK_API_KEY:'different-secret'}});
  assert.equal(multiple.status,'ambiguous');assert.equal(multiple.settings,undefined);assert.equal(multiple.candidates.length,2);
  const partial=await detectHostModel({env:{BOSS_HELPER_PROVIDER:'doubao',DEEPSEEK_MODEL:'deep-id',DEEPSEEK_API_KEY:fakeKey}});
  assert.equal(partial.status,'incomplete');assert.ok(partial.missing.includes('model'));
  const noBase=await detectHostModel({env:{OPENAI_MODEL:'model-id',OPENAI_API_KEY:fakeKey}});
  assert.equal(noBase.status,'incomplete');assert.ok(noBase.missing.includes('baseUrl'));
});

test('explicit provider can reuse only its matching env group and accepts API-key-env',async()=>{
  const found=await detectHostModel({provider:'deepseek',model:'real-model-from-host',apiKeyEnv:'CUSTOM_KEY',env:{CUSTOM_KEY:fakeKey,ARK_API_KEY:'wrong-provider',BOSS_HELPER_PROVIDER:'openai-compatible',BOSS_HELPER_BASE_URL:'https://different.example/v1',BOSS_HELPER_API_KEY:'wrong-boss-key'}});
  assert.equal(found.status,'ready');assert.equal(found.settings.baseUrl,'https://api.deepseek.com');assert.equal(found.settings.apiKey,fakeKey);
  const codex=await detectHostModel({provider:'codex',env:{ARK_API_KEY:fakeKey}});
  assert.equal(codex.status,'ready');assert.equal(codex.settings.provider,'codex');assert.equal(codex.settings.apiKey,'');
  const badVariable=await detectHostModel({provider:'doubao',model:'id',apiKeyEnv:'KEY;print',env:{}});
  assert.equal(badVariable.status,'incomplete');assert.ok(badVariable.missing.includes('apiKeyEnv'));
});

test('no keys or guesses are made from consumer login-like or unrelated variables',async()=>{
  const found=await detectHostModel({env:{DEEPSEEK_COOKIE:fakeKey,ARK_LOGIN_TOKEN:fakeKey,SECRET_TOKEN:fakeKey,HOME:'unread'}});
  assert.equal(found.status,'none');
  const unsafe=await detectHostModel({env:{BOSS_HELPER_PROVIDER:'openai-compatible',BOSS_HELPER_MODEL:'id',BOSS_HELPER_BASE_URL:'https://key:'+fakeKey+'@example.test',BOSS_HELPER_API_KEY:fakeKey}});
  assert.equal(unsafe.status,'incomplete');assert.equal(JSON.stringify(redactDetection(unsafe)).includes(fakeKey),false);
});

test('changing endpoint does not forward an inherited key without explicit target consent',async()=>{
  const hostEnv={OPENAI_BASE_URL:'https://original.example/v1',OPENAI_MODEL:'host-model',OPENAI_API_KEY:fakeKey};
  const switched=await detectHostModel({baseUrl:'https://other.example/v1',env:hostEnv});
  assert.equal(switched.status,'incomplete');assert.ok(switched.missing.includes('apiKey'));
  const arkSwitched=await detectHostModel({provider:'doubao',model:'id',baseUrl:'https://gateway.example/v1',env:{ARK_API_KEY:fakeKey}});
  assert.equal(arkSwitched.status,'incomplete');
  const permitted=await detectHostModel({provider:'doubao',model:'id',baseUrl:'https://gateway.example/v1',apiKeyEnv:'ARK_API_KEY',env:{ARK_API_KEY:fakeKey}});
  assert.equal(permitted.status,'ready');assert.equal(permitted.settings.apiKey,fakeKey);
  const dedicated={BOSS_HELPER_PROVIDER:'doubao',BOSS_HELPER_MODEL:'id',BOSS_HELPER_BASE_URL:'https://explicit.example/v1',BOSS_HELPER_API_KEY:fakeKey};
  assert.equal((await detectHostModel({env:dedicated})).status,'ready');
  const changedAgain=await detectHostModel({baseUrl:'https://unexpected.example/v1',env:dedicated});
  assert.equal(changedAgain.status,'incomplete');
  const differentAlias=await detectHostModel({provider:'openai-compatible',baseUrl:'https://unexpected.example/v1',model:'id',env:{BOSS_HELPER_PROVIDER:'deepseek',BOSS_HELPER_API_KEY:fakeKey,BOSS_HELPER_MODEL:'id'}});
  assert.equal(differentAlias.status,'incomplete');
});

test('local discovery is opt-in, GET-only, fixed loopback and unique-model selection',async()=>{
  const calls=[];
  const fetchImpl=async(url,options)=>{calls.push({url,options});return url.includes(':11434/')?json({data:[{id:'installed-model'}]}):json({data:[]});};
  assert.equal((await detectHostModel({env:{},fetchImpl})).status,'none');assert.equal(calls.length,0);
  const local=await detectHostModel({env:{},detectLocal:true,fetchImpl});
  assert.equal(local.status,'ready');assert.equal(local.settings.provider,'ollama');assert.equal(local.settings.model,'installed-model');
  assert.deepEqual(calls.map(call=>call.url).sort(),['http://127.0.0.1:11434/v1/models','http://127.0.0.1:1234/v1/models']);
  for(const call of calls){assert.equal(call.options.method,'GET');assert.equal(call.options.credentials,'omit');assert.equal(call.options.headers.Authorization,undefined);assert.equal(call.options.redirect,'error');assert.equal(call.options.body,undefined);}
  const multiple=await detectHostModel({env:{},detectLocal:true,fetchImpl:async()=>json({data:[{id:'a'},{id:'b'}]})});
  assert.equal(multiple.status,'ambiguous');
});

test('local env detection normalizes Ollama host and dedupes same discovered target',async()=>{
  const found=await detectHostModel({env:{OLLAMA_HOST:'http://127.0.0.1:11434',OLLAMA_MODEL:'local-one'},detectLocal:true,fetchImpl:async url=>json({data:url.includes(':11434/')?[{id:'local-one'}]:[]})});
  assert.equal(found.status,'ready');assert.equal(found.settings.baseUrl,'http://127.0.0.1:11434/v1');assert.equal(found.candidates.length,1);
  const picked=await detectHostModel({provider:'lmstudio',env:{},detectLocal:true,fetchImpl:async url=>json({data:[{id:url.includes(':1234/')?'lm-model':'other-ollama'}]})});
  assert.equal(picked.status,'ready');assert.equal(picked.settings.provider,'lmstudio');
  const binding=await detectHostModel({env:{OLLAMA_HOST:'0.0.0.0:11434',OLLAMA_MODEL:'local-one'}});
  assert.equal(binding.status,'ready');assert.equal(binding.settings.baseUrl,'http://127.0.0.1:11434/v1');
});

test('configure dry-run returns redacted data without touching local files or helper',async()=>{
  const found=await configureHost({root:'does-not-exist',options:{provider:'doubao',model:'id',apiKeyEnv:'ALLOWED_KEY'},env:{ALLOWED_KEY:fakeKey},fetchImpl:async()=>{throw new Error('must not fetch');}});
  assert.equal(found.status,'ready');assert.equal(found.applied,false);assert.equal(JSON.stringify(found).includes(fakeKey),false);
});

test('offline apply preserves profile and pairing while persisting explicitly selected model',async()=>{
  const f=await workspace();
  try {
    const result=await configureHost({root:f.root,options:{provider:'deepseek',model:'configured-id',apiKeyEnv:'MY_KEY',apply:true},env:{MY_KEY:fakeKey},fetchImpl:offline});
    assert.equal(result.applied,true);assert.equal(result.via,'local-file');assert.equal(JSON.stringify(result).includes(fakeKey),false);
    const config=JSON.parse(await readFile(path.join(f.root,'private','config.json'),'utf8'));
    assert.equal(config.model.provider,'openai-compatible');assert.equal(config.model.apiKey,fakeKey);assert.equal(config.token,'a'.repeat(64));
    assert.equal(await readFile(path.join(f.root,'private','profile.md'),'utf8'),f.profile);
  } finally {await f.cleanup();}
});

test('running helper receives authenticated model-only PUT instead of stale file writes',async()=>{
  const f=await workspace(), calls=[];
  try {
    const before=await readFile(path.join(f.root,'private','config.json'),'utf8');
    const result=await configureHost({root:f.root,options:{provider:'doubao',model:'ark-id',apiKeyEnv:'KEY',apply:true},env:{KEY:fakeKey},fetchImpl:async(url,options)=>{calls.push({url,options});return url.endsWith('/api/health')?json({app:'boss-greeting-helper'}):json({model:{provider:'doubao',hasApiKey:true}});}});
    assert.equal(result.via,'running-helper');assert.equal(calls.length,2);assert.equal(calls[1].options.method,'PUT');
    assert.equal(calls[1].options.headers['X-Boss-Helper-Token'],'a'.repeat(64));
    const body=JSON.parse(calls[1].options.body);assert.deepEqual(Object.keys(body),['model']);assert.equal(body.model.apiKey,fakeKey);
    assert.equal(await readFile(path.join(f.root,'private','config.json'),'utf8'),before);
    assert.equal(JSON.stringify(result).includes(fakeKey),false);
  } finally {await f.cleanup();}
});

test('another helper or uncertain health cannot trigger offline overwrite',async()=>{
  const f=await workspace();
  try {
    const before=await readFile(path.join(f.root,'private','config.json'),'utf8');
    for(const fetchImpl of [async()=>json({app:'other'},401),async()=>{throw new Error('temporary timeout '+fakeKey);}]) {
      await assert.rejects(()=>configureHost({root:f.root,options:{provider:'codex',apply:true},env:{},fetchImpl}),cause=>!cause.message.includes(fakeKey));
      assert.equal(await readFile(path.join(f.root,'private','config.json'),'utf8'),before);
    }
  } finally {await f.cleanup();}
});

test('standalone CLI does not echo keys and rejects plaintext --api-key',()=>{
  const cli=path.join(rootPath,'scripts','configure-host.mjs');
  const result=spawnSync(process.execPath,[cli,'--provider','doubao','--model','chosen-id','--api-key-env','MY_HOST_KEY'],{encoding:'utf8',env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,MY_HOST_KEY:fakeKey}});
  assert.equal(result.status,0);assert.equal(result.stdout.includes(fakeKey),false);assert.equal(JSON.parse(result.stdout).settings.hasApiKey,true);
  const rejected=spawnSync(process.execPath,[cli,'--api-key',fakeKey],{encoding:'utf8',env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot}});
  assert.equal(rejected.status,1);assert.equal(rejected.stderr.includes(fakeKey),false);
});
