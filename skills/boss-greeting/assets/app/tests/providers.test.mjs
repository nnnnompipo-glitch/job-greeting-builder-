import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as providers from '../server/providers.mjs';
import {generateGreeting,codexArguments,parseCodexCapabilities,probeCodexCapabilities} from '../server/model.mjs';
import {buildPrompt} from '../server/core.mjs';

const draft={greeting:'您好，我有餐厨产品外观与建模项目经历，希望进一步沟通。',matches:[],cautions:[]};
const job={title:'工业设计师',company:'测试公司',description:'负责餐厨产品外观设计、三维建模及工厂打样沟通。',url:'https://www.zhipin.com/job_detail/test.html'};
const facts='隔离测试材料：工业设计本科，有保鲜盒外观设计、建模及打样沟通经历，目标地区为杭州。';
const ready=async()=>({ok:true,status:'ready',message:'已登录'});
const rootHelp='Commands:\n  exec Run a task\n  features Inspect feature flags\nOptions:\n --ask-for-approval <POLICY>\n --config <CONFIG>\n';
const execHelp='Options:\n --sandbox <MODE>\n --cd <DIR>\n --output-schema <FILE>\n --skip-git-repo-check\n --ephemeral\n --ignore-user-config\n --ignore-rules\n';
const featureList='shell_tool stable true\napps experimental true\n';
const fixtureCapabilities=parseCodexCapabilities(rootHelp,execHelp,featureList);
async function fixture(run){
  const root=await mkdtemp(path.join(os.tmpdir(),'boss-codex-transport-'));
  try {await run(root);}finally{
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('boss-codex-transport-'));
    await rm(root,{recursive:true,force:true});
  }
}
function generatorCapture(captured){
  return (executable,args,options)=>{
    const child=new EventEmitter();
    Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill(){}});
    let prompt='';child.stdin.on('data',chunk=>{prompt+=chunk.toString('utf8');});
    child.stdin.on('finish',()=>{
      captured.push({executable,args,options,prompt});
      queueMicrotask(()=>{child.stdout.write(JSON.stringify(draft));child.emit('close',0);});
    });
    return child;
  };
}

test('Codex is the only provider and public settings never include an API key',()=>{
  assert.deepEqual(providers.normalizeModelSettings(),{provider:'codex',baseUrl:'',model:'',apiKey:'',responseFormat:'auto',timeoutMs:120000});
  assert.equal(providers.normalizeModelSettings({provider:'codex',timeoutMs:180000}).timeoutMs,180000);
  assert.deepEqual(providers.publicModelSettings(),{provider:'codex',baseUrl:'',model:'',responseFormat:'auto',timeoutMs:120000,hasApiKey:false});
  assert.deepEqual(Object.keys(providers).sort(),['normalizeModelSettings','publicModelSettings']);
});

test('all remote and local HTTP settings are rejected without exposing supplied secrets',()=>{
  for(const input of [
    {provider:'doubao',apiKey:'do-not-print'}, {provider:'ollama'}, {provider:'lmstudio'}, {provider:'openai-compatible'},
    {provider:'codex',apiKey:'do-not-print'}, {provider:'codex',baseUrl:'https://do-not-print.example/v1'},
    {provider:'codex',model:'do-not-print'}, {provider:'codex',apiKey:1}, null, [], {timeoutMs:0}, {timeoutMs:600001}
  ])assert.throws(()=>providers.normalizeModelSettings(input,{allowIncomplete:true}),error=>Boolean(error.publicMessage)&&!error.message.includes('do-not-print'));
  assert.throws(()=>providers.publicModelSettings({provider:'doubao',apiKey:'do-not-print'}));
});

test('unsupported generation never resolves a binary, spawns a child or falls back to HTTP',async()=>{
  let discovered=0,spawned=0;
  await assert.rejects(()=>generateGreeting(job,facts,{root:'unused',model:{provider:'doubao',apiKey:'secret'}},{
    findCodexImpl:async()=>{discovered++;return '/test/codex.exe';},spawnImpl:()=>{spawned++;}
  }),/统一使用 Codex/);
  assert.equal(discovered,0);assert.equal(spawned,0);
});

test('every generation checks a positive ChatGPT login and refuses missing, API-key and unknown login states',async()=>{
  await fixture(async root=>{
    let spawned=0,checked=0;
    const findCodexImpl=async()=>'/test/codex.exe';
    for(const status of ['not-logged-in','api-key-login','missing','error']){
      await assert.rejects(()=>generateGreeting(job,facts,{root},{findCodexImpl,spawnImpl:()=>{spawned++;},checkCodexLoginImpl:async()=>{
        checked++;return {ok:false,status,message:'需要有效 ChatGPT 登录'};
      }}),/ChatGPT 登录/);
    }
    await assert.rejects(()=>generateGreeting(job,facts,{root},{findCodexImpl,spawnImpl:()=>{spawned++;},checkCodexLoginImpl:async()=>({ok:true,status:'unknown'})}),/登录不可用/);
    assert.equal(checked,4);assert.equal(spawned,0);
    await assert.rejects(()=>generateGreeting(job,facts,{root},{findCodexImpl:async()=>null,checkCodexLoginImpl:ready}),/找不到 Codex/);
  });
});

