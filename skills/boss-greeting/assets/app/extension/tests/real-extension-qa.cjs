// Real MV3 smoke test. Chrome 139+; isolated temporary profile, never a daily profile.
// Default: private fixture health server on 43127. If the helper is running, supply
// --pairing-file <helper/private/pairing.txt> to test its real /api/health instead.
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const assert=require('node:assert/strict');
const {randomBytes}=require('node:crypto');
const {createServer}=require('node:http');
const {spawn}=require('node:child_process');
const {parseArgs}=require('node:util');
const {setTimeout:delay}=require('node:timers/promises');

const {values}=parseArgs({options:{chrome:{type:'string'},'pairing-file':{type:'string'}}});
const chrome=values.chrome||path.join(process.env.PROGRAMFILES||'', 'Google/Chrome/Application/chrome.exe');
const source=path.resolve(__dirname,'..');
const deadline=async(predicate,message)=>{
  for(let n=0;n<180;n++){if(await predicate())return;await delay(100);}
  throw new Error(message);
};

async function launch(extension,profile,token,first){
  const child=spawn(chrome,['--headless=new','--no-first-run','--no-default-browser-check',
    '--disable-background-networking','--disable-component-update','--disable-sync',
    '--remote-debugging-pipe','--enable-unsafe-extension-debugging',`--user-data-dir=${profile}`,'about:blank'],
    {windowsHide:true,stdio:['ignore','ignore','ignore','pipe','pipe']});
  let buffer='',seq=0;
  const pending=new Map(),events=new Map();
  child.on('error',()=>{for(const call of pending.values())call.reject(new Error('Chrome could not start.'));});
  child.stdio[4].on('data',chunk=>{
    buffer+=chunk.toString('utf8');let split;
    while((split=buffer.indexOf('\0'))>=0){
      const line=buffer.slice(0,split);buffer=buffer.slice(split+1);if(!line)continue;
      const message=JSON.parse(line),call=pending.get(message.id);
      if(message.method)events.get(`${message.sessionId}:${message.method}`)?.(message.params);
      if(call){pending.delete(message.id);clearTimeout(call.timer);
        message.error?call.reject(new Error(message.error.message)):call.resolve(message.result);}
    }
  });
  const rpc=(method,params={},sessionId)=>new Promise((resolve,reject)=>{
    const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Timeout: ${method}`));},22000);
    pending.set(id,{resolve,reject,timer});
    child.stdio[3].write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+'\0');
  });
  const evaluate=async(sessionId,expression)=>{
    const result=await rpc('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);
    if(result.exceptionDetails)throw new Error('Extension page evaluation failed.');
    return result.result.value;
  };
  let extensionId;
  const navigationPanels=async()=>{
    const fixtures=[
      ['https://www.zhipin.com/web/geek/index','/job_detail/fixture.html','/web/geek/chat'],
      ['https://www.liepin.com/','/job/1986231537.shtml','/zhaopin/'],
      ['https://www.zhaopin.com/','/jobdetail/CC123456J123456.htm','/chat']
    ];
    for(const [start,detail,outside] of fixtures){
      const {targetId}=await rpc('Target.createTarget',{url:'about:blank'});
      const {sessionId}=await rpc('Target.attachToTarget',{targetId,flatten:true});
      try{
        await rpc('Runtime.enable',{},sessionId);await rpc('Page.enable',{},sessionId);
        const html='<!doctype html><meta charset="utf-8"><title>Isolated navigation fixture</title><main id="main"><h1>测试设计师</h1><div class="job-sec-text">负责产品工业设计、三维建模和用户调研，协同结构开发并参与手板打样与设计落地。</div></main>';
        events.set(`${sessionId}:Fetch.requestPaused`,event=>{
          const action=event.resourceType==='Document'?'Fetch.fulfillRequest':'Fetch.failRequest';
          const params=event.resourceType==='Document'?{requestId:event.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'text/html; charset=utf-8'}],body:Buffer.from(html).toString('base64')}:{requestId:event.requestId,errorReason:'BlockedByClient'};
          rpc(action,params,sessionId).catch(()=>{});
        });
        await rpc('Fetch.enable',{patterns:[{urlPattern:'*'}]},sessionId);
        await rpc('Page.navigate',{url:start},sessionId);
        await deadline(()=>evaluate(sessionId,'document.readyState==="complete"'),'Fixture did not load');
        await delay(300);
        const panel='document.getElementById("boss-local-greeting-helper")';
        assert.equal(await evaluate(sessionId,`Boolean(${panel})`),false,'Non-job entry showed a panel');
        await evaluate(sessionId,`history.pushState({},'',${JSON.stringify(detail)})`);
        await deadline(()=>evaluate(sessionId,`Boolean(${panel}?.getBoundingClientRect().width)`),'Panel missing after same-document job navigation');
        await evaluate(sessionId,`${panel}.remove()`);
        await deadline(()=>evaluate(sessionId,`Boolean(${panel})`),'Removed panel did not recover');
        await evaluate(sessionId,`history.pushState({},'',${JSON.stringify(outside)})`);
        await deadline(()=>evaluate(sessionId,`!${panel}`),'Panel did not leave non-job route');
        await evaluate(sessionId,'history.back()');
        await deadline(()=>evaluate(sessionId,`Boolean(${panel})`),'Panel missing after browser back');
        assert.equal(await evaluate(sessionId,'document.querySelectorAll("#boss-local-greeting-helper").length'),1,'Duplicate panels');
      }finally{
        events.delete(`${sessionId}:Fetch.requestPaused`);await rpc('Target.closeTarget',{targetId});
      }
    }
    return {platforms:fixtures.length,spaEntry:true,removedPanelRecovery:true,nonJobTeardown:true,browserBack:true};
  };
  const openPopup=async()=>{
    const tabs=(await rpc('Target.getTargets',{filter:[{type:'tab'}]})).targetInfos;
    const tab=tabs.find(t=>t.url==='about:blank')||tabs[0];
    assert.ok(tab,'No isolated test tab');
    await rpc('Target.activateTarget',{targetId:tab.targetId});
    await rpc('Extensions.triggerAction',{id:extensionId,targetId:tab.targetId});
    let target;
    await deadline(async()=>{
      target=(await rpc('Target.getTargets')).targetInfos.find(t=>t.url===`chrome-extension://${extensionId}/popup.html`);
      return Boolean(target);
    },'Toolbar popup did not open');
    const {sessionId}=await rpc('Target.attachToTarget',{targetId:target.targetId,flatten:true});
    await rpc('Runtime.enable',{},sessionId);
    await deadline(()=>evaluate(sessionId,'document.readyState==="complete"'),'Popup did not load');
    await deadline(()=>evaluate(sessionId,'!document.querySelector("#status").textContent.includes("正在读取")'),'Settings read did not finish');
    return {sessionId,targetId:target.targetId};
  };
  const testConnection=async(popup)=>{
    await evaluate(popup.sessionId,'document.querySelector("#test").click()');
    await deadline(()=>evaluate(popup.sessionId,'!document.querySelector("#test").disabled'),'Connection button stayed disabled');
    const connected=await evaluate(popup.sessionId,'document.querySelector("#status").textContent.includes("连接成功")');
    assert.equal(connected,true,'The extension could not reach the paired local health endpoint');
  };
  try{
    const browser=(await rpc('Browser.getVersion')).product;
    const loaded=await rpc('Extensions.loadUnpacked',{path:extension});extensionId=loaded.id||loaded.extensionId;
    let popup=await openPopup();
    let navigation;
    if(first){
      // Unpaired fixtures cannot submit jobs or contact the live model.
      await rpc('Target.closeTarget',{targetId:popup.targetId});await delay(400);
      navigation=await navigationPanels();popup=await openPopup();
    }
    if(first){
      await evaluate(popup.sessionId,`document.querySelector('#token').value=${JSON.stringify(token)};document.querySelector('#save').click()`);
      await deadline(()=>evaluate(popup.sessionId,'document.querySelector("#status").textContent.includes("已保存")'),'Pairing did not save');
    }
    assert.equal(await evaluate(popup.sessionId,`document.querySelector('#token').value===${JSON.stringify(token)}`),true,'Pairing missing after browser restart');
    await testConnection(popup);
    await rpc('Target.closeTarget',{targetId:popup.targetId});await delay(400);
    popup=await openPopup();
    assert.equal(await evaluate(popup.sessionId,`document.querySelector('#token').value===${JSON.stringify(token)}`),true,'Pairing missing after closing popup');
    await testConnection(popup);
    if(first){
      await evaluate(popup.sessionId,'document.querySelector("#enabled").checked=true;document.querySelector("#enabled").dispatchEvent(new Event("change"))');
      await deadline(()=>evaluate(popup.sessionId,'document.querySelector("#status").textContent.includes("已开启并保存")'),'Monitoring choice did not save');
      await rpc('Target.closeTarget',{targetId:popup.targetId});await delay(400);popup=await openPopup();
      assert.equal(await evaluate(popup.sessionId,'document.querySelector("#enabled").checked'),true,'Monitoring choice missing after reopen');
      // Only intercepted fixtures were visited; leave the test extension paused.
      await evaluate(popup.sessionId,'document.querySelector("#enabled").checked=false;document.querySelector("#enabled").dispatchEvent(new Event("change"))');
      await deadline(()=>evaluate(popup.sessionId,'document.querySelector("#status").textContent.includes("检测已暂停")'),'Pause did not save');
    }
    return {browser,realToolbarPopup:true,connectionPassed:true,popupReopenPassed:true,...(first?{navigation}:{browserRestartPassed:true})};
  }finally{
    try{await rpc('Browser.close');}catch{}
    await delay(700);if(child.exitCode===null)child.kill();
    for(const call of pending.values())clearTimeout(call.timer);
  }
}

