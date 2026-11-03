(function(){
var A=window.RC_ASSETS;
var NAMES=["Nadia","Juno","Rocco","Big L","kai.sol","Mira","Ada","Teo","Lux","Remy","Zed","Pia","Sol","Noor","Ines","Oto","Vic","Wes","Yui","Abe","Bo","Cal","Dov","Eli","Fay","Gus","Hal","Ivo","Jay","Kit","Leo","Max","Ned","Ola","Pax","Quin","Rex","Sky","Tam","Uma","Val","Wim","Xan","Yas","Zoe","Ari","Bex","Cy","Dee","Eve"];
var SPEED={far:14,mid:40,trk:130};
function Scene(root,cfg){
  var s={root:root,cfg:cfg,t0:0,clock:cfg.start,speed:1,running:false,off:{far:0,mid:0,trk:0},last:0,brakeLeft:0,brakeUsed:false,me:null,jumped:false};
  s.q=function(sel){return root.querySelector(sel)};
  s.build=function(){
    s.aboard=[];for(var i=0;i<cfg.aboard;i++)s.aboard.push({name:NAMES[i%NAMES.length],av:i%6,me:cfg.player&&i===0});
    var strip=s.q(".strip");strip.innerHTML="";
    s.aboard.forEach(function(p,i){var c=document.createElement("div");c.className="chip"+(p.me?" me":"");c.innerHTML='<span class="a"><img src="'+A.av[p.av]+'" alt=""></span>'+(p.me?"You":p.name);strip.appendChild(c);p.chip=c});
    var w=s.q(".carwrap");w.querySelectorAll(".win,.wh").forEach(function(e){e.remove()});
    s.wins=[];
    for(var i=0;i<12;i++){var d=document.createElement("div");d.className="win";d.style.left=(137+71.4*i-31)*.352+"px";d.innerHTML='<img alt="">';w.appendChild(d);s.wins.push({el:d,img:d.firstChild,p:null})}
    [145,293,768,915].forEach(function(x){var d=document.createElement("div");d.className="wh";d.style.left=(x*.352-16)+"px";d.style.top=(305*.352-16)+"px";d.style.backgroundImage="url("+A.wheel+")";w.appendChild(d)});
    s.whs=w.querySelectorAll(".wh");
    s.seat();
  };
  s.seat=function(){ // fill windows with aboard players who are not seated yet
    var seated=s.wins.filter(function(w){return w.p}).map(function(w){return w.p});
    s.wins.forEach(function(w,i){
      if(w.p&&w.p.out){w.p=null;w.img.style.opacity=0}
      if(!w.p){var p=s.aboard.filter(function(q){return !q.out&&seated.indexOf(q)<0&&!(cfg.player&&q.me&&i!==4)})[0];
        if(cfg.player&&i===4){p=s.aboard[0]}
        if(p&&(!p.me||i===4)){w.p=p;seated.push(p);w.img.src=A.av[p.av];w.img.style.opacity=1}else{w.img.style.opacity=0}}
    });
  };
  s.fmt=function(c){c=Math.floor(c);return Math.floor(c/60)+":"+("0"+c%60).slice(-2)};
  s.jump=function(p){
    if(p.out)return;p.out=true;
    var left=s.aboard.filter(function(q){return !q.out}).length;
    var win=s.wins.filter(function(w){return w.p===p})[0]||s.wins[Math.floor(Math.random()*12)];
    var stage=s.q(".stage");var sr=stage.getBoundingClientRect();var k=sr.width/390;
    var wr=win.el.getBoundingClientRect();
    var f=document.createElement("div");f.className="fly";f.innerHTML='<img src="'+A.av[p.av]+'" alt=""><span>'+(p.me?"You":p.name)+'</span>';stage.appendChild(f);
    var x0=(wr.left-sr.left)/k-6,y0=(wr.top-sr.top)/k-2;
    var T=1.6,st=performance.now(),ground=190;
    (function step(now){if(window.RC_FREEZE)return;var u=Math.min((now-st)/(T*1000),1),sec=u*T;
      var x=x0+(p.me?46:30)*sec-95*sec*sec;
      var y=y0+(ground-y0)*u*u-105*Math.sin(Math.PI*u);
      f.style.transform="translate("+x+"px,"+y+"px) rotate("+(u*(p.me?300:200))+"deg) scale("+(1+0.2*Math.sin(Math.PI*u))+")";
      f.style.opacity=u>.8?(1-u)/.2:1;
      if(u<1&&s.root.isConnected)requestAnimationFrame(step);else f.remove();
    })(performance.now());
    if(p.chip){p.chip.classList.add("gone")}
    var nm=s.q(".aboardN");if(nm)nm.textContent=left;
    var st2=s.q(".stakeN");if(st2)st2.textContent=(left*500).toLocaleString("en-US");
    s.seat();
  };
  s.tick=function(now){
    if(!s.running)return;
    var dt=Math.min((now-(s.last||now))/1000,.1);s.last=now;
    var target=s.brakeLeft>0?.5:1;s.speed+=(target-s.speed)*Math.min(dt*6,1);
    s.clock+=dt;
    ["far","mid","trk"].forEach(function(k){s.off[k]-=SPEED[k]*s.speed*dt;var e=s.q(".lay."+k);if(e){var h=k==="trk"?100:300;e.style.backgroundPositionX=s.off[k]+"px"}});
    s.whs.forEach(function(w){w.style.transform="rotate("+(s.off.trk*1.4)+"deg)"});
    var cw=s.q(".carwrap");cw.style.transform="translateY("+(Math.sin(now/90)*0.6)+"px)";
    s.q(".clock").textContent=s.fmt(s.clock);
    var stg=s.cfg.stages;s.qa(".tell").forEach(function(e,i){e.classList.toggle("on",s.clock>=stg[i])});
    if(s.brakeLeft>0){s.brakeLeft-=dt;var tg=s.q(".brkTag");tg.classList.add("on");tg.querySelector("b").textContent=Math.max(0,Math.ceil(s.brakeLeft))+"s";if(s.brakeLeft<=0){tg.classList.remove("on")}}
    // scripted Jumps
    while(s.sched.length&&s.clock>=s.sched[0]){s.sched.shift();var c=s.aboard.filter(function(q){return !q.out&&!q.me});if(c.length>cfg.keep)s.jump(c[Math.floor(Math.random()*c.length)])}
    if(s.clock>cfg.end){s.reset(true);return}
    requestAnimationFrame(s.tick);
  };
  s.qa=function(sel){return root.querySelectorAll(sel)};
  s.reset=function(keep){
    s.clock=cfg.start;s.speed=1;s.brakeLeft=0;s.brakeUsed=false;s.jumped=false;
    s.q(".stage").querySelectorAll(".fly").forEach(function(e){e.remove()});
    s.sched=[];var t=cfg.start+2;for(var i=0;i<60;i++){t+=2+Math.random()*3.5;s.sched.push(t)}
    s.build();
    var n=s.q(".aboardN");if(n)n.textContent=cfg.aboard;var k=s.q(".stakeN");if(k)k.textContent=(cfg.aboard*500).toLocaleString("en-US");
    var j=s.q(".jump");if(j){j.disabled=false;j.textContent="Jump"}
    var b=s.q(".brake");if(b){b.disabled=false;b.innerHTML="Brake<small>1 left</small>"}
    s.q(".brkTag")&&s.q(".brkTag").classList.remove("on");
    if(keep){s.running=true;s.last=0;requestAnimationFrame(s.tick)}
  };
  s.play=function(){if(s.running)return;s.running=true;s.last=0;requestAnimationFrame(s.tick)};
  s.pause=function(){s.running=false};
  var j=s.q(".jump");if(j)j.onclick=function(){var me=s.aboard[0];if(me&&!me.out){s.jump(me);j.disabled=true;j.textContent="You jumped";var b=s.q(".brake");if(b)b.disabled=true}};
  var b=s.q(".brake");if(b)b.onclick=function(){if(s.brakeUsed||s.jumped)return;s.brakeUsed=true;s.brakeLeft=5;b.disabled=true;b.innerHTML="Brake<small>0 left</small>"};
  s.reset(false);
  return s;
}
window.RC_Scene=Scene;
})();
