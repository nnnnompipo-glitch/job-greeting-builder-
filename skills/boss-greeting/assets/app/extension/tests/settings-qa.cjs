/* Real Chromium settings-page fixture with mocked extension messaging. No external API calls. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const extension = path.join(__dirname,'..');
const browser = [process.env.BOSS_QA_CHROME,'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(value => value && fs.existsSync(value));
if (!browser) throw new Error('Chrome or Edge not found');
const profile = fs.mkdtempSync(path.join(os.tmpdir(),'boss-settings-qa-'));
const child = spawn(browser,['--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--disable-extensions','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
let socket, sequence=0;
const calls=new Map();
function rpc(method,params={}) {
  const id=++sequence;
  return new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{calls.delete(id);reject(new Error('CDP timeout: '+method));},15000);
    calls.set(id,{resolve,reject,timeout});
    socket.send(JSON.stringify({id,method,params}));
  });
}
async function evaluate(expression) {
  const result=await rpc('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function waitFor(expression) {
  for(let n=0;n<100;n++) {if(await evaluate(expression)) return;await delay(70);}
  throw new Error('Condition timeout: '+expression);
}
(async()=>{
  try {
    const portFile=path.join(profile,'DevToolsActivePort');
    for(let n=0;n<100&&!fs.existsSync(portFile);n++) await delay(100);
    const port=Number(fs.readFileSync(portFile,'utf8').split(/\r?\n/)[0]);
    const targets=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    socket=new WebSocket(targets.find(target=>target.type==='page').webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
    socket.addEventListener('message',event=>{
      const message=JSON.parse(event.data);
      if(!message.id||!calls.has(message.id))return;
      const item=calls.get(message.id);calls.delete(message.id);clearTimeout(item.timeout);
      message.error?item.reject(new Error(message.error.message)):item.resolve(message.result);
    });
    await rpc('Page.enable');await rpc('Runtime.enable');await rpc('Network.enable');
    await rpc('Network.setBlockedURLs',{urls:['http://*','https://*']});
    await rpc('Emulation.setDeviceMetricsOverride',{width:1100,height:1500,deviceScaleFactor:1,mobile:false});
    await rpc('Page.addScriptToEvaluateOnNewDocument',{source:`
      globalThis.__qa={messages:[],saved:null,failLoad:false,data:{model:{provider:'codex',baseUrl:'',model:'',responseFormat:'auto',timeoutMs:120000,hasApiKey:false},profile:'<!-- PROFILE_NOT_CONFIGURED -->\\n请填写真实的专业、求职城市、项目经历和技能。',profileReady:false}};
      globalThis.chrome={runtime:{sendMessage:async message=>{
        __qa.messages.push(message);
        if(message.action==='getModelSettings')return __qa.failLoad?{ok:false,error:'请先填写配对码。'}:{ok:true,data:__qa.data};
        if(message.action==='testModelSettings')return {ok:true,data:{ok:true,message:'模型连接成功。测试仅使用模拟请求。'}};
        if(message.action==='saveModelSettings'){
          __qa.saved=message;
          const model={...message.model,hasApiKey:Boolean(message.model.apiKey)};delete model.apiKey;
          __qa.data={model,profile:message.profile,profileReady:!message.profile.includes('PROFILE_NOT_CONFIGURED')};
          return {ok:true,data:__qa.data};
        }
        throw new Error('Unexpected message '+message.action);
      }}};
    `});
    await rpc('Page.navigate',{url:pathToFileURL(path.join(extension,'settings.html')).href});
    await waitFor('document.getElementById("fields")?.disabled === false');
    assert.equal(await evaluate('document.getElementById("http-fields").hidden'),true);
    await evaluate('document.getElementById("settings-form").requestSubmit()');
    await waitFor('__qa.saved !== null');
    assert.equal(await evaluate('__qa.saved.profile.startsWith("<!-- PROFILE_NOT_CONFIGURED -->")'),true);
    await evaluate('document.getElementById("provider").value="doubao";document.getElementById("provider").dispatchEvent(new Event("change"))');
    assert.equal(await evaluate('document.getElementById("base-url").value'),'https://ark.cn-beijing.volces.com/api/v3');
    await evaluate('document.getElementById("model").value="ep-test-only";document.getElementById("api-key").value="test-secret-only";document.getElementById("test-model").click()');
    await waitFor('document.getElementById("status").textContent.includes("模型连接成功")');
    assert.equal(await evaluate('"profile" in __qa.messages.find(message=>message.action === "testModelSettings")'),false);
    await evaluate('document.getElementById("profile").value="<!-- PROFILE_NOT_CONFIGURED -->\\n工业设计本科，求职地区为杭州及周边。以下为隔离测试资料：参与保鲜盒外观、三维建模、打样与工厂协同。";document.getElementById("settings-form").requestSubmit()');
    await waitFor('__qa.saved.model.provider === "doubao" && document.getElementById("fields").disabled === false');
    assert.equal(await evaluate('__qa.saved.profile.includes("PROFILE_NOT_CONFIGURED")'),false);
    assert.equal(await evaluate('document.getElementById("api-key").value'),'');
    assert.equal(await evaluate('document.getElementById("key-state").textContent.includes("已保存")'),true);
    await evaluate('document.getElementById("provider").value="ollama";document.getElementById("provider").dispatchEvent(new Event("change"));document.getElementById("model").value="local-test-model"');
    assert.equal(await evaluate('document.getElementById("base-url").value'),'http://127.0.0.1:11434/v1');
    assert.equal(await evaluate('document.getElementById("api-key").value'),'');
    await evaluate('document.getElementById("test-model").click()');
    await waitFor('document.getElementById("fields").disabled === false');
    assert.equal(await evaluate('"apiKey" in __qa.messages.filter(message=>message.action === "testModelSettings").at(-1).model'),false);
    const screenshotPath=process.argv[2];
    if(screenshotPath) {
      const screenshot=await rpc('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
      fs.mkdirSync(path.dirname(path.resolve(screenshotPath)),{recursive:true});
      fs.writeFileSync(screenshotPath,Buffer.from(screenshot.data,'base64'));
    }
    await evaluate('__qa.failLoad=true;document.getElementById("reload").click()');
    await waitFor('document.getElementById("status").textContent.includes("配对码")');
    assert.equal(await evaluate('document.getElementById("fields").disabled'),true);
    assert.equal(await evaluate('document.getElementById("retry-load").hidden'),false);
    console.log(JSON.stringify({ok:true,assertions:11,screenshot:screenshotPath||null}));
  } finally {
    socket?.close();child.kill();await delay(500);
    const resolved=path.resolve(profile);
    if(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('boss-settings-qa-'))try{fs.rmSync(resolved,{recursive:true,force:true});}catch{}
  }
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
