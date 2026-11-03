<title>Railcar Screen Takes</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@800&family=IBM+Plex+Mono:wght@500&family=Schibsted+Grotesk:wght@400;700;800&display=swap">
<style>
:root{--bg:#f2f4f3;--fg:#10181b;--fg2:#4d5b60;--card:#fff;--line:#cfd7d5;--em:#0a7d5c}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#090d0f;--fg:#eaefec;--fg2:#8d9a9a;--card:#11161a;--line:#26323a;--em:#24d8a8;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#090d0f;--fg:#eaefec;--fg2:#8d9a9a;--card:#11161a;--line:#26323a;--em:#24d8a8;color-scheme:dark}
body{background:var(--bg);color:var(--fg);font:15px/1.5 "Schibsted Grotesk",system-ui,sans-serif;padding-block:24px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}
h1{font:800 34px/1 "Barlow Condensed",Impact,sans-serif;text-transform:uppercase;letter-spacing:.02em;margin:0 0 6px}
.lead{color:var(--fg2);margin:0 0 18px}
nav{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}
.tabs button,.ctl button{font:inherit;color:var(--fg);background:var(--card);border:1px solid var(--line);padding:8px 14px;cursor:pointer}
.tabs button[aria-pressed=true]{background:var(--em);color:var(--bg);border-color:var(--em);font-weight:700}
button:focus-visible{outline:2px solid var(--em);outline-offset:2px}
.sub{color:var(--fg2);margin:0 0 12px;max-width:65ch}
.row{display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start}
figure{margin:0}
.shot{display:block;width:min(390px,100%);height:auto;border:1px solid var(--line)}
figcaption{margin-top:8px;font-size:14px}
@@CSS@@
</style>
<h1>Railcar screens</h1>
<p class="lead">Round 2: Boarding fixed, new Ride and Spectator, Result as picked.</p>
<nav class="tabs"><button type="button" data-t="boarding">Boarding</button><button type="button" data-t="ride_">Ride</button><button type="button" data-t="spectator">Spectator</button><button type="button" data-t="result">Result</button></nav>
@@BOARDING@@@@RIDE@@@@SPEC@@@@RESULT@@
<script>window.RC_ASSETS=@@ASSETS@@;</script>
<script>@@JS@@</script>
<script>
var bs=document.querySelectorAll(".tabs button"),sc={};
function show(id){bs.forEach(function(b){b.setAttribute("aria-pressed",b.dataset.t===id)});document.querySelectorAll("section").forEach(function(s){s.hidden=s.id!==id});for(var k in sc)sc[k].pause();document.querySelectorAll(".pp").forEach(function(p){p.textContent="Play"})}
bs.forEach(function(b){b.onclick=function(){show(b.dataset.t)}});
sc.ride=RC_Scene(document.getElementById("ride"),{start:65,aboard:31,player:true,keep:4,stages:[60,75,90],end:110});
sc.spec=RC_Scene(document.getElementById("spec"),{start:52,aboard:44,player:false,keep:5,stages:[45,70,95],end:100});
document.querySelectorAll("[data-play]").forEach(function(b){b.onclick=function(){var s=sc[b.dataset.play];if(s.running){s.pause();b.textContent="Play"}else{s.play();b.textContent="Pause"}}});
document.querySelectorAll("[data-reset]").forEach(function(b){b.onclick=function(){var s=sc[b.dataset.reset];s.pause();s.reset(true);var p=document.querySelector('[data-play="'+b.dataset.reset+'"]');p.textContent="Pause"}});
show("boarding");window.RC=sc;
</script>
