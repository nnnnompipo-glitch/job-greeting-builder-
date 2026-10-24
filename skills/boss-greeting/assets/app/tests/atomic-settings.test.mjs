import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicWrite } from '../server/settings.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(),'boss-atomic-settings-'));
  const filename = path.join(root,'config.json');
  await writeFile(filename,'{"model":"original"}','utf8');
  return {root,filename,cleanup:async()=>{
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep) && path.basename(resolved).startsWith('boss-atomic-settings-'));
    await rm(resolved,{recursive:true,force:true});
  }};
}

test('EXDEV fallback persists complete settings and removes its temporary file',async()=>{
  const f = await fixture();
  try {
    const next = {model:{provider:'codex'},candidate:'测试资料'};
    let renameCalled = false;
    await atomicWrite(f.filename,JSON.stringify(next),{rename:async()=>{
      renameCalled = true;
      throw Object.assign(new Error('cross-device fixture'),{code:'EXDEV'});
    }});
    assert.equal(renameCalled,true);
    assert.deepEqual(JSON.parse(await readFile(f.filename,'utf8')),next);
    assert.deepEqual(await readdir(f.root),['config.json']);
  } finally {await f.cleanup();}
});

test('non-EXDEV rename errors preserve previous settings without copying',async()=>{
  const f = await fixture();
  try {
    let copied = false;
    const denied = Object.assign(new Error('permission fixture'),{code:'EACCES'});
    await assert.rejects(()=>atomicWrite(f.filename,'{"model":"changed"}',{
      rename:async()=>{throw denied;},
      copyFile:async()=>{copied = true;}
    }),error=>error === denied);
    assert.equal(copied,false);
    assert.equal(await readFile(f.filename,'utf8'),'{"model":"original"}');
    assert.deepEqual(await readdir(f.root),['config.json']);
  } finally {await f.cleanup();}
});

test('failed EXDEV copy propagates failure and still removes the owned temporary',async()=>{
  const f = await fixture();
  try {
    const full = Object.assign(new Error('disk-full fixture'),{code:'ENOSPC'});
    await assert.rejects(()=>atomicWrite(f.filename,'{"model":"changed"}',{
      rename:async()=>{throw Object.assign(new Error('cross-device fixture'),{code:'EXDEV'});},
      copyFile:async()=>{throw full;}
    }),error=>error === full);
    assert.equal(await readFile(f.filename,'utf8'),'{"model":"original"}');
    assert.deepEqual(await readdir(f.root),['config.json']);
  } finally {await f.cleanup();}
});

test('partial temporary write is cleaned when writing itself fails',async()=>{
  const f = await fixture();
  try {
    const failed = Object.assign(new Error('write fixture'),{code:'EIO'});
    await assert.rejects(()=>atomicWrite(f.filename,'new-data',{
      writeFile:async(temporary)=>{await writeFile(temporary,'partial','utf8');throw failed;}
    }),error=>error === failed);
    assert.equal(await readFile(f.filename,'utf8'),'{"model":"original"}');
    assert.deepEqual(await readdir(f.root),['config.json']);
  } finally {await f.cleanup();}
});
