const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const extension = path.join(__dirname, '..');

function element(value = '', queries = {}, options = {}) {
  return {
    innerText: value,
    isConnected: true,
    classList: { contains: name => Boolean(options.clamped && name === 'describtion-card__detail-content--guest-clamp') },
    querySelectorAll: selector => queries[selector] || [],
    querySelector: selector => (queries[selector] || [])[0] || null,
    closest: selector => (options.hidden && selector.includes('[hidden]')) || (options.list && selector.includes('.job-list')) ? {} : null,
    getClientRects: () => options.hidden ? [] : [{}]
  };
}

function extractor() {
  const scope = { URL, getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) };
  vm.createContext(scope);
  vm.runInContext(fs.readFileSync(path.join(extension, 'platforms.cjs'), 'utf8'), scope);
  vm.runInContext(fs.readFileSync(path.join(extension, 'extract.js'), 'utf8'), scope);
  return scope.BossJobExtractor.extract;
}

test('extracts only the visible detail root, ignoring unrelated body text', () => {
  const root = element('', { '.job-name': [element('产品设计师')], '.job-sec-text': [element('负责移动端产品体验设计，能够完成用户研究、交互方案及高保真原型。')], '.company-name': [element('示例公司')] });
  const document = element('聊天记录和推荐岗位都不能被读取', { '#main': [root] });
  const job = extractor()(document, 'https://www.zhipin.com/job_detail/example.html?source=search');
  assert.equal(job.title, '产品设计师');
  assert.equal(job.company, '示例公司');
  assert.equal(job.url, 'https://www.zhipin.com/job_detail/example.html');
  assert.ok(!job.description.includes('聊天记录'));
});

test('does not extract listings, hidden modals, or chat pages', () => {
  const fields = { '.job-name': [element('设计师')], '.job-sec-text': [element('负责移动端产品体验设计，能够完成用户研究、交互方案及高保真原型。')] };
  const document = element('', { '.job-detail': [element('', fields, { list: true }), element('', fields, { hidden: true })], '#main': [element('', fields)] });
  const extract = extractor();
  assert.equal(extract(document, 'https://www.zhipin.com/web/geek/job?query=设计'), null);
  assert.equal(extract(document, 'https://www.zhipin.com/web/geek/chat'), null);
  assert.equal(extract(document, 'https://example.com/job_detail/a.html'), null);
});

test('requires title and complete description inside one visible modal', () => {
  const modal = element('', { '.job-title': [element('交互设计师')], '.job-sec-text': [element('负责用户体验设计，参与需求分析和交互原型设计，推动体验方案落地。')] });
  const document = element('', { '[role="dialog"]': [modal] });
  const job = extractor()(document, 'https://www.zhipin.com/web/geek/job?query=设计');
  assert.equal(job.title, '交互设计师');
  const fragmented = element('', { '.job-detail': [element('', { '.job-name': [element('无详情标题')] }), element('', { '.job-sec-text': [element('只有详情文本但没有标题，不能将两个不同岗位的内容拼接起来。')] })] });
  assert.equal(extractor()(fragmented, 'https://www.zhipin.com/web/geek/job'), null);
});

function background({ active = true, focused = true, enabled = true, tabUrl='https://www.zhipin.com/job_detail/example.html', response = { id: 'example', status: 'queued' } } = {}) {
  let listener;
  const requests = [];
  const createdTabs = [];
  const config = { token: 'test_token_abcdefghijklmnopqrstuvwxyz', enabled };
  const chrome = {
    storage: {
      local: { setAccessLevel: async () => {}, get: async () => config, set: async data => Object.assign(config, data) },
      onChanged: { addListener: () => {} }
    },
    tabs: { get: async () => ({ active, windowId: 1, url: tabUrl }), query: async () => [], sendMessage: async () => {}, create: async options => { createdTabs.push(options); return { id: 2 }; } },
    windows: { get: async () => ({ focused }) },
    runtime: { getURL: file => `chrome-extension://test/${file}`, onMessage: { addListener: fn => { listener = fn; } } }
  };
  const scope = {
    chrome, URL, AbortSignal,
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (config.revokeDuringRequest) config.enabled = false;
      if (url.endsWith('/api/preferences')) {
        if (options.method === 'GET' && config.deferPreferences) {
          const snapshot={tone:config.tone || 'professional'};
          return new Promise(resolve=>{config.releasePreferences=()=>resolve({ok:true,json:async()=>snapshot});});
        }
        if (options.method === 'PUT') config.tone=JSON.parse(options.body).tone;
        return {ok:true,json:async()=>({tone:config.tone || 'professional'})};
      }
      return { ok: true, json: async () => response };
    }
  };
  vm.createContext(scope);
  vm.runInContext(fs.readFileSync(path.join(extension, 'platforms.cjs'), 'utf8'), scope);
  vm.runInContext(fs.readFileSync(path.join(extension, 'background.js'), 'utf8'), scope);
  return {
    requests,
    createdTabs,
    config,
    send: (message, sender = { tab: { id: 1 }, frameId: 0, url: 'https://www.zhipin.com/job_detail/example.html' }) => new Promise(resolve => listener(message, sender, resolve))
  };
}