test('Codex receives the selected tone, blocked action tools and no inherited API-key override',async()=>{
  await fixture(async root=>{
    const variables={OPENAI_API_KEY:'isolated-test-secret',OPENAI_BASE_URL:'https://isolated.invalid',OPENAI_MODEL:'other-model',CODEX_API_KEY:'isolated-codex-secret'};
    const previous=Object.fromEntries(Object.keys(variables).map(key=>[key,process.env[key]]));
    Object.assign(process.env,variables);
    const captured=[];let checked=0;
    try{
      for(const tone of ['professional','friendly','bold','creative']){
        assert.deepEqual(await generateGreeting(job,facts,{root,preferences:{tone},proxyUrl:'http://127.0.0.1:10808'},{
          findCodexImpl:async()=>'/test/native-codex.exe',
          checkCodexLoginImpl:async input=>{checked++;assert.equal(input.codexPath,'/test/native-codex.exe');return ready();},
          probeCapabilitiesImpl:async()=>fixtureCapabilities,
          spawnImpl:generatorCapture(captured)
        }),draft);
        const sent=captured.at(-1);
        assert.equal(sent.prompt,buildPrompt(job,facts,{tone}));
        assert.equal(sent.executable,'/test/native-codex.exe');
        assert.equal(sent.options.shell,false);
        for(const key of Object.keys(variables))assert.equal(key in sent.options.env,false);
        assert.equal(sent.options.env.HTTPS_PROXY,'http://127.0.0.1:10808');
        assert.ok(sent.args.includes('features.shell_tool=false'));assert.ok(sent.args.includes('features.apps=false'));
      }
      assert.equal(checked,4);assert.equal(captured.length,4);
    }finally{for(const[key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
  });
});

test('standard CLI arguments omit unsupported desktop flags and unknown feature toggles',()=>{
  const args=codexArguments('isolated','schema',false,fixtureCapabilities);
  for(const flag of ['--no-daemon','--strict-config','features.hooks=false','features.code_mode_host=false'])assert.equal(args.includes(flag),false);
  for(const flag of ['--ignore-user-config','--ignore-rules','--ephemeral','--output-schema','features.shell_tool=false','features.apps=false','project_doc_max_bytes=0','web_search="disabled"'])assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf('--sandbox')+1],'read-only');
  assert.equal(args[args.indexOf('-a')+1],'never');
  assert.equal(args.at(-1),'-');
  const desktop=parseCodexCapabilities(rootHelp+' --no-daemon\n',execHelp+' --strict-config\n',featureList+'hooks stable true\ncode_mode_host stable true\n');
  const desktopArgs=codexArguments('isolated','schema',false,desktop);
  for(const flag of ['--no-daemon','--strict-config','features.hooks=false','features.code_mode_host=false'])assert.ok(desktopArgs.includes(flag));
  assert.equal(codexArguments('isolated','schema',true,desktop).includes('--no-daemon'),false);
});

test('unsupported CLI profiles fail closed instead of loading user configuration or enabling tools',()=>{
  for(const flag of ['--ignore-user-config','--ignore-rules','--ephemeral','--output-schema','--sandbox']){
    assert.throws(()=>parseCodexCapabilities(rootHelp,execHelp.replace(flag,''),featureList),/请更新 Codex/);
  }
  assert.throws(()=>parseCodexCapabilities(rootHelp.replace('--ask-for-approval',''),execHelp,featureList),/请更新 Codex/);
  assert.throws(()=>parseCodexCapabilities(rootHelp,execHelp,'apps stable true\n'),/请更新 Codex/);
});

test('capability probes use only bounded local metadata commands and refresh when the executable changes',async()=>{
  const calls=[];let modified=1;
  const spawnImpl=(_executable,args,options)=>{
    assert.equal(options.shell,false);assert.equal(options.stdio[0],'ignore');
    calls.push(args);
    const child=new EventEmitter();Object.assign(child,{stdout:new PassThrough(),stderr:new PassThrough(),kill(){}});
    queueMicrotask(()=>{
      const text=args[0]==='--help'?rootHelp:args[0]==='exec'?execHelp:featureList;
      child.stdout.write(text);child.emit('close',0);
    });
    return child;
  };
  const options={spawnImpl,statImpl:async()=>({mtimeMs:modified,size:123})};
  assert.deepEqual(await probeCodexCapabilities('isolated-capability-fixture',options),fixtureCapabilities);
  assert.deepEqual(calls,[['--help'],['exec','--help'],['features','list']]);
  await probeCodexCapabilities('isolated-capability-fixture',options);assert.equal(calls.length,3);
  modified=2;await probeCodexCapabilities('isolated-capability-fixture',options);assert.equal(calls.length,6);
});

test('metadata timeout and failures remain bounded, redacted and retryable',async()=>{
  const options={statImpl:async()=>({mtimeMs:1,size:2}),timeoutMs:20};
  let killed=0;
  const hanging=()=>{
    const child=new EventEmitter();Object.assign(child,{stdout:new PassThrough(),stderr:new PassThrough(),kill(){killed++;}});return child;
  };
  await assert.rejects(()=>probeCodexCapabilities('isolated-hanging-capability',{...options,spawnImpl:hanging}),/请更新 Codex/);
  assert.ok(killed>=1);
  const failing=()=>{
    const child=hanging();queueMicrotask(()=>{child.stderr.write('PRIVATE_SECRET_MARKER');child.emit('close',1);});return child;
  };
  await assert.rejects(()=>probeCodexCapabilities('isolated-failing-capability',{...options,spawnImpl:failing}),error=>!error.message.includes('PRIVATE_SECRET_MARKER'));
  const success=(_executable,args)=>{
    const child=hanging();queueMicrotask(()=>{child.stdout.write(args[0]==='--help'?rootHelp:args[0]==='exec'?execHelp:featureList);child.emit('close',0);});return child;
  };
  assert.deepEqual(await probeCodexCapabilities('isolated-failing-capability',{...options,spawnImpl:success}),fixtureCapabilities);
});
