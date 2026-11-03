import base64,os,sys,json
P=os.path.expanduser('~/.cache/tesoro-tmp/rc09')
R=os.path.expanduser('~/Work/gemstone-labs/tesoro/art-source/railcar')
def b64(path,mime): return f"data:{mime};base64,"+base64.b64encode(open(path,'rb').read()).decode()
assets={"far":b64(P+'/p/far.webp','image/webp'),"mid":b64(P+'/p/mid.webp','image/webp'),"trk":b64(P+'/p/track.webp','image/webp'),
 "car":b64(P+'/p/car.webp','image/webp'),"wheel":b64(P+'/p/wheel.webp','image/webp'),"av":[b64(P+f'/p/av{i}.webp','image/webp') for i in range(6)]}
def still(name):
    f=f'{R}/round2/{name}.png'
    if not os.path.exists(f): return ''
    os.system(f'magick {f} -quality 85 {P}/{name}.webp'); return b64(f'{P}/{name}.webp','image/webp')
def img(path,alt):
    os.system(f'magick {path} -quality 85 {P}/t.webp'); return f'<img class="shot" alt="{alt}" src="{b64(P+"/t.webp","image/webp")}">'
def stage(extra=''):
    return f'''<div class="stage"><div class="lay far" style="background-image:url({assets['far']})"></div><div class="lay mid" style="background-image:url({assets['mid']})"></div><div class="lay trk" style="background-image:url({assets['trk']})"></div><div class="carwrap"><div class="car" style="background-image:url({assets['car']})"></div></div>{extra}</div>'''
tells='<div class="tells"><div class="tell cut"><i><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M8 12h8"/></svg></i>Screws</div><div class="tell cut"><i><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 4v10l-7 4-7-4V7z"/><circle cx="12" cy="12" r="2.5"/></svg></i>Panel</div><div class="tell cut"><i><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3L5 14h6l-1 7 8-11h-6z"/></svg></i>Sparks</div></div>'
ride=f'''<div class="phone" id="ride"><div class="top"><button class="ibtn cut" type="button" aria-label="Back">&#8249;</button><span class="ttl">Railcar</span><button class="ibtn cut" type="button" aria-label="Info">i</button></div>
<div class="clock">1:05</div>{tells}{stage('<div class="brkTag cut">Your Brake <b>5s</b> &middot; only you see this</div>')}
<div class="stake cut"><span>At stake</span><span class="em stakeN">15,500</span></div>
<div class="aboard"><h4><span>Aboard <span class="aboardN">31</span></span><span>Names leave when they Jump</span></h4><div class="strip"></div></div>
<div class="acts"><button class="jump cut" type="button">Jump</button><button class="brake cut" type="button">Brake<small>1 left</small></button></div></div>'''
spec=f'''<div class="phone" id="spec"><div class="top"><span class="live">Live</span><span class="ttl">Railcar</span><button class="chipbtn cut" type="button">Sign in</button></div>
<div class="clock">0:52</div>{tells}{stage()}
<div class="stake cut"><span>At stake</span><span class="em stakeN">22,000</span></div>
<div class="aboard"><h4><span>Aboard <span class="aboardN">44</span></span></h4><div class="strip"></div></div>
<div style="height:12px"></div><button class="cta cut" type="button">Play the next ride</button><div class="note">Boarding next: 12 aboard</div></div>'''
def panel(id,title,sub,proto,stillf):
    st=f'<figure><img class="shot" alt="{title} still frame" src="{stillf}"><figcaption>Still frame</figcaption></figure>' if stillf else ''
    return f'''<section id="{id}" hidden><p class="sub">{sub}</p><div class="row"><div><div class="ctl"><button type="button" data-play="{proto[1]}" class="pp">Play</button><button type="button" data-reset="{proto[1]}">Restart</button></div>{proto[0]}</div>{st}</div></section>'''
bo=img(R+'/round2/bo1-fixed.png','Boarding'); re=img(R+'/result/re1-390.png','Result')
page=open('page.tpl').read()
page=(page.replace('@@CSS@@',open('proto.css').read()).replace('@@ASSETS@@',json.dumps(assets)).replace('@@JS@@',open('proto.js').read())
 .replace('@@BOARDING@@',f'<section id="boarding" hidden><p class="sub">Picked bo1, vehicle replaced with a real railcar. Everything else is the original take.</p><div class="row"><figure>{bo}<figcaption>Boarding</figcaption></figure></div></section>')
 .replace('@@RIDE@@',panel('ride_','Ride','Side-view railcar, cave scrolls. Press Jump to leap off, Brake slows the car on your screen only (5 s, once). No speed, distance or refund percentage.',(ride,'ride'),still('ride-still')))
 .replace('@@SPEC@@',panel('spectator','Spectator','Same side-view animation, no Jump or Brake, sign in to play.',(spec,'spec'),still('spec-still')))
 .replace('@@RESULT@@',f'<section id="result" hidden><p class="sub">Picked re1 as is. Polish happens in the app build.</p><div class="row"><figure>{re}<figcaption>Result</figcaption></figure></div></section>'))
open(P+'/railcar-canvas.html','w').write(page); print(len(page)//1024,'KB')
