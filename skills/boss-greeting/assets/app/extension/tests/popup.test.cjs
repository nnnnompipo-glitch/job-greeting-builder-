const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const code=fs.readFileSync(path.join(__dirname,'../popup.js'),'utf8');
const token='test_pairing_abcdefghijklmnopqrstuvwxyz';
const flush=()=>new Promise(resolve=>setImmediate(resolve));

function popup({stored={},callbacks=false,stalled='',getDeferred=false}={}) {
  const elements=Object.fromEntries(['token','enabled','status','save','test','model-settings'].map(id=>[id,{
    value:'',checked:false,disabled:false,textContent:'',listeners:{},
    addEventListener(type,fn){this.listeners[type]=fn;},emit(type){return this.listeners[type]({target:this});}
  }]));
  const timers=new Map(),writes=[],access=[],messages=[];
  let clock=0,releaseRead;
  const runtime={lastError:undefined};
  const complete=(method,value,callback)=>{
    if(stalled===method)return undefined;
    if(callbacks){queueMicrotask(()=>callback(value));return undefined;}
    return Promise.resolve(value);
  };
  const local={
    setAccessLevel(options,callback){access.push(options.accessLevel);return complete('secure',undefined,callback);},
    get(defaults,callback){const result={...defaults,...stored};if(getDeferred)return new Promise(resolve=>{releaseRead=()=>resolve(result);});return complete('read',result,callback);},
    set(value,callback){writes.push({...value});if(stalled!=='write')Object.assign(stored,value);return complete('write',undefined,callback);}
  };
  runtime.sendMessage=(message,callback)=>{messages.push(message.action);return complete('message',{ok:true,data:{profileReady:true}},callback);};
  const context={document:{querySelector:s=>elements[s.slice(1)]},chrome:{runtime,storage:{local}},
    setTimeout(fn,ms){const id=++clock;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);}};
  vm.runInNewContext(code,context);
  return {elements,stored,writes,access,messages,runtime,local,
    releaseRead:()=>releaseRead(),expire(ms){for(const [id,timer] of timers){if(timer.ms===ms){timers.delete(id);timer.fn();}}}};
}

test('pairing saves with a nonresponsive worker and survives closing and reopening popup',async()=>{
  const stored={},first=popup({stored,stalled:'message'});await flush();
  first.elements.token.value=token;first.elements.enabled.checked=true;
  await first.elements.save.emit('click');
  assert.equal(stored.token,token);assert.equal(stored.enabled,true);
  assert.deepEqual(first.access,['TRUSTED_CONTEXTS']);assert.deepEqual(first.messages,[]);
  const reopened=popup({stored});await flush();
  assert.equal(reopened.elements.token.value,token);assert.equal(reopened.elements.enabled.checked,true);
});
test('silent worker has bounded failure, preserves pairing and permits retry',async()=>{
  const runner=popup({stored:{token},stalled:'message'});await flush();
  const pending=runner.elements.test.emit('click');await flush();
  assert.equal(runner.elements.test.disabled,true);runner.expire(15000);await pending;
  assert.equal(runner.elements.test.disabled,false);assert.equal(runner.stored.token,token);
  assert.match(runner.elements.status.textContent,/设置已保存在此浏览器.*后台没有响应.*重新加载/);
});
test('late initial storage read cannot overwrite typed pairing or a completed save',async()=>{
  const runner=popup({stored:{token:'old_pairing_abcdefghijklmnopqrstuvwxyz'},getDeferred:true});await flush();
  runner.elements.token.value=token;runner.elements.token.emit('input');
  await runner.elements.save.emit('click');runner.releaseRead();await flush();
  assert.equal(runner.elements.token.value,token);assert.equal(runner.stored.token,token);
  assert.match(runner.elements.status.textContent,/配对码已保存/);
});
test('callback-only Chrome APIs save and test with a real response',async()=>{
  const runner=popup({stored:{token},callbacks:true});await flush();
  await runner.elements.test.emit('click');
  assert.match(runner.elements.status.textContent,/连接成功，但检测已暂停/);
  assert.equal(runner.elements.test.disabled,false);assert.deepEqual(runner.messages,['testConnection']);
});
test('callback lastError reports a connection error without exposing raw details',async()=>{
  const runner=popup({stored:{token},callbacks:true});await flush();
  runner.runtime.sendMessage=(message,callback)=>{runner.runtime.lastError={message:token};callback();runner.runtime.lastError=undefined;};
  await runner.elements.test.emit('click');
  assert.match(runner.elements.status.textContent,/后台没有响应/);
  assert.equal(runner.elements.status.textContent.includes(token),false);
  assert.equal(runner.elements.test.disabled,false);
});
test('storage write timeout is not reported as saved or connected',async()=>{
  const runner=popup({stored:{token},stalled:'write'});await flush();
  const pending=runner.elements.test.emit('click');await flush();runner.expire(3500);await pending;
  assert.match(runner.elements.status.textContent,/未保存成功/);assert.deepEqual(runner.messages,[]);
  assert.equal(runner.elements.test.disabled,false);
});
test('storage protection failure prevents credential writes and can be retried',async()=>{
  const runner=popup({stalled:'secure'});await flush();runner.expire(3500);await flush();
  runner.elements.token.value=token;const pending=runner.elements.save.emit('click');await flush();runner.expire(3500);await pending;
  assert.deepEqual(runner.writes,[]);assert.match(runner.elements.status.textContent,/安全的本地存储/);
});
test('invalid pairing is rejected before storage writes or connection requests',async()=>{
  const runner=popup();await flush();runner.elements.token.value='short';
  await runner.elements.test.emit('click');assert.deepEqual(runner.writes,[]);assert.deepEqual(runner.messages,[]);
  assert.match(runner.elements.status.textContent,/配对码格式不正确/);
});
test('queued saves retain the newest monitoring choice',async()=>{
  const runner=popup({stored:{token}});await flush();runner.elements.enabled.checked=true;
  const first=runner.elements.enabled.emit('change');runner.elements.enabled.checked=false;
  const second=runner.elements.enabled.emit('change');await Promise.all([first,second]);
  assert.deepEqual(runner.writes.map(value=>value.enabled),[true,false]);assert.equal(runner.stored.enabled,false);
});
