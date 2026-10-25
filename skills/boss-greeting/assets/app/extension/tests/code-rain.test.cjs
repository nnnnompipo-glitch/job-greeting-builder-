const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const code=fs.readFileSync(path.join(__dirname,'../code-rain.js'),'utf8');
function api(extras={}){const scope={...extras};vm.runInNewContext(code,scope);return scope.RecruitmentCodeRain;}

test('code rain becomes denser by generation stage and remains bounded during long waits',()=>{
  const simulation=api().createSimulation(()=>0.5);simulation.resize(342,480);
  simulation.setStage('reading');const initial=simulation.density();
  simulation.setStage('queued');const queued=simulation.density();
  simulation.setStage('running');const running=simulation.density();
  assert.ok(initial<queued&&queued<running);
  for(let n=0;n<10000;n++){
    simulation.step(0.04);const scene=simulation.scene;
    assert.ok(scene.drops.length<=30&&scene.sparks.length<=120&&scene.ripples.length<=24);
    assert.ok(scene.drops.every(drop=>Number.isFinite(drop.x)&&Number.isFinite(drop.y)));
  }
  assert.ok(simulation.density()>running);assert.ok(simulation.density()<=30);
});
test('floor collisions create upward splashes that fall under gravity and fade',()=>{
  const simulation=api().createSimulation(()=>0.5);simulation.resize(342,480);simulation.setStage('reading');
  const floor=simulation.scene.height-7;
  simulation.scene.drops.forEach(drop=>{drop.y=-500;});simulation.scene.drops[0].y=floor-0.1;
  simulation.step(0.02);
  assert.ok(simulation.scene.ripples.length>0);assert.ok(simulation.scene.sparks.length>0);
  const spark=simulation.scene.sparks[0],upward=spark.vy;
  assert.ok(upward<0);simulation.step(0.05);assert.ok(spark.y<floor);assert.ok(spark.vy>upward);
  for(let n=0;n<35;n++)simulation.step(0.05);
  assert.equal(simulation.scene.sparks.includes(spark),false);
});
test('completion and cancellation clear rain, splashes and ripples immediately',()=>{
  const simulation=api().createSimulation(()=>0.5);simulation.resize(300,400);
  for(const terminal of ['done','', 'error']){
    simulation.setStage('running');simulation.scene.drops[0].y=400;simulation.step(0.03);
    assert.ok(simulation.scene.drops.length>0&&simulation.scene.sparks.length>0);
    simulation.setStage(terminal);simulation.step(0.05);
    assert.equal(simulation.density(),0);
    assert.equal(simulation.scene.drops.length+simulation.scene.sparks.length+simulation.scene.ripples.length,0);
  }
});
test('hidden, reduced-motion, removed and destroyed canvases stop animation work',()=>{
  const frames=new Map(),media={matches:false,listener:null,addEventListener(_name,fn){this.listener=fn;},removeEventListener(){this.listener=null;}};
  let seq=0,disconnected=false,clears=0;
  const context={clearRect(){clears++;},setTransform(){},fillText(){},fillRect(){},beginPath(){},ellipse(){},stroke(){},createLinearGradient(){return {addColorStop(){}};}};
  const canvas={isConnected:true,getContext:()=>context};
  const factory=api({document:{visibilityState:'visible'},matchMedia:()=>media,devicePixelRatio:2,
    requestAnimationFrame:fn=>{const id=++seq;frames.set(id,fn);return id;},cancelAnimationFrame:id=>frames.delete(id),
    ResizeObserver:class{observe(){}disconnect(){disconnected=true;}}});
  const effect=factory.mount(canvas,{getBoundingClientRect:()=>({width:342,height:480})});
  effect.setStage('running');assert.equal(frames.size,1);
  for(let n=0;n<100;n++)effect.setStage('running');assert.equal(frames.size,1);
  effect.setVisible(false);assert.equal(frames.size,0);assert.ok(clears>0);
  effect.setVisible(true);assert.equal(frames.size,1);
  media.matches=true;media.listener();assert.equal(frames.size,0);
  media.matches=false;media.listener();assert.equal(frames.size,1);
  canvas.isConnected=false;const [id,draw]=frames.entries().next().value;frames.delete(id);draw(50);assert.equal(frames.size,0);
  effect.destroy();assert.equal(disconnected,true);assert.equal(media.listener,null);
  effect.setStage('running');assert.equal(frames.size,0);
});