const job = { url: 'https://www.zhipin.com/job_detail/example.html', title: '设计师', company: '示例公司', description: '负责移动端产品体验设计，能够完成用户研究、交互方案及高保真原型。' };

test('background rejects inactive, unfocused, disabled, iframe, and foreign senders without local requests', async () => {
  for (const config of [{ active: false }, { focused: false }, { enabled: false }]) {
    const runner = background(config);
    const result = await runner.send({ action: 'observeJob', job });
    assert.equal(result.ok, false);
    assert.equal(runner.requests.length, 0);
  }
  const runner = background();
  for (const sender of [{ tab: { id: 1 }, frameId: 1, url: job.url }, { tab: { id: 1 }, frameId: 0, url: 'https://example.com/' }]) {
    assert.equal((await runner.send({ action: 'observeJob', job }, sender)).ok, false);
  }
  assert.equal(runner.requests.length, 0);
});

test('content state never includes pairing token; only cleaned job fields go to localhost', async () => {
  const runner = background();
  const state = await runner.send({ action: 'getState' });
  assert.equal(state.ok, true);
  assert.equal(state.data.paired, true);
  assert.equal('token' in state.data, false);
  const submitted = await runner.send({ action: 'observeJob', job: { ...job, cookie: 'must not leave', chats: 'must not leave' } });
  assert.equal(submitted.ok, true);
  const submittedRequest=runner.requests.find(item=>item.url.endsWith('/api/jobs'));
  assert.equal(submittedRequest.url, 'http://127.0.0.1:43127/api/jobs');
  const payload = JSON.parse(submittedRequest.options.body);
  assert.equal('cookie' in payload, false);
  assert.equal('chats' in payload, false);
  assert.equal(submittedRequest.options.credentials, 'omit');
});

test('revoking monitoring while localhost responds blocks the response', async () => {
  const runner = background();
  runner.config.revokeDuringRequest = true;
  const result = await runner.send({ action: 'observeJob', job });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'inactive');
});

test('supports recommendation detail modals and rejects extra route suffixes', async () => {
  const fields = { '.job-name': [element('工业设计师')], '.job-sec-text': [element('负责产品外观设计和三维建模，参与用户研究、产品打样及设计方案落地。')] };
  const document = element('', { '.job-detail': [element('', fields)] });
  assert.equal(extractor()(document, 'https://www.zhipin.com/web/geek/job-recommend/').title, '工业设计师');
  const runner = background();
  const invalid = await runner.send({ action: 'observeJob', job: { ...job, url: 'https://www.zhipin.com/web/geek/job/invalid' } });
  assert.equal(invalid.ok, false);
  assert.equal(runner.requests.length, 0);
});

test('foreground paired page can explicitly enable monitoring and pause it again', async () => {
  const runner = background({ enabled: false });
  const enabled = await runner.send({ action: 'setMonitoring', enabled: true });
  assert.equal(enabled.ok, true);
  assert.equal(enabled.data.enabled, true);
  assert.equal(runner.config.enabled, true);
  assert.equal('token' in enabled.data, false);
  assert.equal((await runner.send({ action: 'getState' })).data.enabled, true);
  const paused = await runner.send({ action: 'setMonitoring', enabled: false });
  assert.equal(paused.ok, true);
  assert.equal(paused.data.enabled, false);
  assert.equal(runner.config.enabled, false);
  assert.equal(runner.requests.filter(item=>item.url.endsWith('/api/jobs')).length, 0);
});

test('monitoring enable rejects unpaired, inactive, unfocused, and malformed requests', async () => {
  const unpaired = background({ enabled: false });
  unpaired.config.token = '';
  const denied = await unpaired.send({ action: 'setMonitoring', enabled: true });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /配对码/);
  assert.equal(unpaired.config.enabled, false);
  for (const state of [{ active: false }, { focused: false }]) {
    const runner = background({ ...state, enabled: false });
    const response = await runner.send({ action: 'setMonitoring', enabled: true });
    assert.equal(response.ok, false);
    assert.equal(response.code, 'inactive');
    assert.equal(runner.config.enabled, false);
  }
  const malformed = background({ enabled: false });
  assert.equal((await malformed.send({ action: 'setMonitoring', enabled: 'true' })).ok, false);
  assert.equal(malformed.config.enabled, false);
});

