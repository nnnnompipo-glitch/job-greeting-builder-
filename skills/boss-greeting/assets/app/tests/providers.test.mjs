import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { normalizeModelSettings, publicModelSettings, generateWithProvider, testModelConnection, parseProviderResponse } from '../server/providers.mjs';

const draft = { greeting: '您好，我对工业设计岗位感兴趣，有餐厨产品设计与工厂协作经历，愿提供作品集进一步沟通。', matches: [{requirement:'餐厨产品',evidence:'测试用保鲜盒项目'}], cautions: [] };
const job = { title: '工业设计师', company: '测试公司', description: '测试岗位，负责餐厨产品外观设计和打样。', url: 'https://www.zhipin.com/job_detail/fixture.html' };
const profile = 'PRIVATE_PROFILE_MARKER：工业设计本科，做过保鲜盒项目。';
function envelope(content = JSON.stringify(draft), extra = {}) {
  return { choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop', ...extra }] };
}
async function fixture(handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk.toString();
    const request = { url: req.url, headers: req.headers, body: JSON.parse(text) };
    requests.push(request);
    await handler(request, res, requests.length);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, async close() {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));} };
}
function json(res, data, status=200) {res.writeHead(status, {'Content-Type':'application/json'});res.end(JSON.stringify(data));}
function settings(baseUrl, other = {}) {return {provider:'ollama',baseUrl,model:'already-installed-local-model',...other};}

