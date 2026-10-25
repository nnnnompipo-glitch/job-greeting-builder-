import {createReadStream} from 'node:fs';
import {access,copyFile,lstat,mkdir,readFile,readdir,realpath,rename,rm,writeFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

const blockedDirectories=new Set(['private','.git','node_modules','runtime']);
const blockedExtensions=/\.(?:exe|dll|pdf|jpe?g|png|gif|webp|bmp|log|pem|key|pfx|p12|db|sqlite|zip)$/i;
const semver=/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
function failure(message){return Object.assign(new Error(message),{publicMessage:message});}
const inside=(parent,child)=>child===parent || child.startsWith(parent+path.sep);
const sortFiles=files=>files.sort((a,b)=>a.path.localeCompare(b.path,'en'));
const sha=value=>createHash('sha256').update(value).digest('hex');
const releaseDate=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());

async function exists(filename){try{await access(filename);return true;}catch{return false;}}
async function hashFile(filename){const hash=createHash('sha256');for await(const chunk of createReadStream(filename))hash.update(chunk);return hash.digest('hex');}
async function canonicalFuture(filename){
  const absolute=path.resolve(filename);
  try{return await realpath(absolute);}catch(error){
    if(error.code!=='ENOENT')throw error;
    const parent=path.dirname(absolute);
    if(parent===absolute)throw error;
    return path.join(await canonicalFuture(parent),path.basename(absolute));
  }
}
async function checkedDirectoryWithin(root,target,{create=false}={}){
  const relative=path.relative(root,target);
  if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw failure('归档目标解析后不在指定的版本目录内');
  let current=root;
  const components=relative?relative.split(path.sep):[];
  for(const part of ['',...components]){
    if(part)current=path.join(current,part);
    let info;
    try{info=await lstat(current);}catch(error){
      if(error.code!=='ENOENT'||!create)throw error;
      await mkdir(current,{recursive:false});info=await lstat(current);
    }
    if(info.isSymbolicLink()||!info.isDirectory())throw failure('归档目标目录不能包含符号链接、junction 或普通文件');
  }
  const canonical=await canonicalFuture(target);
  if(!inside(root,canonical))throw failure('归档目标解析后不在指定的版本目录内');
}
function checkedRelative(relative){
  if(typeof relative!=='string'||!relative||relative.includes('\\')||relative.includes('\0')||path.isAbsolute(relative)||/^[a-z]:/i.test(relative)||relative.split('/').some(part=>!part||part==='.'||part==='..'))throw failure('归档清单含无效的相对路径');
  return relative;
}
function checkSourceName(relative){
  const parts=relative.split('/');
  if(parts.some(part=>blockedDirectories.has(part.toLowerCase()))||blockedExtensions.test(relative)||parts.some(part=>/^\.env(?:\.|$)|^(?:auth|credentials)\.json$/i.test(part)))throw failure('源码中存在个人、凭据、运行环境或二进制文件，拒绝归档');
}
async function filesIn(directory,{source=false}={}){
  const files=[];
  async function visit(current,relative=''){
    for(const entry of await readdir(current,{withFileTypes:true})){
      const name=relative?relative+'/'+entry.name:entry.name;
      checkedRelative(name);
      if(source)checkSourceName(name);
      const filename=path.join(current,entry.name),info=await lstat(filename);
      if(info.isSymbolicLink())throw failure('不归档或验证符号链接，请使用独立的实际文件');
      if(info.isDirectory())await visit(filename,name);
      else if(info.isFile())files.push({path:name,size:info.size,sha256:await hashFile(filename)});
      else throw failure('归档仅支持普通文件与目录');
    }
  }
  await visit(directory);return sortFiles(files);
}
async function atomicText(filename,text){
  const temporary=filename+'.'+randomUUID()+'.tmp';
  try{
    await writeFile(temporary,text,{encoding:'utf8',flag:'wx'});
    try{await rename(temporary,filename);}catch(error){if(error.code!=='EXDEV')throw error;await copyFile(temporary,filename);}
  }finally{await rm(temporary,{force:true}).catch(()=>{});}
}
function fingerprintFor({version,label,commit,date,description,files}){
  return sha(JSON.stringify({version,label,commit,date,description,files:sortFiles(files.filter(file=>file.kind!=='notes').map(file=>({...file})))}));
}

