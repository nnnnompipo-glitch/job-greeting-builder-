import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {SettingsStore} from '../server/settings.mjs';
import {DocumentImportManager} from '../server/imports.mjs';
import {createHelperServer} from '../server/http.mjs';

test('preferences and document import endpoints require pairing and keep imported text separate from profile',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'boss-features-http-'));
  const profile='测试候选人为工业设计本科，曾参与厨房收纳产品外观、建模、打样和工厂协同。当前偏好杭州及周边工业设计岗位，未确认的资历和成果不得补充。'.repeat(2);
  await mkdir(path.join(root,'private'));
  const config={port:43127,token:'fixture-only',model:{provider:'codex'}};
  await writeFile(path.join(root,'private','config.json'),JSON.stringify(config),'utf8');
  await writeFile(path.join(root,'private','profile.md'),profile,'utf8');
  const settings=new SettingsStore({root,config});
  const imports=new DocumentImportManager({root});
  let cancelled=0;
  const port=50100+Math.floor(Math.random()*1000);
  const server=createHelperServer({token:'fixture-only',settings,imports,queue:{cancelPending:()=>{cancelled++;}},profileReady:()=>settings.ready(),port});
  server.listen(port,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${port}`,headers={'X-Boss-Helper-Token':'fixture-only','Content-Type':'application/json'};
  try{
    assert.equal((await fetch(base+'/api/preferences')).status,401);
    assert.equal((await fetch(base+'/api/imports',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
    const changed=await fetch(base+'/api/preferences',{method:'PUT',headers,body:JSON.stringify({tone:'creative'})});
    assert.equal(changed.status,200);assert.deepEqual(await changed.json(),{tone:'creative'});assert.equal(cancelled,2);
    const invalid=await fetch(base+'/api/preferences',{method:'PUT',headers,body:JSON.stringify({tone:'unknown'})});
    assert.equal(invalid.status,400);assert.equal(settings.preferences().tone,'creative');
    const text='测试导入材料，只供用户预览，不应自动加入已保存的个人资料。';
    const response=await fetch(base+'/api/imports',{method:'POST',headers,body:JSON.stringify({filename:'resume.txt',type:'text/plain',base64:Buffer.from(text).toString('base64')})});
    assert.equal(response.status,200);let task=await response.json();
    for(let n=0;!['done','error'].includes(task.status)&&n<100;n++){
      await new Promise(resolve=>setTimeout(resolve,5));task=await(await fetch(base+'/api/imports/'+task.id,{headers})).json();
    }
    assert.equal(task.status,'done');assert.equal(task.result.text,text);
    assert.equal(await readFile(path.join(root,'private','profile.md'),'utf8'),profile);
    assert.equal((await fetch(base+'/api/imports/'+task.id)).status,401);
    assert.equal((await fetch(base+'/api/imports/not-found',{headers})).status,404);
    const health=await(await fetch(base+'/api/health',{headers})).json();
    assert.deepEqual(health.supportedPlatforms,['boss','liepin','zhilian']);
    assert.equal(health.preferences.tone,'creative');
  }finally{
    await imports.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    const resolved=path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('boss-features-http-'));
    await rm(resolved,{recursive:true,force:true});
  }
});
