import test from 'node:test';
import assert from 'node:assert/strict';
import {detectHostModel,redactDetection,configureHost} from '../scripts/configure-host.mjs';

test('diagnostic only asks Codex login and never reuses another client key',async()=>{
  let calls=0;
  const env={ARK_API_KEY:'never-use-this-key',DEEPSEEK_API_KEY:'never-use-this-either'};
  const result=await detectHostModel({env,checkLogin:async options=>{calls++;assert.equal(options.env,env);return {ok:true,status:'ready',message:'Codex ChatGPT login ready',apiKey:'must-not-leak'};}});
  assert.equal(calls,1);assert.equal(result.ok,true);assert.equal(result.status,'ready');
  assert.equal(JSON.stringify(result).includes('must-not-leak'),false);
  assert.equal(JSON.stringify(result).includes('never-use'),false);
});

test('API and local model configuration are rejected before checking or writing',async()=>{
  for(const options of [{provider:'doubao'},{apiKeyEnv:'ARK_API_KEY'},{baseUrl:'https://example.test'},{model:'any'},{detectLocal:true}]) {
    await assert.rejects(()=>detectHostModel({...options,checkLogin:()=>{throw new Error('must not run');}}),/统一使用 Codex/);
  }
  await assert.rejects(()=>configureHost({options:{apply:true}}),/不再写入/);
});

test('public login diagnosis keeps status and executable path without raw outputs',()=>{
  const result=redactDetection({ok:false,status:'api-key-login',message:'Switch login method',stdout:'private diagnostic',stderr:'private',apiKey:'private'});
  assert.deepEqual(result,{ok:false,status:'api-key-login',message:'Switch login method'});
});