function popup() {
  const config = { token: 'test_token_abcdefghijklmnopqrstuvwxyz', enabled: false };
  const messages = [];
  const elements = Object.fromEntries(['token', 'enabled', 'status', 'save', 'test', 'model-settings'].map(id => [id, {
    value: '', checked: false, disabled: false, textContent: '', listeners: {},
    addEventListener(type, listener) { this.listeners[type] = listener; },
    emit(type) { return this.listeners[type]({ target: this }); }
  }]));
  const scope = {
    document: { querySelector: selector => elements[selector.slice(1)] },
    chrome: { runtime: { sendMessage: async message => {
      messages.push(message);
      if (message.action === 'getSettings') return { ok: true, data: { ...config, paired: true } };
      if (message.action === 'saveSettings') {
        config.token = message.token;
        config.enabled = message.enabled;
        return { ok: true, data: { paired: true, enabled: config.enabled } };
      }
      if (message.action === 'testConnection') return { ok: true, data: { profileReady: true } };
      if (message.action === 'openSettings') return { ok: true, data: { opened: true } };
      throw new Error(`Unexpected popup action ${message.action}`);
    } } }
  };
  vm.createContext(scope);
  vm.runInContext(fs.readFileSync(path.join(extension, 'popup.js'), 'utf8'), scope);
  return { config, messages, elements };
}

test('popup checkbox saves immediately without a save-button click', async () => {
  const runner = popup();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runner.elements.enabled.checked, false);
  runner.elements.enabled.checked = true;
  await runner.elements.enabled.emit('change');
  assert.equal(runner.config.enabled, true);
  assert.match(runner.elements.status.textContent, /已开启并保存/);
  assert.equal(runner.messages.filter(message => message.action === 'saveSettings').length, 1);
  runner.elements.enabled.checked = false;
  await runner.elements.enabled.emit('change');
  assert.equal(runner.config.enabled, false);
  assert.match(runner.elements.status.textContent, /检测已暂停/);
});

test('successful popup connection test explicitly reports paused state', async () => {
  const runner = popup();
  await new Promise(resolve => setImmediate(resolve));
  await runner.elements.test.emit('click');
  assert.match(runner.elements.status.textContent, /连接成功，但检测已暂停/);
  assert.equal(runner.elements.test.disabled, false);
  assert.equal(runner.config.enabled, false);
});

const modelSender = { tab: { id: 2 }, frameId: 0, url: 'chrome-extension://test/settings.html' };

test('only the trusted settings page can read or write model and profile settings', async () => {
  const runner = background({response:{model:{provider:'ollama',baseUrl:'http://127.0.0.1:11434/v1',model:'test-model',apiKey:'must-not-return',hasApiKey:true},profile:'真实项目资料',profileReady:true}});
  for (const sender of [undefined,{tab:{id:1},frameId:0,url:job.url},{tab:{id:2},frameId:1,url:modelSender.url},
    {tab:{id:2},frameId:0,url:'https://example.com/settings.html'}]) {
    assert.equal((await runner.send({action:'getModelSettings'},sender)).ok,false);
    assert.equal((await runner.send({action:'saveModelSettings',model:{provider:'ollama'}},sender)).ok,false);
  }
  assert.equal(runner.requests.length,0);
  const result = await runner.send({action:'getModelSettings'},modelSender);
  assert.equal(result.ok,true);
  assert.equal(result.data.model.hasApiKey,true);
  assert.equal('apiKey' in result.data.model,false);
  assert.equal(result.data.profile,'真实项目资料');
  assert.equal(runner.requests[0].url,'http://127.0.0.1:43127/api/settings');
  assert.equal(runner.requests[0].options.method,'GET');
});

test('model settings save forwards allowed fields and profile then redacts credentials',async () => {
  const runner = background({response:{model:{provider:'doubao',hasApiKey:true,apiKey:'do-not-return'},profile:'经过核对的个人项目',profileReady:true}});
  const response = await runner.send({action:'saveModelSettings',model:{provider:'doubao',baseUrl:'https://ark.cn-beijing.volces.com/api/v3',model:'ep-test',apiKey:'new-secret',timeoutMs:120000,responseFormat:'auto',cookie:'must-not-forward'},profile:'经过核对的个人项目'},modelSender);
  assert.equal(response.ok,true);
  assert.equal('apiKey' in response.data.model,false);
  const request = runner.requests[0];
  assert.equal(request.options.method,'PUT');
  const body = JSON.parse(request.options.body);
  assert.equal(body.model.apiKey,'new-secret');
  assert.equal('cookie' in body.model,false);
  assert.equal(body.profile,'经过核对的个人项目');
});

