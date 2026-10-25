import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,realpath,readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {archiveVersion,verifyArchive} from '../scripts/archive-version.mjs';

async function fixture(run){
  const directory=await mkdtemp(path.join(os.tmpdir(),'job-helper-version-'));
  const source=path.join(directory,'source'),output=path.join(directory,'versions');
  await mkdir(source);await writeFile(path.join(source,'README.md'),'Generic source, no personal information.\n');
  await writeFile(path.join(source,'package.json'),JSON.stringify({name:'fixture',version:'1.3.1'}));
  try{return await run({directory,source,output});}finally{
    const resolved=await realpath(directory),boundary=await realpath(os.tmpdir());
    assert.ok(resolved.startsWith(boundary+path.sep)&&path.basename(resolved).startsWith('job-helper-version-'));
    await rm(resolved,{recursive:true,force:true});
  }
}

test('version archive retains source, explicit original ZIP, hashes and a readable index',async()=>fixture(async({directory,source,output})=>{
  await writeFile(path.join(source,'CHANGELOG.md'),'# Updates\n\n1.3.1: archive support.\n');
  const artifact=path.join(directory,'original-build.zip');
  await writeFile(artifact,Buffer.from('PK\x03\x04fixture package bytes'));
  const archived=await archiveVersion({source,version:'1.3.1',label:'release',artifacts:[artifact],commit:'a'.repeat(40),output,date:'2026-10-25',description:'Original release artifacts explicitly supplied.'});
  assert.equal(archived.reused,false);
  assert.equal(path.basename(path.dirname(archived.snapshotDir)),'v1.3.1');
  assert.equal((await verifyArchive(archived.snapshotDir)).filesVerified,5);
  const manifest=JSON.parse(await readFile(archived.manifestPath,'utf8'));
  assert.equal(manifest.appVersion,'1.3.1');assert.equal(manifest.commit,'a'.repeat(40));assert.equal(manifest.timeZone,'Asia/Shanghai');
  assert.deepEqual(await readFile(path.join(archived.snapshotDir,'artifacts/original-build.zip')),await readFile(artifact));
  assert.match(await readFile(path.join(output,'README.md'),'utf8'),/1.3.1/);
  assert.equal(JSON.parse(await readFile(path.join(output,'index.json'),'utf8')).snapshots.length,1);
  await writeFile(path.join(archived.snapshotDir,'source/README.md'),'changed');
  await assert.rejects(()=>verifyArchive(archived.snapshotDir),/SHA256/);
}));

test('unchanged snapshots are reused while same-version revisions never overwrite older files',async()=>fixture(async({source,output})=>{
  const options={source,version:'1.2.0',label:'feature-update',commit:'b'.repeat(40),date:'2026-10-25',output};
  const first=await archiveVersion(options),again=await archiveVersion(options);
  assert.equal(again.reused,true);assert.equal(again.snapshotDir,first.snapshotDir);
  const original=await readFile(path.join(first.snapshotDir,'source/README.md'),'utf8');
  await writeFile(path.join(source,'README.md'),'New implementation without deleting old archive.\n');
  const revision=await archiveVersion(options);
  assert.equal(revision.reused,false);assert.notEqual(revision.snapshotDir,first.snapshotDir);
  assert.equal(await readFile(path.join(first.snapshotDir,'source/README.md'),'utf8'),original);
  assert.equal(JSON.parse(await readFile(path.join(output,'index.json'),'utf8')).snapshots.length,2);
  assert.equal((await verifyArchive(first.snapshotDir)).ok,true);
  assert.equal((await verifyArchive(revision.snapshotDir)).ok,true);
}));

test('source archives reject private data, binaries, links and nested destinations',async()=>fixture(async({directory,source,output})=>{
  for(const relative of ['private/config.json','.git/config','node_modules/test.js','runtime/node.exe','resume.pdf','.env']){
    const filename=path.join(source,relative);await mkdir(path.dirname(filename),{recursive:true});await writeFile(filename,'never copy');
    await assert.rejects(()=>archiveVersion({source,version:'1.0.0',output}),/拒绝归档/);
    const top=relative.split('/')[0];await rm(path.join(source,top),{recursive:true,force:true});
  }
  const other=path.join(directory,'other');await mkdir(other);
  await symlink(other,path.join(source,'linked'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(()=>archiveVersion({source,version:'1.0.0',output}),/符号链接/);
  await rm(path.join(source,'linked'));
  await assert.rejects(()=>archiveVersion({source,version:'1.0.0',output:path.join(source,'versions')}),/不得互相嵌套/);
  await assert.rejects(()=>archiveVersion({source,version:'../escape',output}),/语义版本号/);
  await assert.rejects(()=>archiveVersion({source,version:'1.0.0',label:'../escape',output}),/归档修订名/);
  await assert.rejects(()=>archiveVersion({source,version:'1.0.0',date:'2026-02-30',output}),/日期/);
}));

test('verification refuses extra files and manifest traversal without touching files outside an archive',async()=>fixture(async({source,output,directory})=>{
  const archived=await archiveVersion({source,version:'1.0.0',output});
  const extra=path.join(archived.snapshotDir,'extra.txt');await writeFile(extra,'unrecorded');
  await assert.rejects(()=>verifyArchive(archived.snapshotDir),/额外文件/);await rm(extra);
  const sentinel=path.join(directory,'sentinel.txt');await writeFile(sentinel,'original');
  const manifest=JSON.parse(await readFile(archived.manifestPath,'utf8'));
  manifest.files[0].path='../sentinel.txt';await writeFile(archived.manifestPath,JSON.stringify(manifest));
  await assert.rejects(()=>verifyArchive(archived.snapshotDir),/相对路径/);
  assert.equal(await readFile(sentinel,'utf8'),'original');
  assert.equal((await readdir(output)).some(name=>name.startsWith('.staging-')),false);
}));

test('version-directory junction cannot redirect an archive outside its output boundary',async()=>fixture(async({source,output,directory})=>{
  const outside=path.join(directory,'outside');await mkdir(outside);await writeFile(path.join(outside,'sentinel.txt'),'unchanged');
  await mkdir(output);
  await symlink(outside,path.join(output,'v1.3.1'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(()=>archiveVersion({source,version:'1.3.1',output}),/符号链接|junction|不在指定/);
  assert.deepEqual(await readdir(outside),['sentinel.txt']);
  assert.equal(await readFile(path.join(outside,'sentinel.txt'),'utf8'),'unchanged');
  assert.equal((await readdir(output)).some(name=>name.startsWith('.staging-')),false);
}));

test('verification checks that a version directory agrees with its manifest',async()=>fixture(async({source,output})=>{
  const archived=await archiveVersion({source,version:'1.3.1',output});
  const manifest=JSON.parse(await readFile(archived.manifestPath,'utf8'));
  manifest.version='1.2.0';await writeFile(archived.manifestPath,JSON.stringify(manifest));
  await assert.rejects(()=>verifyArchive(archived.snapshotDir),/版本与所在目录不一致/);
}));
