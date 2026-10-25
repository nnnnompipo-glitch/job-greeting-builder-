import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';

export const IMPORT_LIMITS = Object.freeze({maxBytes:25*1024*1024,maxPages:40,maxCharacters:120000});
const MIME = {'.pdf':['application/pdf'],'.png':['image/png'],'.jpg':['image/jpeg','image/jpg'],'.jpeg':['image/jpeg','image/jpg'],'.bmp':['image/bmp','image/x-ms-bmp'],'.txt':['text/plain'],'.md':['text/plain','text/markdown','text/x-markdown']};
const error = message => Object.assign(new Error(message),{publicMessage:message});
const PUBLIC_ERRORS = {
  ocr_unavailable:'Windows没有可用的OCR语言，请在Windows语言设置中添加中文或英文OCR组件后重试',
  image_too_large:'图片像素尺寸过大，请缩小到10000像素以内、总像素不超过4000万后重试',
  no_text:'未识别到可用文字，请检查图片清晰度，或复制文字后手动添加',
  unsupported_type:'只支持PDF、PNG、JPG、JPEG、BMP、TXT和MD文件',
  read_failed:'无法读取文件，可能损坏、受密码保护，或当前Windows不支持本地OCR'
};

function validateUpload(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw error('导入文件格式不正确');
  const {filename,type='',base64} = input;
  if (typeof filename !== 'string' || !filename.trim() || filename.length > 200 || filename !== path.basename(filename) || /[\\/:<>"|?*\x00-\x1f]/.test(filename) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(filename)) throw error('文件名不正确，请使用普通文件名');
  const extension = path.extname(filename).toLowerCase();
  if (!MIME[extension]) throw error(PUBLIC_ERRORS.unsupported_type);
  if (typeof type !== 'string' || (type && type !== 'application/octet-stream' && !MIME[extension].includes(type.toLowerCase()))) throw error('文件类型与扩展名不一致');
  const maxBase64 = Math.ceil(IMPORT_LIMITS.maxBytes/3)*4;
  if (typeof base64 !== 'string' || !base64 || base64.length > maxBase64 || base64.length % 4) throw error('文件编码不正确，或文件超过25MiB上限');
  const padding=base64.endsWith('==')?2:base64.endsWith('=')?1:0;
  if (/[^A-Za-z0-9+/]/.test(base64.slice(0,base64.length-padding))) throw error('文件编码不正确，请重新选择文件');
  const bytes=Buffer.from(base64,'base64');
  if (!bytes.length || bytes.length>IMPORT_LIMITS.maxBytes || bytes.toString('base64') !== base64) throw error('文件编码不正确，或文件超过25MiB上限');
  const magic = extension === '.pdf' ? bytes.subarray(0,8).toString('ascii').startsWith('%PDF-') :
    extension === '.png' ? bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) :
    extension === '.jpg' || extension === '.jpeg' ? bytes[0]===255 && bytes[1]===216 && bytes[2]===255 :
    extension === '.bmp' ? bytes[0]===66 && bytes[1]===77 : true;
  if (!magic) throw error('文件内容与扩展名不一致，请选择原始PDF或图片文件');
  if ((extension === '.txt' || extension === '.md') && bytes.includes(0)) throw error('文本包含二进制内容，请另存为UTF-8文本后重试');
  return {filename,extension,bytes};
}

function normalizeResult(result) {
  if (!result || typeof result.text !== 'string') throw error('本地文字识别未返回可用结果');
  const warnings = Array.isArray(result.warnings) ? result.warnings.filter(item=>typeof item==='string').slice(0,12) : [];
  let text=result.text.replace(/^\uFEFF/,'').trim();
  if (text.length>IMPORT_LIMITS.maxCharacters) {text=text.slice(0,IMPORT_LIMITS.maxCharacters);warnings.push('文字超过120000字符，已截断，请分批导入。');}
  if (!text) throw error(PUBLIC_ERRORS.no_text);
  return {text,characters:text.length,pageCount:Number.isInteger(result.pageCount)&&result.pageCount>0 ? Math.min(result.pageCount,IMPORT_LIMITS.maxPages) : 1,method:typeof result.method==='string'?result.method:'local',warnings};
}

export async function extractWindowsDocument({root,filePath,maxPages=IMPORT_LIMITS.maxPages,maxCharacters=IMPORT_LIMITS.maxCharacters,signal,onProgress=()=>{}}) {
  if (process.platform!=='win32') throw error('PDF和图片识别需要Windows 10/11本地OCR；其他系统可先导入TXT或MD文字');
  const executable=process.env.SystemRoot ? path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe') : 'powershell.exe';
  const script=path.join(root,'scripts','import-document.ps1');
  const child=spawn(executable,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-InputPath',filePath,'-MaxPages',String(maxPages),'-MaxCharacters',String(maxCharacters)],{cwd:root,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let buffer='',size=0,result,failureCode='',oversized=false,timedOut=false;
  child.stdout.setEncoding('utf8');
  child.stderr.on('data',()=>{});
  function consume(line) {
    if (!line.trim()) return;
    let item;
    try {item=JSON.parse(line.replace(/^\uFEFF/,''));} catch {return;}
    if (item.event==='progress' && Number.isFinite(item.progress)) onProgress(Math.min(99,Math.max(0,item.progress)));
    if (item.event==='result') result=item.result;
    if (item.event==='error') failureCode=item.code;
  }
  child.stdout.on('data',chunk=>{
    size+=Buffer.byteLength(chunk,'utf8');
    if (size>2*1024*1024) {oversized=true;child.kill();return;}
    buffer+=chunk;
    let newline;
    while((newline=buffer.indexOf('\n'))!==-1) {consume(buffer.slice(0,newline));buffer=buffer.slice(newline+1);}
  });
  const abort=()=>child.kill();
  signal?.addEventListener('abort',abort,{once:true});
  if (signal?.aborted) child.kill();
  const deadline=setTimeout(()=>{timedOut=true;child.kill();},300000);
  try {
    const code=await new Promise((resolve,reject)=>{child.once('error',()=>reject(error('无法启动Windows本地文字识别，请检查系统组件')));child.once('close',resolve);});
    consume(buffer);
    if (signal?.aborted) throw error('文件导入已停止');
    if (timedOut) throw error('本地识别超过5分钟，已停止；请拆分文件或降低图片分辨率后重试');
    if (oversized) throw error('本地识别返回内容过长，已停止本次导入');
    if (code!==0 || !result) throw error(PUBLIC_ERRORS[failureCode] || PUBLIC_ERRORS.read_failed);
    return normalizeResult(result);
  } finally {clearTimeout(deadline);signal?.removeEventListener('abort',abort);buffer='';}
}

export class DocumentImportManager {
  constructor({root,extractor,maxQueued=3,maxRecords=12,ttlMs=30*60*1000}={}) {
    if (!root) throw new Error('DocumentImportManager requires root');
    this.root=path.resolve(root);this.importsRoot=path.join(this.root,'private','imports');
    this.extractor=extractor || (options=>extractWindowsDocument({...options,root:this.root}));
    this.maxQueued=maxQueued;this.maxRecords=maxRecords;this.ttlMs=ttlMs;
    this.records=new Map();this.pending=[];this.current=null;this.reserved=0;this.closed=false;
  }
  public(record) {return record ? {id:record.id,status:record.status,filename:record.filename,progress:record.progress,...(record.result?{result:record.result}:{}),...(record.error?{error:record.error}:{})} : null;}
  prune() {
    const now=Date.now();
    for(const [id,record] of this.records) if (!['queued','running'].includes(record.status) && (now-record.finished>this.ttlMs || this.records.size>this.maxRecords)) this.records.delete(id);
  }
  get(id) {this.prune();return this.public(this.records.get(id));}
  async removeOwned(filename) {
    const absolute=path.resolve(filename),parent=path.resolve(this.importsRoot)+path.sep;
    if (!absolute.startsWith(parent) || path.dirname(absolute)!==path.resolve(this.importsRoot) || !/^[\da-f-]{36}\.(?:pdf|png|jpg|jpeg|bmp|txt|md)$/i.test(path.basename(absolute))) return;
    await unlink(absolute).catch(()=>{});
  }
  async submit(input) {
    if (this.closed) throw error('文件导入服务已停止');
    if (this.pending.length+this.reserved+(this.current?1:0)>=this.maxQueued+1) throw error('待识别文件较多，请等待当前文件完成后再添加');
    const {filename,extension,bytes}=validateUpload(input);
    this.reserved++;
    const id=randomUUID(),filePath=path.join(this.importsRoot,id+extension);
    try {
      await mkdir(this.importsRoot,{recursive:true});
      await writeFile(filePath,bytes,{flag:'wx',mode:0o600});
      if (this.closed) {await this.removeOwned(filePath);throw error('文件导入服务已停止');}
      const record={id,filename,status:'queued',progress:0,filePath,extension};
      this.prune();this.records.set(id,record);this.pending.push(record);this.pump();
      return this.public(record);
    } catch(cause) {await this.removeOwned(filePath);throw cause.publicMessage ? cause : error('无法保存本地导入文件，请检查目录写入权限');}
    finally {this.reserved--;}
  }
  pump() {
    if (this.closed || this.current || !this.pending.length) return;
    const record=this.pending.shift();this.current=record;record.status='running';record.progress=1;
    const controller=new AbortController();record.controller=controller;
    Promise.resolve().then(async()=>{
      if (record.extension==='.txt'||record.extension==='.md') {
        let text;
        try {text=new TextDecoder('utf-8',{fatal:true}).decode(await readFile(record.filePath));}
        catch {throw error('文本不是有效UTF-8编码，请另存为UTF-8后重试');}
        return normalizeResult({text,pageCount:1,method:'utf8-text',warnings:[]});
      }
      return normalizeResult(await this.extractor({filename:record.filename,filePath:record.filePath,extension:record.extension,maxPages:IMPORT_LIMITS.maxPages,maxCharacters:IMPORT_LIMITS.maxCharacters,signal:controller.signal,onProgress:value=>{if(Number.isFinite(value))record.progress=Math.min(99,Math.max(record.progress,value));}}));
    }).then(result=>{if(controller.signal.aborted) throw error('文件导入已停止');record.result=result;record.status='done';record.progress=100;})
      .catch(cause=>{record.error=cause.publicMessage || '本地文字识别失败，请检查文件或Windows OCR组件';record.status='error';})
      .finally(async()=>{record.finished=Date.now();await this.removeOwned(record.filePath);delete record.controller;this.current=null;this.prune();this.pump();});
  }
  async close() {
    this.closed=true;
    this.current?.controller.abort();
    const pending=this.pending.splice(0);
    for(const record of pending) {record.status='error';record.error='文件导入已停止';record.finished=Date.now();await this.removeOwned(record.filePath);}
  }
}
