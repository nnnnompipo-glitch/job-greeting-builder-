import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,access,rm,symlink,readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {install,prepareInstallation,parseInstallArguments,deployRuntime,defaultInstallRoot} from '../scripts/install.mjs';

const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const unavailable=async()=>({ok:false,status:'missing',message:'Install Codex and use codex login'});
const ready=async()=>({ok:true,status:'ready',message:'Logged in using ChatGPT'});
async function fixture({complete=true}={}) {
  const root=await mkdtemp(path.join(os.tmpdir(),'boss-skill-install-'));
  if(complete)for(const relative of ['server/index.mjs','server/providers.mjs','server/settings.mjs','extension/manifest.json','scripts/start.ps1','scripts/stop.ps1','scripts/codex.mjs','templates/config.default.json','templates/profile.example.md']){
    await mkdir(path.dirname(path.join(root,relative)),{recursive:true});
    await writeFile(path.join(root,relative),relative.startsWith('templates/')?await readFile(path.join(source,relative),'utf8'):'fixture','utf8');
  }
  return {root,async cleanup(){const absolute=path.resolve(root);assert.ok(absolute.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(absolute).startsWith('boss-skill-install-'));await rm(absolute,{recursive:true,force:true});}};
}
async function missing(filename){try{await access(filename);return false;}catch{return true;}}

test('diagnosis is read-only and reports Codex login without provider credentials',async()=>{
  const f=await fixture();
  try{
    const result=await install({root:f.root,env:{ARK_API_KEY:'unrelated-secret'},options:{diagnose:true},detectModel:unavailable});
    assert.equal(result.changed,false);assert.equal(result.hostConnection.status,'missing');
    assert.equal(await missing(path.join(f.root,'private')),true);assert.equal(JSON.stringify(result).includes('unrelated-secret'),false);
  }finally{await f.cleanup();}
});

test('fresh install defaults to Codex and distinguishes configuration from login',async()=>{
  const f=await fixture();
  try{
    const result=await install({root:f.root,env:{},detectModel:unavailable});
    assert.equal(result.createdConfig,true);assert.equal(result.model.provider,'codex');assert.equal(result.modelConfigured,true);
    assert.equal(result.codexLoginVerified,false);assert.equal(result.profileReady,false);assert.equal(result.modelConnectionVerified,false);
    assert.equal(result.browserLoaded,false);assert.equal(result.serviceStarted,false);
    const config=JSON.parse(await readFile(path.join(f.root,'private/config.json'),'utf8'));
    assert.match(config.token,/^[a-f0-9]{64}$/);assert.equal(JSON.stringify(result).includes(config.token),false);
    assert.equal(await readFile(result.pairingFile,'utf8'),config.token);
  }finally{await f.cleanup();}
});

test('upgrade backs up legacy API settings privately and preserves profile, pairing and tone',async()=>{
  const f=await fixture();
  try{
    const first=await prepareInstallation(f.root);
    const before={...first.config,preferences:{tone:'creative'},model:{provider:'doubao',model:'legacy',apiKey:'private-legacy-secret',timeoutMs:180000}};
    const facts='工业设计本科，参与厨房产品外观和结构建模，作品集与个人资料必须在程序升级后保留。'.repeat(3);
    await writeFile(path.join(f.root,'private/config.json'),JSON.stringify(before));
    await writeFile(path.join(f.root,'private/profile.md'),facts);
    let restarted=false;
    const result=await install({root:f.root,options:{start:true},detectModel:ready,startService:async(_,options)=>{restarted=options.restart;return true;}});
    const after=JSON.parse(await readFile(path.join(f.root,'private/config.json'),'utf8'));
    assert.deepEqual(after,{...before,model:{provider:'codex',timeoutMs:180000}});
    assert.equal(await readFile(path.join(f.root,'private/profile.md'),'utf8'),facts);
    assert.deepEqual(JSON.parse(await readFile(result.legacyBackupFile,'utf8')),before);
    assert.equal(result.migratedToCodex,true);assert.equal(restarted,true);assert.equal(result.codexLoginVerified,true);
    assert.equal(JSON.stringify(result).includes('private-legacy-secret'),false);
    const again=await install({root:f.root,detectModel:ready});
    assert.equal(again.migratedToCodex,false);
    assert.equal((await readdir(path.join(f.root,'private'))).filter(name=>name.startsWith('config.before-codex-only.')).length,1);
  }finally{await f.cleanup();}
});

