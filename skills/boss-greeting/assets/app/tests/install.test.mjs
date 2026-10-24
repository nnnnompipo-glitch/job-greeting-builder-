import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { install, prepareInstallation, parseInstallArguments, deployRuntime, defaultInstallRoot } from '../scripts/install.mjs';
import { SettingsStore } from '../server/settings.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function fixture({complete=true}={}) {
  const root=await mkdtemp(path.join(os.tmpdir(),'boss-skill-install-'));
  if (complete) {
    for(const relative of ['server/index.mjs','server/providers.mjs','server/settings.mjs','extension/manifest.json','scripts/start.ps1','scripts/stop.ps1','templates/config.default.json','templates/profile.example.md']) {
      await mkdir(path.dirname(path.join(root,relative)),{recursive:true});
      const contents=relative.startsWith('templates/') ? await readFile(path.join(source,relative),'utf8') : 'fixture';
      await writeFile(path.join(root,relative),contents,'utf8');
    }
  }
  return {root,cleanup:async()=>{
    const absolute=path.resolve(root);
    assert.ok(absolute.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(absolute).startsWith('boss-skill-install-'));
    await rm(absolute,{recursive:true,force:true});
  }};
}
async function missing(filename) {try {await access(filename);return false;} catch {return true;}}

test('diagnosis is read-only and redacts inherited credentials',async()=>{
  const f=await fixture({complete:false});
  try {
    const result=await install({root:f.root,options:{diagnose:true},env:{DEEPSEEK_MODEL:'host-model',DEEPSEEK_API_KEY:'secret-not-real'}});
    assert.equal(result.changed,false);assert.equal(result.serviceStarted,false);
    assert.equal(result.hostConnection.status,'ready');
    assert.equal(JSON.stringify(result).includes('secret-not-real'),false);
    assert.equal(await missing(path.join(f.root,'private')),true);
  } finally {await f.cleanup();}
});

test('fresh install creates private state but reports missing profile and model honestly',async()=>{
  const f=await fixture();
  try {
    const result=await install({root:f.root,env:{},options:{}});
    assert.equal(result.createdConfig,true);assert.equal(result.profileReady,false);assert.equal(result.modelConfigured,false);
    assert.equal(result.browserLoaded,false);assert.equal(result.modelConnectionVerified,false);
    assert.equal(result.serviceStarted,false);
    const config=JSON.parse(await readFile(path.join(f.root,'private','config.json'),'utf8'));
    assert.match(config.token,/^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(result).includes(config.token),false);
    assert.equal((await readFile(result.pairingFile,'utf8')),config.token);
  } finally {await f.cleanup();}
});

test('reinstallation preserves chosen model, secret, pairing and candidate facts',async()=>{
  const f=await fixture();
  try {
    const first=await prepareInstallation(f.root), before={...first.config,model:{provider:'doubao',model:'actual-test-model',apiKey:'existing-test-secret'}};
    const candidate='测试候选人的真实事实占位用于验证资料保留，工业设计本科，做过保鲜盒外观、结构、打样和工厂对接。求职目标为工业设计岗位。'.repeat(2);
    await writeFile(path.join(f.root,'private','config.json'),JSON.stringify(before),'utf8');
    await writeFile(path.join(f.root,'private','profile.md'),candidate,'utf8');
    let configured=0;
    const result=await install({root:f.root,env:{},options:{provider:'codex',start:true},
      configureModel:async()=>{configured++;throw new Error('should not change model');},startService:async root=>{assert.equal(root,f.root);return true;}});
    assert.equal(configured,0);assert.equal(result.connection.status,'preserved');assert.equal(result.serviceStarted,true);
    assert.equal(result.profileReady,true);assert.equal(result.modelConfigured,true);
    const after=JSON.parse(await readFile(path.join(f.root,'private','config.json'),'utf8'));
    assert.deepEqual(after,before);assert.equal(await readFile(path.join(f.root,'private','profile.md'),'utf8'),candidate);
    assert.equal(JSON.stringify(result).includes('existing-test-secret'),false);
  } finally {await f.cleanup();}
});

