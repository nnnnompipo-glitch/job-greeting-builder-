import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runLauncher } from '../scripts/install.mjs';

test('launcher completion does not wait on pipes inherited by a background process',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'boss-launcher-process-'));
  const pidFile=path.join(root,'background.pid');
  let backgroundPid;
  const code=`
    const {spawn}=require('node:child_process');
    const fs=require('node:fs');
    const background=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{
      windowsHide:true,detached:true,stdio:['ignore',process.stdout,process.stderr]
    });
    fs.writeFileSync(process.argv[1],String(background.pid));
    background.unref();
    process.exit(0);
  `;
  try {
    assert.equal(await runLauncher(process.execPath,['-e',code,pidFile],{cwd:root,env:process.env,timeoutMs:4000}),0);
    backgroundPid=Number(await readFile(pidFile,'utf8'));
    assert.ok(Number.isInteger(backgroundPid)&&backgroundPid>0);
    assert.doesNotThrow(()=>process.kill(backgroundPid,0));
  } finally {
    if (!backgroundPid) {
      try {backgroundPid=Number(await readFile(pidFile,'utf8'));} catch {}
    }
    if (Number.isInteger(backgroundPid)&&backgroundPid>0) {
      try {process.kill(backgroundPid);} catch(error) {if(error.code!=='ESRCH') throw error;}
    }
    const absolute=path.resolve(root);
    assert.ok(absolute.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(absolute).startsWith('boss-launcher-process-'));
    await rm(absolute,{recursive:true,force:true,maxRetries:10,retryDelay:50});
  }
});

test('launcher deadline rejects even when kill does not emit exit or close',async()=>{
  const child=new EventEmitter();
  child.stdout=new PassThrough();child.stderr=new PassThrough();
  let killed=0;
  child.kill=()=>{killed++;return true;};
  await assert.rejects(()=>runLauncher('fixture',[],{timeoutMs:30,spawnImpl:()=>child}),error=>/超时/.test(error.publicMessage));
  assert.equal(killed,1);assert.equal(child.stdout.destroyed,true);assert.equal(child.stderr.destroyed,true);
});

test('launcher preserves nonzero exit status and reports spawn failure without raw details',async()=>{
  assert.equal(await runLauncher(process.execPath,['-e','process.exit(7)'],{timeoutMs:4000}),7);
  await assert.rejects(()=>runLauncher('boss-helper-missing-launcher-test',[],{timeoutMs:4000}),error=>{
    assert.equal(error.publicMessage,'无法启动本地服务，请检查 Windows PowerShell');
    assert.equal(error.message.includes('missing-launcher'),false);
    return true;
  });
});
