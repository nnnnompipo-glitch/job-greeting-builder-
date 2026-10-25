import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { findCodex, checkCodexLogin } from '../scripts/codex.mjs';

async function fixture(callback) {
  const root=await mkdtemp(path.join(os.tmpdir(),'job-helper-codex-test-'));
  const file=async relative=>{const filename=path.join(root,relative);await mkdir(path.dirname(filename),{recursive:true});await writeFile(filename,'fixture executable');return realpath(filename);};
  try{return await callback({root,file});}finally{
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('job-helper-codex-test-'));
    await rm(root,{recursive:true,force:true});
  }
}

test('Codex discovery respects explicit/env/PATH order without opening login files',async()=>fixture(async({root,file})=>{
  const explicit=await file('explicit/codex.exe'),configured=await file('configured/codex.exe'),fromPath=await file('path/codex.exe');
  const env={BOSS_CODEX_PATH:configured,PATH:path.dirname(fromPath),LOCALAPPDATA:path.join(root,'local')};
  assert.equal(await findCodex({codexPath:explicit,env,platform:'win32'}),explicit);
  assert.equal(await findCodex({env,platform:'win32'}),configured);
  assert.equal(await findCodex({env:{...env,BOSS_CODEX_PATH:''},platform:'win32'}),fromPath);
  assert.equal(await findCodex({env:{PATH:''},platform:'win32'}),null);
}));

test('Codex discovery resolves desktop and npm native binaries rather than cmd wrappers',async()=>fixture(async({root,file})=>{
  const desktop=await file('local/OpenAI/Codex/bin/version/codex.exe');
  assert.equal(await findCodex({env:{LOCALAPPDATA:path.join(root,'local')},platform:'win32'}),desktop);
  const wrapper=await file('npm/codex.cmd');
  const native=await file('npm/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/codex/codex.exe');
  assert.equal(await findCodex({codexPath:wrapper,env:{},platform:'win32',arch:'x64'}),native);
  assert.equal(await findCodex({env:{PATH:path.dirname(wrapper)},platform:'win32',arch:'x64'}),native);
  assert.equal(await findCodex({codexPath:wrapper,env:{},platform:'win32',arch:'arm64'}),null);
}));

test('Codex discovery finds a new standalone Windows install before PATH refresh',async()=>fixture(async({root,file})=>{
  const standalone=await file('local/Programs/OpenAI/Codex/bin/codex.exe');
  assert.equal(await findCodex({env:{LOCALAPPDATA:path.join(root,'local'),PATH:''},platform:'win32'}),standalone);
}));

test('Codex discovery returns the canonical executable through a directory alias',async()=>fixture(async({root,file})=>{
  const native=await file('real-install/codex.exe');
  const alias=path.join(root,'install alias');
  await symlink(path.dirname(native),alias,process.platform==='win32'?'junction':'dir');
  assert.equal(await findCodex({codexPath:path.join(alias,'codex.exe'),env:{},platform:'win32'}),native);
}));

function fakeSpawn({output='',code=0,neverExit=false,error,lateOutput=false}={}) {
  let killed=0,invocation,child;
  const spawnImpl=(executable,args,options)=>{
    invocation={executable,args,options};
    child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.kill=()=>{killed++;return true;};
    queueMicrotask(()=>{
      if(error){child.emit('error',error);return;}
      if(lateOutput)child.emit('exit',code);
      child.stderr.write(output);
      if(!neverExit){if(!lateOutput)child.emit('exit',code);child.emit('close',code);}
    });
    return child;
  };
  return {spawnImpl,get killed(){return killed;},get invocation(){return invocation;},get child(){return child;}};
}
const nativePath=path.resolve('fixture-codex.exe');
const locator=async()=>nativePath;

test('Codex login check positively recognizes ChatGPT and never returns command output',async()=>{
  const fake=fakeSpawn({output:'Logged in using ChatGPT\nsecret_should_not_appear'});
  const status=await checkCodexLogin({spawnImpl:fake.spawnImpl,findCodexImpl:locator,env:{SAFE:'value'}});
  assert.equal(status.status,'ready');assert.equal(status.ok,true);
  assert.deepEqual(fake.invocation.args,['login','status']);
  assert.equal(fake.invocation.options.shell,false);assert.equal(fake.invocation.options.windowsHide,true);
  assert.equal(JSON.stringify(status).includes('secret_should_not_appear'),false);
  assert.equal(fake.child.stdout.destroyed,true);assert.equal(fake.child.stderr.destroyed,true);
});

test('Codex login check rejects API Key auth and ambiguous successful status',async()=>{
  for(const [output,expected] of [['Logged in using an API key - sk-secret','api-key-login'],['Authenticated','error'],['Not logged in','not-logged-in']]) {
    const fake=fakeSpawn({output});
    const status=await checkCodexLogin({spawnImpl:fake.spawnImpl,findCodexImpl:locator});
    assert.equal(status.status,expected);assert.equal(status.ok,false);assert.equal(JSON.stringify(status).includes('sk-secret'),false);
  }
  const fake=fakeSpawn({output:'Logged in using ChatGPT',code:1});
  assert.equal((await checkCodexLogin({spawnImpl:fake.spawnImpl,findCodexImpl:locator})).status,'error');
});

test('Codex login missing/spawn errors are redacted and never start a login flow',async()=>{
  assert.equal((await checkCodexLogin({findCodexImpl:async()=>null})).status,'missing');
  const fake=fakeSpawn({error:Object.assign(new Error('sensitive path'),{code:'ENOENT'})});
  const result=await checkCodexLogin({spawnImpl:fake.spawnImpl,findCodexImpl:locator});
  assert.equal(result.status,'missing');assert.equal(JSON.stringify(result).includes('sensitive path'),false);
});

test('Codex login reads status output drained after process exit',async()=>{
  const fake=fakeSpawn({output:'Logged in using ChatGPT',lateOutput:true});
  assert.equal((await checkCodexLogin({spawnImpl:fake.spawnImpl,findCodexImpl:locator})).status,'ready');
});

test('Codex login deadline and output cap stop their process even without close',async()=>{
  const hanging=fakeSpawn({neverExit:true});
  assert.equal((await checkCodexLogin({spawnImpl:hanging.spawnImpl,findCodexImpl:locator,timeoutMs:20})).status,'error');
  assert.equal(hanging.killed,1);assert.equal(hanging.child.stderr.destroyed,true);
  const huge=fakeSpawn({output:'x'.repeat(17000),neverExit:true});
  assert.equal((await checkCodexLogin({spawnImpl:huge.spawnImpl,findCodexImpl:locator})).status,'error');
  assert.equal(huge.killed,1);
});