export async function verifyArchive(snapshotDir){
  const root=await realpath(path.resolve(snapshotDir));
  if((await lstat(path.resolve(snapshotDir))).isSymbolicLink())throw failure('归档目录不能是符号链接');
  const manifest=JSON.parse(await readFile(path.join(root,'manifest.json'),'utf8'));
  if(manifest.schemaVersion!==1||!semver.test(manifest.version)||!Array.isArray(manifest.files))throw failure('归档清单格式不正确');
  const parentVersion=path.basename(path.dirname(root));
  if(!path.basename(root).startsWith('.staging-')&&/^v\d+\.\d+\.\d+(?:-|$)/.test(parentVersion)&&parentVersion!=='v'+manifest.version)throw failure('归档清单的版本与所在目录不一致');
  const actual=await filesIn(root),actualByPath=new Map(actual.map(file=>[file.path,file]));
  const expectedNames=new Set(['manifest.json']);
  for(const file of manifest.files){
    checkedRelative(file.path);
    if(expectedNames.has(file.path)||!['source','artifact','notes'].includes(file.kind))throw failure('归档清单含重复或无效条目');
    expectedNames.add(file.path);
    if(file.kind==='source'){
      if(!file.path.startsWith('source/'))throw failure('源码归档路径不正确');
      checkSourceName(file.path.slice(7));
    }
    if(file.kind==='artifact'&&(!/^artifacts\/[^/]+\.zip$/i.test(file.path)))throw failure('安装包归档路径不正确');
    if(file.kind==='notes'&&file.path!=='版本说明.md')throw failure('版本说明路径不正确');
    const found=actualByPath.get(file.path);
    if(!found||found.size!==file.size||found.sha256!==file.sha256)throw failure('归档文件缺失或 SHA256 校验不一致：'+file.path);
  }
  if(actual.some(file=>!expectedNames.has(file.path)))throw failure('归档中出现清单之外的额外文件');
  if(fingerprintFor(manifest)!==manifest.fingerprint)throw failure('归档元数据与指纹不一致');
  return {ok:true,filesVerified:manifest.files.length,version:manifest.version,fingerprint:manifest.fingerprint};
}

async function rebuildIndex(output){
  const snapshots=[];
  for(const versionDirectory of await readdir(output,{withFileTypes:true})){
    if(!versionDirectory.isDirectory()||!semver.test(versionDirectory.name.replace(/^v/,'')))continue;
    for(const snapshotDirectory of await readdir(path.join(output,versionDirectory.name),{withFileTypes:true})){
      if(!snapshotDirectory.isDirectory())continue;
      const relative=versionDirectory.name+'/'+snapshotDirectory.name;
      const manifestPath=path.join(output,relative,'manifest.json');
      if(!await exists(manifestPath))continue;
      const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
      snapshots.push({version:manifest.version,label:manifest.label,date:manifest.date,commit:manifest.commit,fingerprint:manifest.fingerprint,path:relative,artifacts:manifest.files.filter(file=>file.kind==='artifact').map(file=>file.path.slice(10))});
    }
  }
  snapshots.sort((a,b)=>b.version.localeCompare(a.version,'en',{numeric:true})||b.date.localeCompare(a.date)||a.path.localeCompare(b.path));
  const index={schemaVersion:1,timeZone:'Asia/Shanghai',updatedAt:new Date().toISOString(),snapshots};
  await atomicText(path.join(output,'index.json'),JSON.stringify(index,null,2)+'\n');
  const lines=['# 本地版本归档','','每个目录保存独立的源码、当时已有的安装包、更新说明和 SHA256 清单。归档不会覆盖之前的内容；同一版本的不同修订分别保存。','','| 版本 | 修订 | 日期（北京时间） | Git 提交 | 安装包 |','| --- | --- | --- | --- | --- |'];
  for(const item of snapshots)lines.push(`| ${item.version} | [${item.label}](${encodeURI(item.path)}/%E7%89%88%E6%9C%AC%E8%AF%B4%E6%98%8E.md) | ${item.date} | ${item.commit?item.commit.slice(0,7):'未记录'} | ${item.artifacts.join('、')||'无留存安装包'} |`);
  lines.push('','可用 `node scripts/archive-version.mjs --verify "归档目录"` 核对清单。历史源码可从 Git 提交恢复；只有实际留存的安装包才会列入，不会把现在重打的包说成当时的原包。','');
  await atomicText(path.join(output,'README.md'),lines.join('\n'));
}

