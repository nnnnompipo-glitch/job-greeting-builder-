/* Decorative, local-only code rain. It never consumes page or candidate text. */
(() => {
  const GLYPHS = '01<>/{}[]_+=:;';
  const ACTIVE = new Set(['reading', 'queued', 'running']);
  function createSimulation(random = Math.random) {
    const scene = {width:1,height:1,stage:'',elapsed:0,drops:[],sparks:[],ripples:[]};
    let credit = 0;
    const glyph = () => GLYPHS[Math.floor(random() * GLYPHS.length)];
    const spawn = (seed = false) => ({
      x:10 + random() * Math.max(1,scene.width-20),
      y:seed ? random() * scene.height : -12-random()*70,
      vy:85+random()*105,
      glyphs:Array.from({length:3+Math.floor(random()*4)},glyph)
    });
    const clear = () => {scene.drops.length=scene.sparks.length=scene.ripples.length=0;credit=0;};
    const density = () => scene.stage==='reading' ? 6 : scene.stage==='queued' ? 12 :
      scene.stage==='running' ? 22+Math.min(8,Math.floor(scene.elapsed/1.5)) : 0;
    return {
      scene,density,clear,
      resize(width,height) {
        const previousWidth=scene.width;
        scene.width=Math.max(1,width);scene.height=Math.max(1,height);
        for(const drop of scene.drops)drop.x*=scene.width/previousWidth;
      },
      setStage(stage) {
        if(stage===scene.stage)return;
        scene.stage=stage;scene.elapsed=0;
        if(!ACTIVE.has(stage)){clear();return;}
        if(!scene.drops.length)for(let i=0;i<6;i++)scene.drops.push(spawn(true));
      },
      step(seconds) {
        if(!ACTIVE.has(scene.stage))return;
        const dt=Math.min(Math.max(seconds,0),0.05),floor=Math.max(1,scene.height-7);
        scene.elapsed+=dt;credit=Math.min(30,credit+dt*24);
        const target=density();
        while(scene.drops.length<target&&credit>=1){scene.drops.push(spawn());credit--;}
        if(scene.drops.length>target)scene.drops.length=target;
        // Ballistic splashes fall back to the floor, bounce once, then fade out.
        scene.sparks=scene.sparks.filter(spark=>{
          spark.life-=dt;spark.vy+=190*dt;spark.x+=spark.vx*dt;spark.y+=spark.vy*dt;
          if(spark.y>=floor&&spark.vy>0){
            spark.y=floor;spark.vy=-spark.vy*0.24;spark.vx*=0.65;
            if(++spark.bounces>1)spark.life=0;
          }
          return spark.life>0;
        });
        scene.ripples=scene.ripples.filter(ripple=>{ripple.life-=dt;return ripple.life>0;});
        for(let index=0;index<scene.drops.length;index++){
          const drop=scene.drops[index];drop.vy+=48*dt;drop.y+=drop.vy*dt;
          if(drop.y<floor)continue;
          if(scene.ripples.length<24)scene.ripples.push({x:drop.x,y:floor,life:0.5});
          for(let n=0;n<5&&scene.sparks.length<120;n++)scene.sparks.push({
            x:drop.x,y:floor,vx:(n-2)*(13+random()*13),vy:-(22+random()*32),life:0.45+random()*0.2,bounces:0
          });
          scene.drops[index]=spawn();
        }
      }
    };
  }

  function mount(canvas,container) {
    const context=canvas.getContext('2d');
    if(!context)return {setStage(){},setVisible(){},destroy(){}};
    const simulation=createSimulation(),motion=matchMedia('(prefers-reduced-motion: reduce)');
    let visible=true,destroyed=false,frame=0,lastTime=0;
    const clearCanvas=()=>context.clearRect(0,0,simulation.scene.width,simulation.scene.height);
    const allowed=()=>!destroyed&&visible&&!motion.matches&&canvas.isConnected&&
      document.visibilityState==='visible'&&ACTIVE.has(simulation.scene.stage);
    function stop(){cancelAnimationFrame(frame);frame=0;lastTime=0;clearCanvas();}
    function draw(time){
      frame=0;
      if(!allowed()){stop();return;}
      if(lastTime&&time-lastTime<1000/30){frame=requestAnimationFrame(draw);return;}
      const dt=lastTime?(time-lastTime)/1000:1/30;lastTime=time;simulation.step(dt);
      const {width,height,drops,sparks,ripples}=simulation.scene;
      clearCanvas();context.font='11px Consolas,monospace';context.textAlign='center';
      for(const drop of drops){
        for(let n=drop.glyphs.length-1;n>=0;n--){
          const y=drop.y-n*12;if(y<0||y>height-7)continue;
          context.fillStyle=`rgba(91,255,173,${n===0?0.31:0.16*(1-n/drop.glyphs.length)})`;
          context.fillText(drop.glyphs[n],drop.x,y);
        }
      }
      for(const ripple of ripples){
        const age=1-ripple.life/0.5;
        context.strokeStyle=`rgba(105,255,188,${0.32*(1-age)})`;context.lineWidth=0.8;
        context.beginPath();context.ellipse(ripple.x,ripple.y,2+age*12,0.7+age*2.1,0,0,Math.PI*2);context.stroke();
      }
      for(const spark of sparks){
        context.fillStyle=`rgba(150,255,210,${Math.min(0.6,spark.life)*0.65})`;
        context.fillRect(spark.x,spark.y,1.3,1.7);
      }
      const ground=context.createLinearGradient(0,0,width,0);
      ground.addColorStop(0,'transparent');ground.addColorStop(0.5,'rgba(98,255,173,0.2)');ground.addColorStop(1,'transparent');
      context.fillStyle=ground;context.fillRect(0,height-6,width,1);
      frame=requestAnimationFrame(draw);
    }
    function sync(){if(allowed()){if(!frame)frame=requestAnimationFrame(draw);}else stop();}
    function resize(){
      const bounds=container.getBoundingClientRect(),ratio=Math.min(devicePixelRatio||1,2);
      simulation.resize(bounds.width,bounds.height);
      canvas.width=Math.max(1,Math.round(bounds.width*ratio));canvas.height=Math.max(1,Math.round(bounds.height*ratio));
      context.setTransform(ratio,0,0,ratio,0,0);sync();
    }
    const observer=new ResizeObserver(resize);observer.observe(container);resize();
    motion.addEventListener('change',sync);
    return {
      setStage(stage){if(destroyed)return;simulation.setStage(stage);sync();},
      setVisible(value){if(destroyed)return;visible=Boolean(value);sync();},
      destroy(){destroyed=true;stop();simulation.clear();observer.disconnect();motion.removeEventListener('change',sync);}
    };
  }
  globalThis.RecruitmentCodeRain=Object.freeze({createSimulation,mount});
})();