test('explicit host configuration is applied once and public installation report contains no key',async()=>{
  const f=await fixture();
  try {
    let configured=0;
    const result=await install({root:f.root,env:{ARK_MODEL:'test-endpoint',ARK_API_KEY:'allowed-env-secret'},options:{applyHostEnv:true},
      configureModel:async ({root,options,env})=>{
        configured++;assert.equal(options.apply,true);assert.equal(env.ARK_API_KEY,'allowed-env-secret');
        const config=JSON.parse(await readFile(path.join(root,'private','config.json'),'utf8'));
        await new SettingsStore({root,config}).update({model:{provider:'doubao',model:env.ARK_MODEL,apiKey:env.ARK_API_KEY}});
        return {status:'ready',applied:true,settings:{provider:'doubao',model:env.ARK_MODEL,apiKey:env.ARK_API_KEY},message:'Configured only'};
      }});
    assert.equal(configured,1);assert.equal(result.connection.applied,true);assert.equal(result.modelConfigured,true);
    assert.equal(result.modelConnectionVerified,false);
    assert.equal(JSON.stringify(result).includes('allowed-env-secret'),false);
  } finally {await f.cleanup();}
});

test('missing app payload stops installation without inventing success',async()=>{
  const f=await fixture({complete:false});
  try {await assert.rejects(()=>prepareInstallation(f.root),/完整技能目录/);assert.equal(await missing(path.join(f.root,'private')),true);}
  finally {await f.cleanup();}
});

test('CLI separates read-only diagnosis from mutation and does not accept key values',()=>{
  assert.equal(parseInstallArguments(['--provider','deepseek','--model','actual-model','--api-key-env','DEEPSEEK_API_KEY','--start']).apiKeyEnv,'DEEPSEEK_API_KEY');
  assert.throws(()=>parseInstallArguments(['--diagnose','--start']));
  assert.throws(()=>parseInstallArguments(['--api-key','do-not-take-plaintext']));
});

test('stable deployment survives skill replacement without copying private source data',async()=>{
  const f=await fixture({complete:false});
  try {
    const sourceCopy=path.join(f.root,'installed-skill','assets','app'), destination=path.join(f.root,'stable-app');
    await deployRuntime(source,sourceCopy);
    await mkdir(path.join(sourceCopy,'private'));
    await writeFile(path.join(sourceCopy,'private','profile.md'),'SHOULD_NOT_DEPLOY','utf8');
    const first=await install({sourceRoot:sourceCopy,options:{installDir:destination},env:{}});
    assert.equal(first.appRoot,destination);assert.ok(first.deployment.filesUpdated>0);
    assert.equal((await readFile(path.join(destination,'private','profile.md'),'utf8')).includes('SHOULD_NOT_DEPLOY'),false);
    const config=JSON.parse(await readFile(path.join(destination,'private','config.json'),'utf8'));
    config.model={provider:'doubao',model:'saved-user-model',apiKey:'stable-user-secret'};
    const facts='稳定目录中的用户资料，应在 skill 文件被更新或替换后仍然保留。工业设计本科，有外观、建模、打样经历，并关注自己选择的求职城市。'.repeat(2);
    await writeFile(path.join(destination,'private','config.json'),JSON.stringify(config),'utf8');
    await writeFile(path.join(destination,'private','profile.md'),facts,'utf8');
    await writeFile(path.join(sourceCopy,'extension','manifest.json'),'{"version":"updated-fixture"}','utf8');
    let restart;
    const second=await install({sourceRoot:sourceCopy,options:{installDir:destination,start:true},env:{},startService:async(root,options)=>{assert.equal(root,destination);restart=options.restart;return true;}});
    assert.equal(second.deployment.filesUpdated,1);assert.equal(restart,true);assert.equal(second.profileReady,true);
    assert.deepEqual(JSON.parse(await readFile(path.join(destination,'private','config.json'),'utf8')),config);
    assert.equal(await readFile(path.join(destination,'private','profile.md'),'utf8'),facts);
    assert.equal(JSON.stringify(second).includes('stable-user-secret'),false);
    assert.equal(defaultInstallRoot({LOCALAPPDATA:f.root}),path.join(f.root,'BOSS-Greeting-Helper'));
  } finally {await f.cleanup();}
});

test('CLI entrypoints execute when the host installs a linked skill directory',async()=>{
  const f=await fixture({complete:false});
  try {
    const linked=path.join(f.root,'host-skill-link');
    await symlink(source,linked,process.platform === 'win32' ? 'junction' : 'dir');
    const env={SystemRoot:process.env.SystemRoot,USERPROFILE:process.env.USERPROFILE,LOCALAPPDATA:process.env.LOCALAPPDATA};
    const installer=spawnSync(process.execPath,[path.join(linked,'scripts','install.mjs'),'--diagnose'],{encoding:'utf8',env});
    assert.equal(installer.status,0);assert.equal(JSON.parse(installer.stdout).mode,'diagnose');
    const adapter=spawnSync(process.execPath,[path.join(linked,'scripts','configure-host.mjs')],{encoding:'utf8',env});
    assert.equal(adapter.status,0);assert.equal(JSON.parse(adapter.stdout).status,'none');
  } finally {await f.cleanup();}
});
