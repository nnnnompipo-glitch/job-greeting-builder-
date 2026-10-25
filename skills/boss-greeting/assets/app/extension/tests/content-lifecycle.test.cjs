const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');

test('navigation watchers on homepage, chat and listing routes do not inspect DOM or contact background',()=>{
  for(const url of ['https://www.zhipin.com/','https://www.zhipin.com/web/geek/chat',
    'https://www.liepin.com/zhaopin/','https://www.zhaopin.com/chat']){
    const timers=new Map(),intervals=[],windowListeners={},documentListeners={};
    let seq=0,reads=0,observers=0,messages=0,extractions=0;
    const doc={visibilityState:'visible',addEventListener:(name,fn)=>{documentListeners[name]=fn;}};
    Object.defineProperty(doc,'documentElement',{get(){reads++;throw new Error('Non-job DOM must not be inspected');}});
    const scope={URL,location:{href:url},document:doc,window:{addEventListener:(name,fn)=>{windowListeners[name]=fn;}},
      chrome:{runtime:{onMessage:{addListener:()=>{}},sendMessage:()=>{messages++;}}},
      MutationObserver:class{constructor(){observers++;}},
      setTimeout:(fn)=>{const id=++seq;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),
      setInterval:fn=>intervals.push(fn)};
    vm.createContext(scope);
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../platforms.js'),'utf8'),scope);
    scope.BossJobExtractor={extract(){extractions++;}};
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../content.js'),'utf8'),scope);
    const drain=()=>{for(let n=0;timers.size&&n<10;n++){const batch=[...timers.values()];timers.clear();batch.forEach(fn=>fn());}};
    drain();for(let n=0;n<30;n++){intervals.forEach(fn=>fn());drain();}
    for(const fn of Object.values(windowListeners)){fn();drain();}
    documentListeners.visibilitychange();drain();
    assert.deepEqual({reads,observers,messages,extractions},{reads:0,observers:0,messages:0,extractions:0});
  }
});
