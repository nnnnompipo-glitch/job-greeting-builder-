import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DocumentImportManager, IMPORT_LIMITS } from '../server/imports.mjs';

const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
const image=()=>({filename:'作品页.png',type:'image/png',base64:png.toString('base64')});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate) {for(let i=0;i<200;i++){const result=await predicate();if(result)return result;await delay(5);}throw new Error('Import did not settle');}
async function fixture(options={}) {
  const root=await mkdtemp(path.join(os.tmpdir(),'boss-imports-test-'));
  const manager=new DocumentImportManager({root,...options});
  return {root,manager,async cleanup(){
    await manager.close();
    if(manager.current) await until(()=>!manager.current);
    const absolute=path.resolve(root);
    assert.ok(absolute.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(absolute).startsWith('boss-imports-test-'));
    await rm(absolute,{recursive:true,force:true});
  }};
}
async function completed(manager,id) {return until(()=>{const task=manager.get(id);return task&&['done','error'].includes(task.status)&&task;});}

test('UTF8 text import stays local, never saves the profile, and cleans generated input',async()=>{
  const f=await fixture({extractor:()=>{throw new Error('Text import must not invoke OCR');}});
  try {
    await mkdir(path.join(f.root,'private'),{recursive:true});
    await writeFile(path.join(f.root,'private','profile.md'),'EXISTING_PROFILE_DO_NOT_CHANGE','utf8');
    const text='我的实际专业与经历：工业设计本科，做过餐厨产品外观、建模渲染和工厂打样沟通。';
    const started=await f.manager.submit({filename:'个人经历.md',type:'text/markdown',base64:Buffer.from('\ufeff'+text).toString('base64')});
    const task=await completed(f.manager,started.id);
    assert.equal(task.status,'done');assert.equal(task.result.text,text);assert.equal(task.result.method,'utf8-text');assert.equal(task.progress,100);
    assert.equal('filePath' in task,false);
    assert.equal(await readFile(path.join(f.root,'private','profile.md'),'utf8'),'EXISTING_PROFILE_DO_NOT_CHANGE');
    await until(()=>!f.manager.current);
    assert.deepEqual(await readdir(path.join(f.root,'private','imports')),[]);
  } finally {await f.cleanup();}
});

test('valid image is staged with UUID only, reports progress, and extractor error is redacted',async()=>{
  const seen=[];
  const f=await fixture({extractor:async options=>{
    seen.push(options);
    assert.equal((await readFile(options.filePath)).equals(png),true);
    assert.match(path.basename(options.filePath),/^[\da-f-]{36}\.png$/);
    options.onProgress(50);
    return {text:'本地识别的测试文字',pageCount:1,method:'windows-ocr-image',warnings:['请核对识别结果']};
  }});
  try {
    const task=await completed(f.manager,(await f.manager.submit(image())).id);
    assert.equal(task.status,'done');assert.equal(task.result.pageCount,1);assert.equal(task.result.text,'本地识别的测试文字');
    assert.equal(seen[0].maxPages,40);assert.equal(seen[0].maxCharacters,120000);assert.equal(seen[0].filename,'作品页.png');
    await until(()=>!f.manager.current);
    f.manager.extractor=async()=>{throw new Error('secret-path C:/sensitive source personal content');};
    const bad=await completed(f.manager,(await f.manager.submit(image())).id);
    assert.equal(bad.status,'error');assert.equal(bad.error.includes('secret-path'),false);assert.equal(JSON.stringify(bad).includes('sensitive'),false);
    await until(()=>!f.manager.current);assert.deepEqual(await readdir(path.join(f.root,'private','imports')),[]);
  } finally {await f.cleanup();}
});

test('rejects traversal names, mismatched MIME or magic, malformed base64 and invalid UTF8',async()=>{
  const f=await fixture();
  try {
    for(const filename of ['../resume.png','..\\resume.png','C:resume.png','CON.png','resume.exe']) await assert.rejects(()=>f.manager.submit({...image(),filename}));
    await assert.rejects(()=>f.manager.submit({...image(),type:'application/pdf'}),/类型/);
    await assert.rejects(()=>f.manager.submit({...image(),filename:'resume.pdf',type:'application/pdf'}),/内容/);
    for(const base64 of ['data:image/png;base64,AAAA','A===','@@@@','AA A','AB==','AAAA\n']) await assert.rejects(()=>f.manager.submit({...image(),base64}));
    await assert.rejects(()=>f.manager.submit({filename:'binary.txt',base64:Buffer.from([0,1,2]).toString('base64')}),/二进制/);
    const invalid=await completed(f.manager,(await f.manager.submit({filename:'invalid.txt',base64:Buffer.from([255,254,253]).toString('base64')})).id);
    assert.equal(invalid.status,'error');assert.match(invalid.error,/UTF-8/);
  } finally {await f.cleanup();}
});

test('enforces25MiB upload cap and explicitly reports text truncation',async()=>{
  const f=await fixture();
  try {
    const tooLarge=Buffer.alloc(IMPORT_LIMITS.maxBytes+1,65).toString('base64');
    await assert.rejects(()=>f.manager.submit({filename:'oversized.txt',type:'text/plain',base64:tooLarge}),/25MiB/);
    const text='设'.repeat(120001);
    const task=await completed(f.manager,(await f.manager.submit({filename:'long.txt',type:'text/plain',base64:Buffer.from(text).toString('base64')})).id);
    assert.equal(task.status,'done');assert.equal(task.result.characters,120000);assert.match(task.result.warnings.join(' '),/截断/);
  } finally {await f.cleanup();}
});

test('OCR queue is serial and bounded; closing cancels pending files and aborts active import',async()=>{
  const signals=[];let release;
  const f=await fixture({maxQueued:1,extractor:options=>new Promise((resolve,reject)=>{
    signals.push(options.signal);release=()=>resolve({text:'测试文字',pageCount:1,method:'mock',warnings:[]});
    options.signal.addEventListener('abort',()=>reject(new Error('canceled')),{once:true});
  })});
  try {
    const first=await f.manager.submit(image());await until(()=>signals.length===1);
    const second=await f.manager.submit({...image(),filename:'next.png'});
    await assert.rejects(()=>f.manager.submit({...image(),filename:'extra.png'}),/等待/);
    assert.equal(signals.length,1);assert.equal(f.manager.get(second.id).status,'queued');
    await f.manager.close();
    assert.equal(signals[0].aborted,true);assert.equal(f.manager.get(second.id).status,'error');
    const done=await completed(f.manager,first.id);assert.equal(done.status,'error');
    await until(()=>!f.manager.current);assert.deepEqual(await readdir(path.join(f.root,'private','imports')),[]);
    await assert.rejects(()=>f.manager.submit(image()),/停止/);
  } finally {release?.();await f.cleanup();}
});

test('finished results expire with TTL while completed record is retained up to its cap',async()=>{
  const f=await fixture({maxRecords:1,ttlMs:20});
  try {
    const first=await f.manager.submit({filename:'one.txt',base64:Buffer.from('测试文字').toString('base64')});
    assert.equal((await completed(f.manager,first.id)).status,'done');
    await until(()=>!f.manager.current);
    assert.ok(f.manager.get(first.id));
    await delay(30);assert.equal(f.manager.get(first.id),null);
  } finally {await f.cleanup();}
});
