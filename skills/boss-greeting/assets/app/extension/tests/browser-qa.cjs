/* Isolated Chrome DOM fixture QA. All page requests are fulfilled/blocked by CDP.
 * No platform login/profile is opened; chrome.runtime and clipboard are mocked.
 * Run: node extension/tests/browser-qa.cjs [optional screenshot path]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const extension = path.join(__dirname, '..');
const browser = [process.env.BOSS_QA_CHROME, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(value => value && fs.existsSync(value));
if (!browser) throw new Error('No Chrome or Edge executable found.');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-helper-browser-qa-'));
const processHandle = spawn(browser, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
let socket;
let sequence = 0;
const calls = new Map();
const handlers = new Map();
function rpc(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { calls.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 15000);
    calls.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function waitFor(expression, timeout = 6000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await evaluate(expression)) return;
    await delay(80);
  }
  throw new Error(`Condition timed out: ${expression}`);
}

(async () => {
  try {
    const activePortFile = path.join(profile, 'DevToolsActivePort');
    for (let attempt = 0; attempt < 100 && !fs.existsSync(activePortFile); attempt++) await delay(100);
    const port = fs.readFileSync(activePortFile, 'utf8').split(/\r?\n/)[0];
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const call = calls.get(message.id);
        if (!call) return;
        calls.delete(message.id);
        clearTimeout(call.timeout);
        if (message.error) call.reject(new Error(JSON.stringify(message.error))); else call.resolve(message.result);
      } else handlers.get(message.method)?.(message.params);
    });
    await rpc('Page.enable');
    await rpc('Runtime.enable');
    await rpc('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    const fixture = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>本地岗位测试页</title><body style="font:16px system-ui;padding:50px;background:#f0f5f3"><main id="main"><h1>工业设计师 A</h1><p class="company-name">本地测试公司</p><p class="salary">8–12K</p><section class="job-sec-text">负责智能硬件产品外观设计和三维建模，参与用户研究、结构沟通、产品打样及设计方案落地。</section></main><aside class="chat-record">聊天文本不应被采集</aside></body></html>';
    const blocked = [];
    handlers.set('Fetch.requestPaused', async event => {
      if (event.request.url === 'https://www.zhipin.com/job_detail/fixture.html') {
        await rpc('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: Buffer.from(fixture).toString('base64') });
      } else {
        blocked.push(event.request.url);
        await rpc('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' });
      }
    });
    await rpc('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await rpc('Page.navigate', { url: 'https://www.zhipin.com/job_detail/fixture.html' });
    await waitFor('document.readyState === "complete"');
    await evaluate(`(() => {
      globalThis.__qa = { messages: [], listeners: [], pending: [], copied: [], stateReads: [], state: { enabled: false, paired: true, active: true, tone: 'professional' }, mode: 'instant' };
      const nativeTimeout=globalThis.setTimeout.bind(globalThis);
      globalThis.setTimeout=(callback,ms,...args)=>nativeTimeout(callback,ms===15000&&__qa.deadlineDelay?__qa.deadlineDelay:ms,...args);
      const original = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function(options) { const shadow = original.call(this, options); if (this.id === 'boss-local-greeting-helper') __qa.shadow = shadow; return shadow; };
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { __qa.copied.push(value); } } });
      globalThis.chrome = { runtime: {
        onMessage: { addListener: listener => __qa.listeners.push(listener) },
        sendMessage: async message => {
          __qa.messages.push(message);
          if (message.action === 'getState') {
            const snapshot={...__qa.state};
            if(__qa.deferState) return new Promise(resolve=>__qa.stateReads.push(()=>resolve({ok:true,data:snapshot})));
            return { ok: true, data: snapshot };
          }
          if (message.action === 'setTone') {
            if (!__qa.state.active || !__qa.state.paired) return {ok:false,code:'inactive',error:'请先回到当前岗位标签页切换语气。'};
            __qa.state.tone=message.tone;
            __qa.listeners.forEach(listener=>listener({action:'settingsChanged'}));
            return {ok:true,data:{tone:message.tone}};
          }
          if (message.action === 'setMonitoring') {
            if (!__qa.state.active) return { ok: false, code: 'inactive', error: '请先回到当前岗位标签页，再切换检测状态。' };
            if (message.enabled && !__qa.state.paired) return { ok: false, error: '请先填写配对码。' };
            __qa.state.enabled = message.enabled;
            __qa.listeners.forEach(listener => listener({ action: 'settingsChanged' }));
            return { ok: true, data: { enabled: message.enabled, paired: __qa.state.paired } };
          }
          if (!__qa.state.enabled || !__qa.state.active) return { ok: false, code: 'inactive', error: '检测已暂停。' };
          if (message.action === 'getJob' && __qa.mode === 'progress') {
            const running=!__qa.progressFinish;++__qa.progressPolls;
            return {ok:true,data:running?{id:'progress-fixture',status:'running'}:{id:'progress-fixture',status:'done',result:{greeting:'您好，希望结合工业设计项目经验进一步沟通当前岗位。',matches:[],cautions:[]}}};
          }
          if (message.action === 'observeJob') {
            if (__qa.mode === 'progress') return {ok:true,data:{id:'progress-fixture',status:'queued'}};
            if (__qa.mode === 'defer') return new Promise(resolve => __qa.pending.push({ title: message.job.title, resolve }));
            if (__qa.mode === 'error') return { ok: true, data: { id: 'failed', status: 'error', error: '测试生成失败，请手动重试。' } };
            return { ok: true, data: { id: 'fixture', status: 'done', result: { greeting: '您好，我关注贵司的' + message.job.title + '岗位，希望结合工业设计项目经验进一步沟通。', matches: [{ requirement: '外观设计', evidence: '测试项目' }], cautions: ['测试资料需核对'] } } };
          }
          throw new Error('Unexpected mock message: ' + message.action);
        }
      } };
    })()`);
    await evaluate(fs.readFileSync(path.join(extension, 'platforms.js'), 'utf8'));
    await evaluate(fs.readFileSync(path.join(extension, 'extract.js'), 'utf8'));
    await evaluate(fs.readFileSync(path.join(extension, 'code-rain.js'), 'utf8'));
    await evaluate(fs.readFileSync(path.join(extension, 'content.js'), 'utf8'));
    await waitFor('__qa.shadow?.getElementById("status").textContent.includes("检测已暂停")');
    assert.equal(await evaluate('__qa.shadow.getElementById("toggle").hidden'), false);
    assert.equal(await evaluate('__qa.shadow.getElementById("toggle").textContent'), '开启检测');
    assert.equal(await evaluate('__qa.messages.filter(message => message.action === "observeJob").length'), 0);
    assert.equal(await evaluate('__qa.shadow.getElementById("progress").hidden'),true);
    await evaluate('__qa.shadow.getElementById("toggle").click()');
    await waitFor('__qa.shadow?.querySelector("textarea").value.includes("工业设计师 A")');
    assert.equal(await evaluate('__qa.shadow.getElementById("progress-bar").getAttribute("aria-valuenow")'),'100');
    assert.equal(await evaluate('__qa.shadow.getElementById("progress").dataset.state'),'done');
    assert.equal(await evaluate('__qa.messages.filter(message => message.action === "observeJob").length'), 1);
    assert.equal(await evaluate('__qa.messages.find(message => message.action === "observeJob").job.description.includes("聊天")'), false);
    assert.equal(await evaluate('__qa.state.enabled'), true);
    await evaluate('__qa.shadow.getElementById("toggle").click()');
    await waitFor('!__qa.state.enabled && __qa.shadow.getElementById("status").textContent.includes("检测已暂停")');
    assert.equal(await evaluate('__qa.shadow.querySelector("textarea").value'), '');
    assert.equal(await evaluate('__qa.shadow.getElementById("copy").disabled'), true);
    assert.equal(await evaluate('__qa.shadow.getElementById("progress").hidden'),true);
    assert.equal(await evaluate('__qa.messages.filter(message => message.action === "observeJob").length'), 1);
    await evaluate('__qa.shadow.getElementById("toggle").click()');
    await waitFor('__qa.state.enabled && __qa.shadow.querySelector("textarea").value.includes("工业设计师 A")');
    assert.equal(await evaluate('__qa.copied.length'), 0);
    await evaluate('__qa.shadow.querySelector("textarea").value = "用户修改后的招呼语"; __qa.shadow.getElementById("copy").click()');
    assert.deepEqual(await evaluate('__qa.copied'), ['用户修改后的招呼语']);
    await evaluate('__qa.shadow.getElementById("collapse").click()');
    assert.equal(await evaluate('__qa.shadow.querySelector("main").hidden'), true);
    await evaluate('__qa.shadow.getElementById("collapse").click()');
    await evaluate('__qa.mode = "defer"; document.querySelector("h1").textContent = "工业设计师 B"');
    await waitFor('__qa.pending.length === 1');
    assert.equal(await evaluate('__qa.shadow.getElementById("progress").dataset.state'),'reading');
    assert.equal(await evaluate('__qa.shadow.getElementById("progress-bar").hasAttribute("aria-valuenow")'),false);
    assert.equal(await evaluate('__qa.shadow.querySelector("textarea").value'), '');
    // Resolve B after the DOM has already switched to C, before debounce fires.
    await evaluate('document.querySelector("h1").textContent = "工业设计师 C"; __qa.pending[0].resolve({ ok: true, data: { id: "old-b", status: "done", result: { greeting: "过期的 B 招呼语", matches: [], cautions: [] } } })');
    await delay(100);
    assert.equal(await evaluate('__qa.shadow.querySelector("textarea").value.includes("过期")'), false);
    await waitFor('__qa.pending.length === 2');
    // Revoke monitoring while C is in flight; the late response must not repaint.
    await evaluate('__qa.state.enabled = false; __qa.listeners.forEach(listener => listener({ action: "settingsChanged" })); __qa.pending[1].resolve({ ok: true, data: { id: "old-c", status: "done", result: { greeting: "暂停后的过期招呼语", matches: [], cautions: [] } } })');
    await delay(200);
    assert.equal(await evaluate('__qa.shadow.querySelector("textarea").value'), '');
    assert.equal(await evaluate('__qa.shadow.getElementById("copy").disabled'), true);
    // Resume on recommendation route with the same scoped root, then screenshot.
    await evaluate('history.pushState({}, "", "/web/geek/job-recommend"); document.getElementById("main").className = "job-detail"; __qa.mode = "instant"; __qa.state.enabled = true; __qa.listeners.forEach(listener => listener({ action: "settingsChanged" }))');
    await waitFor('__qa.shadow.querySelector("textarea").value.includes("工业设计师 C")');
    const recommendationSubmissions = await evaluate('__qa.messages.filter(message => message.action === "observeJob").length');
    await delay(5200);
    assert.equal(await evaluate('__qa.messages.filter(message => message.action === "observeJob").length'), recommendationSubmissions, 'A route already processed by scan must not submit again at the navigation interval.');
    await evaluate('__qa.mode = "error"; document.querySelector("h1").textContent = "工业设计师 D"');
    await waitFor('__qa.shadow.getElementById("status").textContent.includes("测试生成失败")');
    assert.equal(await evaluate('__qa.shadow.getElementById("progress").hidden'),true);
    const failedSubmissions = await evaluate('__qa.messages.filter(message => message.action === "observeJob").length');
    await evaluate('__qa.originalDateNow = Date.now; Date.now = () => __qa.originalDateNow() + 30000; window.dispatchEvent(new Event("focus"))');
    await delay(250);
    assert.equal(await evaluate('__qa.messages.filter(message => message.action === "observeJob").length'), failedSubmissions);
    await evaluate('Date.now = __qa.originalDateNow; __qa.mode = "instant"; __qa.shadow.getElementById("retry").click()');
    await waitFor('__qa.shadow.querySelector("textarea").value.includes("工业设计师 D")');
    const submissionsBeforeDenial = await evaluate('__qa.messages.filter(message => message.action === "observeJob").length');
    await evaluate('__qa.state.enabled = false; __qa.state.paired = false; __qa.listeners.forEach(listener => listener({ action: "settingsChanged" }))');
    await waitFor('__qa.shadow.getElementById("toggle").hidden && __qa.shadow.getElementById("status").textContent.includes("配对码")');
    assert.equal(await evaluate('__qa.messages.filter(message => message.action === "observeJob").length'), submissionsBeforeDenial);
    await evaluate('__qa.state.paired = true; __qa.state.active = false; __qa.listeners.forEach(listener => listener({ action: "settingsChanged" }))');
    await waitFor('!__qa.shadow.getElementById("toggle").hidden && __qa.shadow.getElementById("toggle").textContent === "开启检测"');
    await evaluate('__qa.shadow.getElementById("toggle").click()');
    await waitFor('__qa.shadow.getElementById("status").textContent.includes("请先回到当前岗位标签页")');
    assert.equal(await evaluate('__qa.state.enabled'), false);
    assert.equal(await evaluate('__qa.messages.filter(message => message.action === "observeJob").length'), submissionsBeforeDenial);
    await evaluate('__qa.state.active = true; __qa.listeners.forEach(listener => listener({ action: "settingsChanged" }))');
    await waitFor('!__qa.shadow.getElementById("toggle").disabled');
    await evaluate('__qa.shadow.getElementById("toggle").click()');
    await waitFor('__qa.shadow.querySelector("textarea").value.includes("工业设计师 D")');
    assert.equal(await evaluate('__qa.shadow.getElementById("tone").options.length'),4);
    // Changing tone must revoke a response created under the previous tone.
    await evaluate('__qa.mode="defer";document.querySelector("h1").textContent="工业设计师 E"');
    await waitFor('__qa.pending.length===3');
    await evaluate('__qa.shadow.getElementById("tone").value="creative";__qa.shadow.getElementById("tone").dispatchEvent(new Event("change"))');
    await waitFor('__qa.state.tone==="creative"');
    await evaluate('__qa.pending[2].resolve({ok:true,data:{id:"old-tone",status:"done",result:{greeting:"旧语气结果不应出现",matches:[],cautions:[]}}})');
    await delay(120);
    assert.equal(await evaluate('__qa.shadow.querySelector("textarea").value.includes("旧语气")'),false);
    await waitFor('__qa.pending.length===4');
    await evaluate('__qa.pending[3].resolve({ok:true,data:{id:"new-tone",status:"done",result:{greeting:"您好，希望把草图里的想法带到真实产品中，结合工业设计师 E 岗位进一步沟通。",matches:[],cautions:[]}}})');
    await waitFor('__qa.shadow.querySelector("textarea").value.includes("草图")');
    assert.equal(await evaluate('__qa.shadow.getElementById("tone").value'),'creative');
    assert.equal(await evaluate('__qa.shadow.getElementById("tone-hint").textContent.includes("简短巧思")'),true);
    await evaluate('__qa.mode="instant";__qa.deferState=true;window.dispatchEvent(new Event("focus"))');
    await waitFor('__qa.stateReads.length===1');
    await evaluate('__qa.shadow.getElementById("tone").value="bold";__qa.shadow.getElementById("tone").dispatchEvent(new Event("change"))');
    await waitFor('__qa.state.tone==="bold"');
    await evaluate('__qa.deferState=false;__qa.stateReads[0]()');
    await delay(30);
    assert.equal(await evaluate('__qa.shadow.getElementById("tone").value'),'bold','A stale getState must not revert a newly selected tone.');
    await waitFor('__qa.shadow.querySelector("textarea").value.includes("工业设计师 E")');
    const platformFixtures=await evaluate(`(() => {
      const fixture=document.createElement('div');document.body.append(fixture);
      const scoped={querySelectorAll:selector=>fixture.querySelectorAll(selector)};
      fixture.innerHTML='<section class="job-apply-container"><div class="name-box"><span class="name">猎聘测试设计师</span></div><div class="job-properties">杭州 本科</div></section><section class="job-apply-container-desc"><section class="job-intro-container"><dd data-selector="job-intro-content">负责产品外观设计、三维建模、用户调研、手板验证，并与结构工程师共同推进产品量产。</dd></section></section><div class="company-info-container"><div class="company-card"><div class="content"><div class="name">猎聘测试公司</div></div></div></div><aside class="job-list">其他推荐岗位内容不应读取</aside>';
      const liepin=RecruitmentJobExtractor.extract(scoped,'https://www.liepin.com/job/1986231537.shtml');
      fixture.innerHTML='<main class="main-jobs"><div class="job-summary"><h1 class="summary-planes__title">智联测试设计师</h1></div><div class="describtion-card__detail-content">负责工业产品外观、建模和渲染，进行需求分析和工厂打样，协同结构开发完成设计落地。</div><div class="company-info__name">智联测试公司</div><aside class="jobs-deliver">相似岗位列表不应读取</aside></main>';
      const zhilian=RecruitmentJobExtractor.extract(scoped,'https://www.zhaopin.com/jobdetail/CC123456J123456.htm');
      fixture.querySelector('.describtion-card__detail-content').classList.add('describtion-card__detail-content--guest-clamp');
      const clamped=RecruitmentJobExtractor.extract(scoped,'https://www.zhaopin.com/jobdetail/CC123456J123456.htm');
      fixture.remove();return {liepin,zhilian,clamped};
    })()`);
    assert.equal(platformFixtures.liepin.platform,'liepin');assert.equal(platformFixtures.liepin.company,'猎聘测试公司');
    assert.equal(platformFixtures.zhilian.platform,'zhilian');assert.equal(platformFixtures.zhilian.company,'智联测试公司');assert.equal(platformFixtures.clamped,null);
    // A site render can remove our root while a background read is still pending.
    await evaluate('__qa.deferState=true;__qa.stateReads=[];window.dispatchEvent(new Event("focus"))');
    await waitFor('__qa.stateReads.length>0');
    await evaluate('document.getElementById("boss-local-greeting-helper").remove()');
    await waitFor('Boolean(document.getElementById("boss-local-greeting-helper")) && __qa.shadow.host.isConnected');
    assert.equal(await evaluate('document.querySelectorAll("#boss-local-greeting-helper").length'),1);
    await evaluate('__qa.deferState=false;__qa.stateReads.forEach(release=>release())');
    await waitFor('__qa.shadow.querySelector("textarea").value.includes("工业设计师 E")');
    await evaluate('__qa.deadlineDelay=80;__qa.deferState=true;window.dispatchEvent(new Event("focus"))');
    await waitFor('__qa.shadow.getElementById("status").textContent.includes("响应超时")');
    await evaluate('__qa.deferState=false;__qa.deadlineDelay=0;__qa.shadow.getElementById("retry").click()');
    await waitFor('__qa.shadow.getElementById("status").textContent.includes("已生成")');
    await evaluate('__qa.mode="progress";__qa.progressPolls=0;document.querySelector("h1").textContent="工业设计师 F"');
    await waitFor('__qa.shadow.getElementById("progress").dataset.state==="queued"');
    assert.equal(await evaluate('__qa.shadow.getElementById("progress-bar").hasAttribute("aria-valuenow")'),false);
    await waitFor('__qa.shadow.getElementById("progress").dataset.state==="running"');
    await waitFor('Array.from(__qa.shadow.querySelector("canvas").getContext("2d").getImageData(0,0,__qa.shadow.querySelector("canvas").width,__qa.shadow.querySelector("canvas").height).data).some((v,i)=>i%4===3&&v>0)');
    assert.equal(await evaluate('__qa.shadow.getElementById("status").hidden'),true);
    assert.equal(await evaluate('__qa.shadow.getElementById("greeting").getAttribute("aria-busy")'),'true');
    assert.equal(await evaluate('getComputedStyle(__qa.shadow.querySelector(".progress-fill")).animationName'),'greeting-progress');
    if(process.argv[2]){
      const clip=await evaluate('(()=>{const r=document.getElementById("boss-local-greeting-helper").getBoundingClientRect();return {x:r.x-8,y:r.y-8,width:r.width+16,height:r.height+16,scale:1}})()');
      const runningShot=await rpc('Page.captureScreenshot',{format:'png',clip});
      const runningPath=path.resolve(process.argv[2]).replace(/\.png$/i,'-generating.png');
      fs.mkdirSync(path.dirname(runningPath),{recursive:true});fs.writeFileSync(runningPath,Buffer.from(runningShot.data,'base64'));
      const markup=await evaluate('__qa.shadow.innerHTML');
      const rainCode=fs.readFileSync(path.join(extension,'code-rain.js'),'utf8');
      const previewScript=`${rainCode}\nconst shadow=document.getElementById('demo').attachShadow({mode:'open'});shadow.innerHTML=${JSON.stringify(markup)};
        const effect=RecruitmentCodeRain.mount(shadow.querySelector('canvas'),shadow.querySelector('section'));
        shadow.querySelectorAll('button,select').forEach(item=>item.disabled=true);
        let timers=[];function stage(state,label,badge){const bar=shadow.getElementById('progress-bar');shadow.getElementById('progress').dataset.state=state;shadow.getElementById('progress-label').textContent=label;shadow.getElementById('progress-stage').textContent=badge;effect.setStage(state);if(state==='done'){bar.setAttribute('aria-valuenow','100');shadow.getElementById('greeting').value='招呼语已就绪。这里使用模拟任务展示背景动画。';}else bar.removeAttribute('aria-valuenow');}
        function replay(){timers.forEach(clearTimeout);shadow.getElementById('greeting').value='';stage('reading','读取岗位信息','准备中');timers=[setTimeout(()=>stage('queued','等待生成招呼语','排队中'),2000),setTimeout(()=>stage('running','正在生成招呼语','生成中'),4000),setTimeout(()=>stage('done','招呼语已就绪','已完成'),18000)];}
        document.getElementById('replay').addEventListener('click',replay);replay();
        document.addEventListener('visibilitychange',()=>effect.setVisible(document.visibilityState==='visible'));`;
      const preview='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>代码雨 · 动画预览</title><style>body{margin:0;padding:28px;background:#050b09;color:#b8dec9;font:14px/1.7 system-ui;display:grid;justify-content:center;gap:12px}h1{font-size:20px;margin:0}p{margin:0;color:#8bab98}#demo{width:342px;max-width:calc(100vw - 56px)}#replay{padding:10px;border:1px solid #2e6545;border-radius:8px;background:#123422;color:#b9f5d0;cursor:pointer}</style><h1>代码雨 · 动画预览</h1><p>模拟任务，18 秒后完成并清除粒子。</p><div id="demo"></div><button id="replay">重新播放动画</button><script>'+previewScript.replace(/<\/script/gi,'<\\/script')+'</script></html>';
      fs.writeFileSync(path.resolve(process.argv[2]).replace(/\.png$/i,'-preview.html'),preview);
    }
    await rpc('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    assert.equal(await evaluate('getComputedStyle(__qa.shadow.querySelector(".progress-fill")).animationName'),'none');
    await waitFor('Array.from(__qa.shadow.querySelector("canvas").getContext("2d").getImageData(0,0,__qa.shadow.querySelector("canvas").width,__qa.shadow.querySelector("canvas").height).data).every(v=>v===0)');
    await rpc('Emulation.setEmulatedMedia',{features:[]});
    await evaluate('__qa.progressFinish=true');
    await waitFor('__qa.shadow.getElementById("progress").dataset.state==="done"');
    assert.equal(await evaluate('__qa.shadow.getElementById("progress-bar").getAttribute("aria-valuenow")'),'100');
    assert.equal(await evaluate('__qa.shadow.getElementById("greeting").getAttribute("aria-busy")'),'false');
    assert.equal(await evaluate('Array.from(__qa.shadow.querySelector("canvas").getContext("2d").getImageData(0,0,__qa.shadow.querySelector("canvas").width,__qa.shadow.querySelector("canvas").height).data).every(v=>v===0)'),true);
    const screenshotPath = process.argv[2];
    if (screenshotPath) {
      const screenshot = await rpc('Page.captureScreenshot', { format: 'png' });
      fs.mkdirSync(path.dirname(path.resolve(screenshotPath)), { recursive: true });
      fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
    }
    console.log(JSON.stringify({ ok: true, assertions: ['paired paused state shows enable button without submitting', 'page enable button starts generation', 'page pause button clears output and stops submission', 'page enable can resume again', 'unpaired page hides enable button', 'inactive page cannot enable or submit', 'scoped extraction', 'one submission per unchanged job', 'no implicit clipboard write', 'editable explicit copy', 'collapse', 'clears on job switch', 'blocks stale result before debounce', 'pause revokes pending result', 'recommendation route', 'processed route not resubmitted by navigation interval', 'failed job does not auto-retry after clock advance', 'explicit retry resumes generation','four tones only','changing tone blocks old-tone response','tone hint matches current selection','late getState cannot revert tone selection','Liepin scoped DOM extraction','Zhilian scoped DOM extraction','guest-clamped description not read','panel restored while background state read is pending','queued and running animation without fictional percentages','completion is 100 percent','pause and error clear progress','reduced motion disables animation','code rain renders pixels while generating','completion clears code rain canvas','reduced motion clears code rain canvas'], externalRequestsBlocked: blocked.length, screenshot: screenshotPath || null }));
  } finally {
    socket?.close();
    processHandle.kill();
    await delay(500);
    const resolvedProfile = path.resolve(profile);
    if (resolvedProfile.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolvedProfile).startsWith('boss-helper-browser-qa-')) {
      try { fs.rmSync(resolvedProfile, { recursive: true, force: true }); } catch { /* Chrome can retain short-lived cleanup locks. */ }
    }
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