test('provider presets, incomplete settings and public secret removal', () => {
  assert.equal(normalizeModelSettings({provider:'ollama',model:'local'}).baseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(normalizeModelSettings({provider:'lmstudio',model:'local'}).baseUrl, 'http://127.0.0.1:1234/v1');
  assert.equal(normalizeModelSettings({provider:'doubao',model:'ep-actual-id',apiKey:'secret'}).baseUrl, 'https://ark.cn-beijing.volces.com/api/v3');
  assert.equal(normalizeModelSettings({provider:'ollama'}, {allowIncomplete:true}).model, '');
  assert.throws(() => normalizeModelSettings({provider:'ollama'}), /模型 ID/);
  const publicSettings = publicModelSettings({provider:'doubao',apiKey:'secret'});
  assert.equal(publicSettings.hasApiKey, true);
  assert.equal('apiKey' in publicSettings, false);
  assert.equal(JSON.stringify(publicSettings).includes('secret'), false);
  assert.equal(publicModelSettings().provider, 'codex');
  assert.equal(normalizeModelSettings({provider:'openai-compatible',baseUrl:'http://127.0.0.1:8080/v1',model:'local'}).apiKey,'');
});

test('rejects malformed URLs and insecure public HTTP without exposing input', () => {
  for (const baseUrl of ['https://key:secret@example.test/v1', 'https://example.test/v1?api_key=secret',
    'https://example.test/v1#secret','file:///secret','http://example.test/v1',
    'https://example.test/v1/chat/completions','https://example.test/v1/models']) {
    assert.throws(() => normalizeModelSettings({provider:'ollama',baseUrl,model:'local'}), error => !error.message.includes('secret'));
  }
  assert.equal(normalizeModelSettings(settings('http://192.168.0.10:8000/v1/')).baseUrl,'http://192.168.0.10:8000/v1');
  assert.throws(() => normalizeModelSettings({provider:'other'}));
  assert.throws(() => normalizeModelSettings({provider:'doubao',model:'m'}), /API Key/);
});

test('local completion uses selected endpoint, JSON schema and no auth or tools', async () => {
  const app = await fixture((_request,res) => json(res,envelope()));
  try {
    assert.deepEqual(await generateWithProvider(job,profile,{model:settings(app.baseUrl)}),draft);
    const sent = app.requests[0];
    assert.equal(sent.url,'/v1/chat/completions');
    assert.equal(sent.headers.authorization,undefined);
    assert.equal(sent.body.model,'already-installed-local-model');
    assert.equal(sent.body.stream,false);
    assert.equal(sent.body.response_format.type,'json_schema');
    assert.equal(sent.body.response_format.json_schema.schema.type,'object');
    assert.equal('tools' in sent.body,false);
    assert.equal(sent.body.messages.length,2);
    assert.ok(sent.body.messages[1].content.includes('PRIVATE_PROFILE_MARKER'));
  } finally {await app.close();}
});

test('cloud adapter authenticates and connection test sends no personal materials', async () => {
  const app = await fixture((_request,res) => json(res,envelope()));
  try {
    const answer = await testModelConnection(settings(app.baseUrl.replace('/v1','/api/v3'),{provider:'doubao',apiKey:'test-key',model:'ep-test'}));
    assert.equal(answer.ok,true);
    const sent = app.requests[0];
    assert.equal(sent.url,'/api/v3/chat/completions');
    assert.equal(sent.headers.authorization,'Bearer test-key');
    assert.equal(sent.body.response_format.type,'json_object');
    assert.equal(JSON.stringify(sent.body).includes('PRIVATE_PROFILE_MARKER'),false);
    assert.equal(JSON.stringify(sent.body).includes('candidate_profile'),false);
    assert.equal(JSON.stringify(sent.body).includes(job.url),false);
  } finally {await app.close();}
});

test('auto format retries once at the same endpoint only for explicit unsupported format', async () => {
  const app = await fixture((_request,res,count) => count === 1
    ? json(res,{error:{message:'response_format json_schema is not supported'}},400) : json(res,envelope()));
  try {
    assert.deepEqual(await generateWithProvider(job,profile,settings(app.baseUrl)),draft);
    assert.equal(app.requests.length,2);
    assert.ok(app.requests[0].body.response_format);
    assert.equal('response_format' in app.requests[1].body,false);
    assert.equal(app.requests[0].url,app.requests[1].url);
  } finally {await app.close();}
});

test('auth, quota, general errors, and explicit format never retry or expose provider bodies', async () => {
  for (const [status, responseFormat, message] of [
    [401,'auto','response_format is not supported; secret-key PRIVATE_PROFILE_MARKER'],
    [429,'auto','secret-key quota'],[500,'auto','secret-key failure'],
    [400,'auto','model not found: secret-key'],[400,'json_schema','response_format is not supported; secret-key']
  ]) {
    const app = await fixture((_request,res) => json(res,{error:{message}},status));
    try {
      await assert.rejects(generateWithProvider(job,profile,settings(app.baseUrl,{apiKey:'secret-key',responseFormat})), error =>
        Boolean(error.publicMessage) && !error.message.includes('secret-key') && !error.message.includes('PRIVATE_PROFILE_MARKER'));
      assert.equal(app.requests.length,1);
    } finally {await app.close();}
  }
});

test('accepts fenced JSON and completed think blocks, rejects invalid, refused or truncated output', () => {
  assert.deepEqual(parseProviderResponse(envelope('```json\n'+JSON.stringify(draft)+'\n```')),draft);
  assert.deepEqual(parseProviderResponse(envelope('<think>内部推理</think>\n'+JSON.stringify(draft))),draft);
  assert.deepEqual(parseProviderResponse(envelope([{type:'text',text:JSON.stringify(draft)}])),draft);
  for (const payload of [envelope('not JSON'),envelope(''),envelope(JSON.stringify(draft),{finish_reason:'length'}),
    envelope(JSON.stringify(draft),{message:{content:JSON.stringify(draft),tool_calls:[{id:'a'}]}}),
    envelope(JSON.stringify(draft),{message:{content:JSON.stringify(draft),refusal:'refused'}}),
    envelope(JSON.stringify({greeting:'x'.repeat(261),matches:[],cautions:[]}))]) assert.throws(() => parseProviderResponse(payload));
});

test('timeout includes response body reads and never retries to another service', async () => {
  const app = await fixture((_request,res) => {res.writeHead(200,{'Content-Type':'application/json'});res.write('{');});
  try {
    await assert.rejects(generateWithProvider(job,profile,settings(app.baseUrl,{timeoutMs:1000})), /超时/);
    assert.equal(app.requests.length,1);
  } finally {await app.close();}
});

test('redirects and oversized responses are rejected without forwarding auth', async () => {
  const app = await fixture((_request,res) => {res.writeHead(307,{Location:'http://127.0.0.1:1/steal'});res.end();});
  try {
    await assert.rejects(generateWithProvider(job,profile,settings(app.baseUrl,{apiKey:'secret-key'})), /无法连接/);
    assert.equal(app.requests.length,1);
  } finally {await app.close();}
  const large = await fixture((_request,res) => {res.writeHead(200,{'Content-Length':'1048577'});res.end('x'.repeat(1048577));});
  try {await assert.rejects(generateWithProvider(job,profile,settings(large.baseUrl)), /过大/);}
  finally {await large.close();}
});