test('already configured Codex and candidate facts survive reinstallation unchanged',async()=>{
  const f=await fixture();
  try{
    const before=(await prepareInstallation(f.root)).config;
    const facts='工业设计本科，当前求职杭州与周边城市，参与外观、建模与打样并愿意核对岗位要求。'.repeat(3);
    await writeFile(path.join(f.root,'private/profile.md'),facts);
    const result=await install({root:f.root,detectModel:ready});
    assert.deepEqual(JSON.parse(await readFile(path.join(f.root,'private/config.json'),'utf8')),before);
    assert.equal(await readFile(path.join(f.root,'private/profile.md'),'utf8'),facts);
    assert.equal(result.profileReady,true);assert.equal(result.migratedToCodex,false);
  }finally{await f.cleanup();}
});

test('obsolete Codex output formats migrate instead of breaking health and generation',async()=>{
  const f=await fixture();
  try{
    const state=await prepareInstallation(f.root);
    const before={...state.config,model:{provider:'codex',responseFormat:'json_schema',timeoutMs:160000}};
    await writeFile(path.join(f.root,'private/config.json'),JSON.stringify(before));
    const result=await prepareInstallation(f.root);
    assert.equal(result.migrated,true);assert.equal(result.configured,true);
    assert.deepEqual(result.config.model,{provider:'codex',timeoutMs:160000});
    assert.deepEqual(JSON.parse(await readFile(result.backupFile,'utf8')),before);
  }finally{await f.cleanup();}
});

test('missing payload fails before creating private state and CLI rejects API setup',async()=>{
  const f=await fixture({complete:false});
  try{
    await assert.rejects(()=>prepareInstallation(f.root),/完整技能目录/);assert.equal(await missing(path.join(f.root,'private')),true);
    assert.equal(parseInstallArguments(['--provider','codex','--start']).start,true);
    for(const args of [['--diagnose','--start'],['--provider','doubao'],['--api-key-env','ARK_API_KEY'],['--base-url','https://example.test'],['--apply-host-env']])assert.throws(()=>parseInstallArguments(args));
    await assert.rejects(()=>install({root:f.root,options:{applyHostEnv:true}}),/统一使用 Codex/);
  }finally{await f.cleanup();}
});

test('stable deployment updates program files without copying private source facts',async()=>{
  const f=await fixture({complete:false});
  try{
    const skill=path.join(f.root,'skill/assets/app'),destination=path.join(f.root,'stable-app');
    await deployRuntime(source,skill);await mkdir(path.join(skill,'private'));
    await writeFile(path.join(skill,'private/profile.md'),'SHOULD_NOT_DEPLOY');
    const first=await install({sourceRoot:skill,options:{installDir:destination},detectModel:unavailable});
    assert.ok(first.deployment.filesUpdated>0);
    assert.equal((await readFile(path.join(destination,'private/profile.md'),'utf8')).includes('SHOULD_NOT_DEPLOY'),false);
    const config=JSON.parse(await readFile(path.join(destination,'private/config.json'),'utf8'));
    await writeFile(path.join(skill,'extension/manifest.json'),'{"version":"test-upgrade"}');
    let restarted=false;
    const second=await install({sourceRoot:skill,options:{installDir:destination,start:true},detectModel:ready,startService:async(_,options)=>{restarted=options.restart;return true;}});
    assert.equal(second.deployment.filesUpdated,1);assert.equal(restarted,true);
    assert.deepEqual(JSON.parse(await readFile(path.join(destination,'private/config.json'),'utf8')),config);
    assert.equal(defaultInstallRoot({LOCALAPPDATA:f.root}),path.join(f.root,'BOSS-Greeting-Helper'));
  }finally{await f.cleanup();}
});

test('CLI entrypoints work when installed as a linked skill',async()=>{
  const f=await fixture({complete:false});
  try{
    const linked=path.join(f.root,'skill-link');await symlink(source,linked,process.platform==='win32'?'junction':'dir');
    const env={SystemRoot:process.env.SystemRoot};
    const installer=spawnSync(process.execPath,[path.join(linked,'scripts/install.mjs'),'--diagnose'],{encoding:'utf8',env,timeout:12000});
    assert.equal(installer.status,0);assert.equal(JSON.parse(installer.stdout).mode,'diagnose');
    const adapter=spawnSync(process.execPath,[path.join(linked,'scripts/configure-host.mjs')],{encoding:'utf8',env,timeout:12000});
    assert.equal(adapter.status,0);assert.ok(['ready','missing','not-logged-in','api-key-login','error'].includes(JSON.parse(adapter.stdout).status));
  }finally{await f.cleanup();}
});