test('model testing sends unsaved model settings without profile and supports long local-model wait',async () => {
  const runner = background({response:{ok:true,message:'模型连接成功'}});
  const response = await runner.send({action:'testModelSettings',model:{provider:'ollama',model:'test-model',timeoutMs:180000},profile:'must-not-forward'},modelSender);
  assert.equal(response.ok,true);
  const request = runner.requests[0];
  assert.equal(request.url,'http://127.0.0.1:43127/api/model/test');
  assert.equal(request.options.method,'POST');
  assert.equal('profile' in JSON.parse(request.options.body),false);
  assert.equal(request.options.signal.aborted,false);
});

test('only popup can open the extension settings page; no extra permission required',async () => {
  const runner = background();
  assert.equal((await runner.send({action:'openSettings'})).ok,false);
  const response = await runner.send({action:'openSettings'},{url:'chrome-extension://test/popup.html'});
  assert.equal(response.ok,true);
  assert.equal(runner.createdTabs.length,1);
  assert.equal(runner.createdTabs[0].url,'chrome-extension://test/settings.html');
});

test('popup model button opens the trusted settings page',async () => {
  const runner = popup();
  await new Promise(resolve => setImmediate(resolve));
  await runner.elements['model-settings'].emit('click');
  assert.equal(runner.messages.at(-1).action,'openSettings');
});

test('paired foreground pages save one of four tones without receiving profile or model secrets',async()=>{
  const runner=background({enabled:false});
  for(const tone of ['professional','friendly','bold','creative']) {
    const result=await runner.send({action:'setTone',tone});
    assert.equal(result.ok,true);assert.equal(result.data.tone,tone);
    assert.equal('token' in result.data,false);assert.equal('profile' in result.data,false);
  }
  assert.equal((await runner.send({action:'getState'})).data.tone,'creative');
  assert.equal((await runner.send({action:'setTone',tone:'invented'})).ok,false);
  const denied=background({active:false});
  assert.equal((await denied.send({action:'setTone',tone:'bold'})).ok,false);
  assert.equal(denied.requests.length,0);
});

test('other recruitment platforms submit scoped jobs and reject cross-platform stale senders',async()=>{
  for(const url of ['https://www.liepin.com/job/1986231537.shtml','https://www.zhaopin.com/jobdetail/CC585435125J00668996301.htm']) {
    const runner=background({tabUrl:url});
    const response=await runner.send({action:'observeJob',job:{...job,url}},{tab:{id:1},frameId:0,url});
    assert.equal(response.ok,true);assert.equal(runner.requests[0].url,'http://127.0.0.1:43127/api/jobs');
  }
  const changed=background({tabUrl:'https://www.liepin.com/job/1986231537.shtml'});
  assert.equal((await changed.send({action:'observeJob',job})).ok,false);assert.equal(changed.requests.length,0);
});

test('file import is limited to trusted settings page and forwards only document payload',async()=>{
  const runner=background(), payload={action:'importDocument',filename:'resume.png',type:'image/png',base64:'aGVsbG8=',cookie:'do-not-forward'};
  assert.equal((await runner.send(payload)).ok,false);assert.equal(runner.requests.length,0);
  const response=await runner.send(payload,{tab:{id:2},frameId:0,url:'chrome-extension://test/settings.html'});
  assert.equal(response.ok,true);
  const sent=runner.requests[0];assert.equal(sent.url,'http://127.0.0.1:43127/api/imports');
  assert.deepEqual(JSON.parse(sent.options.body),{filename:'resume.png',type:'image/png',base64:'aGVsbG8='});
  assert.equal((await runner.send({...payload,filename:'../secret.png'},{tab:{id:2},frameId:0,url:'chrome-extension://test/settings.html'})).ok,false);
});

test('late preference reads cannot overwrite a newer tone save',async()=>{
  for(const method of ['setTone','saveModelSettings']) {
    const runner=background({response:{model:{provider:'codex'},preferences:{tone:'creative'}}});
    runner.config.deferPreferences=true;
    const oldState=runner.send({action:'getState'});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(typeof runner.config.releasePreferences,'function');
    const changed=method==='setTone'
      ? await runner.send({action:'setTone',tone:'creative'})
      : await runner.send({action:'saveModelSettings',model:{provider:'codex'},preferences:{tone:'creative'}},{tab:{id:2},frameId:0,url:'chrome-extension://test/settings.html'});
    assert.equal(changed.ok,true);
    runner.config.deferPreferences=false;runner.config.releasePreferences();
    assert.equal((await oldState).data.tone,'creative');
    assert.equal((await runner.send({action:'getState'})).data.tone,'creative');
  }
});