export async function archiveVersion({source,version,label='release',artifacts=[],commit='',output=path.resolve('版本归档'),date=releaseDate(),description=''}={}){
  if(!source||!semver.test(version||''))throw failure('请提供干净源码目录及有效的语义版本号');
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(label)||label==='.'||label==='..')throw failure('归档修订名只能使用字母、数字、点、下划线和短横线');
  if(commit&&!/^[a-f0-9]{7,40}$/i.test(commit))throw failure('Git 提交编号格式不正确');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)throw failure('日期应为有效的 YYYY-MM-DD 北京日期');
  if(typeof description!=='string'||description.length>10000)throw failure('版本说明过长或格式不正确');
  const requestedSource=path.resolve(source);
  if((await lstat(requestedSource)).isSymbolicLink())throw failure('源码目录不能是符号链接');
  const sourceRoot=await realpath(requestedSource),outputRoot=await canonicalFuture(output);
  if(inside(sourceRoot,outputRoot)||inside(outputRoot,sourceRoot))throw failure('源码目录与归档目录不得互相嵌套');
  const sourceFiles=await filesIn(sourceRoot,{source:true});
  if(!sourceFiles.length)throw failure('不能归档空的源码目录');
  const records=sourceFiles.map(file=>({...file,path:'source/'+file.path,kind:'source'}));
  const artifactInputs=[];const artifactNames=new Set();
  for(const input of artifacts){
    const filename=path.resolve(input),info=await lstat(filename),name=path.basename(filename);
    if(info.isSymbolicLink()||!info.isFile()||!/^.+\.zip$/i.test(name)||name.length>180||/[<>:"|?*\x00-\x1f]/.test(name)||artifactNames.has(name.toLowerCase()))throw failure('安装包必须为名称唯一的实际 ZIP 文件');
    artifactNames.add(name.toLowerCase());
    const record={path:'artifacts/'+name,kind:'artifact',size:info.size,sha256:await hashFile(filename)};
    records.push(record);artifactInputs.push({filename,record});
  }
  let appVersion=null;
  for(const relative of ['skills/boss-greeting/assets/app/package.json','package.json']){
    try{appVersion=JSON.parse(await readFile(path.join(sourceRoot,relative),'utf8')).version||null;if(appVersion)break;}catch{}
  }
  const base={schemaVersion:1,version,label,commit,date,description,appVersion,timeZone:'Asia/Shanghai',sourceOrigin:path.basename(sourceRoot),createdAt:new Date().toISOString(),files:sortFiles(records)};
  const fingerprint=fingerprintFor(base),versionRoot=path.join(outputRoot,'v'+version);
  await mkdir(outputRoot,{recursive:true});
  await checkedDirectoryWithin(outputRoot,versionRoot,{create:true});
  const candidates=await readdir(versionRoot,{withFileTypes:true});
  for(const entry of candidates.filter(entry=>entry.isDirectory())){
    const candidate=path.join(versionRoot,entry.name);
    try{
      const existing=JSON.parse(await readFile(path.join(candidate,'manifest.json'),'utf8'));
      if(existing.fingerprint===fingerprint){await verifyArchive(candidate);await rebuildIndex(outputRoot);return {snapshotDir:candidate,manifestPath:path.join(candidate,'manifest.json'),reused:true,version,label,fingerprint};}
    }catch(error){if(error.publicMessage)throw error;}
  }
  let folder=label;
  if(await exists(path.join(versionRoot,folder)))folder=label+'-'+new Date().toISOString().replace(/[-:TZ.]/g,'').slice(0,17)+'-'+fingerprint.slice(0,8);
  if(await exists(path.join(versionRoot,folder)))folder+='-'+randomUUID().slice(0,8);
  const destination=path.join(versionRoot,folder),staging=path.join(outputRoot,'.staging-'+randomUUID());
  await mkdir(staging,{recursive:false});
  try{
    await checkedDirectoryWithin(outputRoot,staging);
    for(const file of sourceFiles){const target=path.join(staging,'source',file.path);await mkdir(path.dirname(target),{recursive:true});await copyFile(path.join(sourceRoot,file.path),target);}
    for(const {filename,record} of artifactInputs){const target=path.join(staging,record.path);await mkdir(path.dirname(target),{recursive:true});await copyFile(filename,target);}
    const note=['# 版本 '+version,'',`- 修订：${label}`,`- 版本日期（北京时间）：${date}`,`- Git 提交：${commit||'未记录'}`,`- 程序声明版本：${appVersion||'未记录'}`,'',description||'按所指定的源码快照留存。','', '## 内容','', '- `source/`：该修订的干净源码副本。','- `artifacts/`：明确提供的原有 ZIP 包；未提供时不表示当时存在安装包。','- `manifest.json`：文件大小、SHA256 和来源提交。','', '历史来源以 Git 提交为准；版本日期来自明确提供的记录，归档制作时间另见清单。源码不包含个人资料、密钥或运行日志。',''].join('\n');
    await writeFile(path.join(staging,'版本说明.md'),note,'utf8');
    const noteInfo=await lstat(path.join(staging,'版本说明.md'));
    const manifest={...base,fingerprint,files:sortFiles([...records,{path:'版本说明.md',kind:'notes',size:noteInfo.size,sha256:await hashFile(path.join(staging,'版本说明.md'))}])};
    await writeFile(path.join(staging,'manifest.json'),JSON.stringify(manifest,null,2)+'\n','utf8');
    await verifyArchive(staging);
    // A fresh destination is required. Existing snapshots are never replaced.
    await checkedDirectoryWithin(outputRoot,versionRoot);
    await rename(staging,destination);
    await rebuildIndex(outputRoot);
    return {snapshotDir:destination,manifestPath:path.join(destination,'manifest.json'),reused:false,version,label,fingerprint};
  }finally{
    if(path.dirname(staging)===outputRoot&&path.basename(staging).startsWith('.staging-'))await rm(staging,{recursive:true,force:true}).catch(()=>{});
  }
}

if(process.argv[1]&&(await realpath(path.resolve(process.argv[1])).catch(()=>null))===fileURLToPath(import.meta.url)){
  try{
    const {values}=parseArgs({options:{source:{type:'string'},version:{type:'string'},label:{type:'string'},artifact:{type:'string',multiple:true},commit:{type:'string'},output:{type:'string'},date:{type:'string'},description:{type:'string'},verify:{type:'string'},help:{type:'boolean'}},strict:true,allowPositionals:false});
    if(values.help)console.log('node scripts/archive-version.mjs --source CLEAN_SOURCE --version X.Y.Z [--label NAME] [--artifact ZIP] [--commit SHA] [--output DIRECTORY] [--date YYYY-MM-DD] [--description TEXT]\nnode scripts/archive-version.mjs --verify SNAPSHOT_DIRECTORY');
    else console.log(JSON.stringify(values.verify?await verifyArchive(values.verify):await archiveVersion({...values,artifacts:values.artifact||[]}),null,2));
  }catch(error){console.error(error.publicMessage||'版本归档未完成，请检查源码、安装包及目录权限；原有归档未被覆盖');process.exitCode=1;}
}
