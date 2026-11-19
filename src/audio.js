// audio.js —— WebAudio 实时合成音效,零音频文件
export class AudioFX{
  constructor(){this.ctx=null;this.ok=false;this._whine=null;this._droneGain=null;}

  init(){
    if(this.ok)return;
    const C=window.AudioContext||window.webkitAudioContext;
    if(!C)return;
    this.ctx=new C();
    this.master=this.ctx.createGain();this.master.gain.value=.8;
    const comp=this.ctx.createDynamicsCompressor();
    comp.threshold.value=-16;comp.knee.value=18;comp.ratio.value=7;comp.attack.value=.003;
    this.master.connect(comp);comp.connect(this.ctx.destination);
    // 噪声缓冲
    const len=this.ctx.sampleRate*2;
    this.noiseBuf=this.ctx.createBuffer(1,len,this.ctx.sampleRate);
    const d=this.noiseBuf.getChannelData(0);
    let b0=0,b1=0,b2=0;
    for(let i=0;i<len;i++){ // 粉噪声近似
      const w=Math.random()*2-1;
      b0=.997*b0+.029*w;b1=.985*b1+.032*w;b2=.95*b2+.048*w;
      d[i]=(b0+b1+b2+w*.05)*.55;
    }
    this._wind();this._droneHum();
    this.ok=true;
  }
  resume(){if(this.ctx&&this.ctx.state==='suspended')this.ctx.resume();}
  setVolume(v){if(this.master)this.master.gain.value=v*.95;}

  _noise(t0,dur,gain,{freq=800,q=.7,type='bandpass',slide=null}={}){
    const src=this.ctx.createBufferSource();src.buffer=this.noiseBuf;src.loop=true;
    src.playbackRate.value=.9+Math.random()*.2;
    const f=this.ctx.createBiquadFilter();f.type=type;f.frequency.setValueAtTime(freq,t0);f.Q.value=q;
    if(slide)f.frequency.exponentialRampToValueAtTime(slide,t0+dur);
    const g=this.ctx.createGain();
    g.gain.setValueAtTime(0,t0);g.gain.linearRampToValueAtTime(gain,t0+.004);
    g.gain.exponentialRampToValueAtTime(.001,t0+dur);
    src.connect(f);f.connect(g);g.connect(this.master);
    src.start(t0);src.stop(t0+dur+.05);
    return f;
  }
  _tone(t0,dur,gain,{freq=440,end=null,type='sine'}={}){
    const o=this.ctx.createOscillator();o.type=type;
    o.frequency.setValueAtTime(freq,t0);
    if(end)o.frequency.exponentialRampToValueAtTime(Math.max(1,end),t0+dur);
    const g=this.ctx.createGain();
    g.gain.setValueAtTime(0,t0);g.gain.linearRampToValueAtTime(gain,t0+.005);
    g.gain.exponentialRampToValueAtTime(.001,t0+dur);
    o.connect(g);g.connect(this.master);
    o.start(t0);o.stop(t0+dur+.05);
    return o;
  }

  _wind(){
    const src=this.ctx.createBufferSource();src.buffer=this.noiseBuf;src.loop=true;
    const f=this.ctx.createBiquadFilter();f.type='lowpass';f.frequency.value=420;f.Q.value=.4;
    const g=this.ctx.createGain();g.gain.value=.05;
    const lfo=this.ctx.createOscillator();lfo.frequency.value=.08;
    const lg=this.ctx.createGain();lg.gain.value=180;
    lfo.connect(lg);lg.connect(f.frequency);
    src.connect(f);f.connect(g);g.connect(this.master);
    src.start();lfo.start();
    this._windGain=g;
  }
  setWind(v){if(this._windGain)this._windGain.gain.value=v;}

  _droneHum(){
    const g=this.ctx.createGain();g.gain.value=0;
    const f=this.ctx.createBiquadFilter();f.type='lowpass';f.frequency.value=260;
    const o1=this.ctx.createOscillator();o1.type='sawtooth';o1.frequency.value=52;
    const o2=this.ctx.createOscillator();o2.type='sawtooth';o2.frequency.value=55.5;
    o1.connect(f);o2.connect(f);f.connect(g);g.connect(this.master);
    o1.start();o2.start();
    this._droneGain=g;
  }
  setDrone(level){ // 0~1 无人机接近紧张度
    if(!this.ctx)return;
    this._droneGain.gain.setTargetAtTime(level*.14,this.ctx.currentTime,.3);
  }

