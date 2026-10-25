import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,access,rm,realpath} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';

const stopScript=fileURLToPath(new URL('../scripts/stop.ps1',import.meta.url));
const quote=value=>"'"+String(value).replaceAll("'","''")+"'";
async function fixture(run) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'boss-stop-recovery-'));
  const root=path.join(await realpath(directory),'Helper With Spaces');
  await mkdir(path.join(root,'private/imports'),{recursive:true});
  try {return await run({root,entry:path.join(root,'server/index.mjs'),pidFile:path.join(root,'private/server.pid')});}
  finally {
    const absolute=path.resolve(directory);
    assert.ok(absolute.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(absolute).startsWith('boss-stop-recovery-'));
    await rm(absolute,{recursive:true,force:true});
  }
}
function invoke(root,{processes={},children={},listeners=[],scenario=''}={}) {
  const encoded=Buffer.from(JSON.stringify({processes,children,listeners})).toString('base64');
  const code=`
    . ${quote(stopScript)}
    $fixtureData=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
    $script:stopped=@()
    function Get-NetTCPConnection { param($LocalPort,$State) $fixtureData.listeners | ForEach-Object { [pscustomobject]@{OwningProcess=$_} } }
    function Get-CimInstance {
      param($ClassName,$Filter)
      if($Filter -match '^ProcessId = (\\d+)$') { $fixtureData.processes.PSObject.Properties[$matches[1]].Value }
      elseif($Filter -match '^ParentProcessId = (\\d+)$') { $fixtureData.children.PSObject.Properties[$matches[1]].Value }
    }
    function Stop-Process { param([int]$Id) $script:stopped+= $Id }
    $errorText=$null
    try { ${scenario || `Stop-BossHelper ${quote(root)}`} } catch { $errorText=$_.Exception.Message }
    [pscustomobject]@{stopped=@($script:stopped);error=$errorText} | ConvertTo-Json -Compress
  `;
  const result=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(result.status,0,result.stderr);
  const lastLine=result.stdout.trim().split(/\r?\n/).at(-1);
  return JSON.parse(lastLine);
}
const nodeProcess=(entry,id=7800)=>({ProcessId:id,Name:'node.exe',CommandLine:`"C:\\Other Node\\node.exe" "${entry}"`});

test('stop recovers the exact owned listener when the PID file is stale or missing',{skip:process.platform!=='win32'},async()=>{
  for(const recorded of [null,'9712','invalid-pid']) await fixture(async({root,entry,pidFile})=>{
    if(recorded!==null) await writeFile(pidFile,recorded);
    const result=invoke(root,{listeners:[7800,7800],processes:{7800:nodeProcess(entry.replaceAll('\\','/'))}});
    assert.deepEqual(result.stopped,[7800]);assert.equal(result.error,null);
    await assert.rejects(()=>access(pidFile));
  });
});

test('stale PID reused by a foreign process does not prevent stopping the verified listener',{skip:process.platform!=='win32'},async()=>{
  await fixture(async({root,entry,pidFile})=>{
    await writeFile(pidFile,'9712');
    const result=invoke(root,{listeners:[7800],processes:{7800:nodeProcess(entry),9712:nodeProcess('C:\\Other Helper\\server\\index.mjs',9712)}});
    assert.deepEqual(result.stopped,[7800]);assert.equal(result.error,null);
  });
});

test('foreign listener, lookalike script and embedded path cannot be stopped',{skip:process.platform!=='win32'},async()=>{
  await fixture(async({root,entry,pidFile})=>{
    await writeFile(pidFile,'9712');
    for(const processInfo of [nodeProcess('C:\\Other Helper\\server\\index.mjs'),nodeProcess(entry+'.bak'),
      {...nodeProcess(entry),Name:'powershell.exe'},
      {...nodeProcess(entry),CommandLine:`node.exe C:\\other.mjs "${entry}"`}]) {
      const result=invoke(root,{listeners:[7800],processes:{7800:processInfo}});
      assert.deepEqual(result.stopped,[]);assert.match(result.error,/outside this helper directory/);
      assert.equal(await readFile(pidFile,'utf8'),'9712');
    }
  });
});

test('owned recorded PID is stopped without a listener and cleanup is limited to generated import files',{skip:process.platform!=='win32'},async()=>{
  await fixture(async({root,entry,pidFile})=>{
    await writeFile(pidFile,'7800');
    const generated=path.join(root,'private/imports/12345678-1234-1234-1234-123456789abc.pdf');
    const original=path.join(root,'private/imports/original-resume.pdf');
    const outside=path.join(root,'private/12345678-1234-1234-1234-123456789abc.pdf');
    await Promise.all([generated,original,outside].map(file=>writeFile(file,'fixture')));
    const result=invoke(root,{processes:{7800:nodeProcess(entry)},children:{7800:[
      {ProcessId:8100,Name:'codex.exe',CommandLine:`codex.exe exec -C "${path.join(root,'private/model-workspace')}"`},
      {ProcessId:8101,Name:'powershell.exe',CommandLine:`powershell.exe -File "${path.join(root,'scripts/import-document.ps1')}"`},
      {ProcessId:8102,Name:'powershell.exe',CommandLine:'powershell.exe -File C:\\Other\\import-document.ps1'}
    ]}});
    assert.equal(result.error,null);assert.deepEqual(result.stopped,[8100,8101,7800]);
    await assert.rejects(()=>access(generated));await access(original);await access(outside);
  });
});