(async()=>{
  if(!fs.existsSync(chrome))throw new Error('Chrome executable missing. Supply --chrome <path>.');
  const token=values['pairing-file']?fs.readFileSync(path.resolve(values['pairing-file']),'utf8').trim():randomBytes(32).toString('hex');
  if(!/^[A-Za-z0-9_-]{24,128}$/.test(token))throw new Error('Invalid pairing-file format.');
  let server;
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'boss-real-extension-qa-'));
  try{
    if(!values['pairing-file']){
      server=createServer((req,res)=>{
        if(req.headers['x-boss-helper-token']!==token){res.writeHead(401);res.end('{}');return;}
        if(req.url!=='/api/health'){res.writeHead(404);res.end('{}');return;}
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify({app:'boss-greeting-helper',profileReady:true,version:4}));
      });
      await new Promise((resolve,reject)=>{server.once('error',()=>reject(new Error('Port 43127 is busy. Use --pairing-file to test the running helper.')));server.listen(43127,'127.0.0.1',resolve);});
    }
    const extension=path.join(root,'extension'),profile=path.join(root,'profile');
    fs.cpSync(source,extension,{recursive:true});
    const first=await launch(extension,profile,token,true);
    const restarted=await launch(extension,profile,token,false);
    console.log(JSON.stringify({ok:true,backend:server?'fixture':'live-health-only',first,restarted}));
  }finally{
    if(server)await new Promise(resolve=>server.close(resolve));
    const absolute=path.resolve(root);
    if(absolute.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(absolute).startsWith('boss-real-extension-qa-')){
      fs.rmSync(absolute,{recursive:true,force:true,maxRetries:10,retryDelay:200});
    }
  }
})().catch(error=>{console.error('Real Chrome extension QA failed: '+error.message);process.exitCode=1;});