  /* ---- 具体 SFX ---- */
  shot(){
    if(!this.ok)return;const t=this.ctx.currentTime;
    this._noise(t,.09,.8,{freq:1600,q:.6,slide:500});
    this._noise(t,.16,.5,{freq:300,q:.8,type:'lowpass'});
    this._tone(t,.07,.7,{freq:170,end:55,type:'triangle'});
  }
  empty(){
    if(!this.ok)return;const t=this.ctx.currentTime;
    this._tone(t,.04,.3,{freq:2200,type:'square'});
    this._noise(t,.03,.2,{freq:3000,q:3});
  }
  reload(stage){ // 0 出弹匣 1 上弹匣 2 拉枪机
    if(!this.ok)return;const t=this.ctx.currentTime;
    if(stage===0){this._noise(t,.06,.3,{freq:900,q:2});this._tone(t,.05,.2,{freq:340,end:200,type:'square'});}
    else if(stage===1){this._noise(t,.07,.35,{freq:700,q:2});this._tone(t,.06,.3,{freq:520,end:340,type:'square'});}
    else{this._noise(t,.05,.4,{freq:1300,q:2});this._tone(t,.09,.25,{freq:1900,end:900,type:'triangle'});}
  }
  hit(crit){
    if(!this.ok)return;const t=this.ctx.currentTime;
    if(crit){this._tone(t,.07,.5,{freq:520,end:260,type:'square'});this._tone(t+.03,.06,.4,{freq:880});}
    else this._tone(t,.045,.35,{freq:1150,end:900});
  }
  kill(){
    if(!this.ok)return;const t=this.ctx.currentTime;
    this._tone(t,.09,.35,{freq:660});this._tone(t+.08,.12,.3,{freq:990});
  }
  explosion(dist=10){
    if(!this.ok)return;const t=this.ctx.currentTime;
    const v=Math.max(.12,.95-Math.min(1,dist/45));
    this._noise(t,.7,.9*v,{freq:600,slide:60,type:'lowpass'});
    this._noise(t,.25,.7*v,{freq:2400,q:.5,slide:300});
    this._tone(t,.55,.8*v,{freq:75,end:28,type:'sine'});
  }
  boltShoot(){
    if(!this.ok)return;const t=this.ctx.currentTime;
    this._tone(t,.16,.3,{freq:1300,end:280,type:'sawtooth'});
  }
  whineStart(){
    if(!this.ok||this._whine)return;
    const o=this.ctx.createOscillator();o.type='sawtooth';o.frequency.value=420;
    const g=this.ctx.createGain();g.gain.value=0;
    o.connect(g);g.connect(this.master);o.start();
    this._whine={o,g};
  }
  whineSet(level,freq){
    if(!this._whine)return;
    const t=this.ctx.currentTime;
    this._whine.g.gain.setTargetAtTime(level*.11,t,.08);
    this._whine.o.frequency.setTargetAtTime(freq,t,.1);
  }
  whineStop(){
    if(!this._whine)return;
    const w=this._whine;this._whine=null;
    w.g.gain.setTargetAtTime(0,this.ctx.currentTime,.05);
    setTimeout(()=>{try{w.o.stop();}catch(e){}},300);
  }
  hurt(){
    if(!this.ok)return;const t=this.ctx.currentTime;
    this._tone(t,.12,.5,{freq:110,end:45,type:'triangle'});
    this._noise(t,.12,.35,{freq:500,slide:150,type:'lowpass'});
  }
  step(alt){
    if(!this.ok)return;const t=this.ctx.currentTime;
    this._noise(t,.05,alt?.16:.12,{freq:alt?260:220,type:'lowpass'});
  }
  waveStart(){
    if(!this.ok)return;const t=this.ctx.currentTime;
    this._tone(t,.16,.3,{freq:220,type:'triangle'});
    this._tone(t+.18,.28,.32,{freq:293.6,type:'triangle'});
    this._tone(t+.18,.28,.12,{freq:587,type:'sine'});
    this._tone(t+.42,.4,.2,{freq:220,type:'sawtooth'});
  }
  supply(){
    if(!this.ok)return;const t=this.ctx.currentTime;
    this._tone(t,.1,.25,{freq:880});this._tone(t+.11,.16,.25,{freq:1174});
  }
  uiClick(){
    if(!this.ok)return;
    this._tone(this.ctx.currentTime,.05,.2,{freq:1400,end:900});
  }
  cannon(){
    if(!this.ok)return;const t=this.ctx.currentTime;
    this._noise(t,.4,.95,{freq:800,slide:80,type:'lowpass'});
    this._tone(t,.3,.9,{freq:95,end:30,type:'sawtooth'});
    this._tone(t+.02,.4,.5,{freq:1200,end:220,type:'sine'});
  }
  deagle(){ // 沙漠之鹰:.50 AE 重磅枪声
    if(!this.ok)return;const t=this.ctx.currentTime;
    this._noise(t,.14,.9,{freq:900,q:.6,slide:180});
    this._noise(t,.24,.55,{freq:220,q:.7,type:'lowpass'});
    this._tone(t,.13,.85,{freq:120,end:36,type:'sawtooth'});
  }
  knifeSwing(){ // 军刀挥空
    if(!this.ok)return;const t=this.ctx.currentTime;
    this._noise(t,.13,.3,{freq:2600,q:1.1,slide:500});
  }
  knifeHit(){ // 军刀入肉/砍中
    if(!this.ok)return;const t=this.ctx.currentTime;
    this._noise(t,.08,.5,{freq:1500,q:2,slide:350});
    this._tone(t,.07,.4,{freq:340,end:110,type:'square'});
  }
  botShot(dist){
    if(!this.ok)return;const t=this.ctx.currentTime;
    const v=Math.max(.05,.5-Math.min(1,dist/50)*.45);
    this._noise(t,.06,v,{freq:1300,q:.6,slide:500});
    this._tone(t,.05,v*.7,{freq:150,end:60,type:'triangle'});
  }
  hammer(dist=5){
    if(!this.ok)return;const t=this.ctx.currentTime;
    const v=Math.max(.2,.9-Math.min(1,dist/30)*.6);
    this._tone(t,.25,.9*v,{freq:70,end:26,type:'sine'});
    this._noise(t,.3,.7*v,{freq:500,slide:90,type:'lowpass'});
  }
  respawn(){
    if(!this.ok)return;const t=this.ctx.currentTime;
    this._tone(t,.1,.2,{freq:660});this._tone(t+.1,.16,.2,{freq:990});
  }
  gameOver(){
    if(!this.ok)return;const t=this.ctx.currentTime;
    this._tone(t,.5,.4,{freq:196,type:'triangle'});
    this._tone(t+.4,.7,.35,{freq:146.6,type:'triangle'});
    this._tone(t+.8,1.1,.3,{freq:98,type:'sawtooth'});
  }
}
