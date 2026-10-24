/** Real browser regression: PW=/path/to/playwright-core node scripts/block-burst-feel-check.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? 'playwright-core');
const ts = require('typescript');
const source = await readFile(new URL('../src/games/block-puzzle/engine.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const engine = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const { newState, apply, pieceAt, handBase, fitsAt, dims } = engine;
const base = process.env.BASE ?? 'http://localhost:3391';
const out = process.env.OUT ?? join(homedir(), '.cache/tesoro-tmp/block-burst-feel');
await mkdir(out, { recursive: true });

// Deterministic legal placements through the real engine, not a game-state backdoor.
function scenario(seed) {
  let st = newState(seed), combo = 0;
  const moves = [];
  for (let n = 0; n < 42 && !st.over; n++) {
    let best;
    for (let slot = 0; slot < 3; slot++) {
      if (st.used & (1 << slot)) continue;
      const piece = handBase(st) + slot;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        if (!fitsAt(st, pieceAt(seed, piece), x, y)) continue;
        const next = apply(st, { piece, x, y });
        let compact = 0;
        for (let k = 0; k < 8; k++) {
          let row = 0, col = 0;
          for (let j = 0; j < 8; j++) {
            row += Number((next.state.occ >> BigInt(k * 8 + j)) & 1n);
            col += Number((next.state.occ >> BigInt(j * 8 + k)) & 1n);
          }
          compact += row * row + col * col;
        }
        const rank = next.result.lines * 1000 + next.result.gems * 200 + compact - y * .1 - x * .01 - (next.state.over ? 100000 : 0);
        if (!best || rank > best.rank) best = { piece, x, y, rank, ...next };
      }
    }
    if (!best) break;
    combo = best.result.lines ? combo + 1 : 0;
    moves.push({ ...best, combo });
    st = best.state;
  }
  return moves;
}
let seed = 1n, sequence;
for (; seed < 30n; seed++) {
  sequence = scenario(seed);
  if (sequence.some(m => m.result.lines >= 2 && m.result.gems === 0) && sequence.some(m => m.result.gems) && sequence.some(m => m.combo >= 2)) break;
}
assert.ok(seed < 30n, 'fixture includes double, gem and consecutive clears');
await writeFile(join(out, 'sequence.json'), JSON.stringify({ seed, sequence }, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2));
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? join(homedir(), '.cache/ms-playwright/chromium-1228/chrome-linux64/chrome') });
const results = [];
try {
  for (const mode of (process.env.MODES ?? 'touch,settings,reduced,unsupported').split(',')) {
    const context = await browser.newContext({ viewport: { width: Number(process.env.WIDTH ?? 390), height: Number(process.env.HEIGHT ?? 844) }, hasTouch: true, isMobile: true, ...(mode==='capture' ? {recordVideo:{dir:join(out,'video'),size:{width:390,height:844}}} : {}), reducedMotion: mode === 'reduced' ? 'reduce' : 'no-preference' });
    await context.addInitScript(({ seed, supported, hapticMode }) => {
      const original = crypto.getRandomValues.bind(crypto);
      crypto.getRandomValues = (array) => { if (array instanceof BigUint64Array && array.length === 1) { array[0] = BigInt(seed); return array; } return original(array); };
      window.__boardCommits = 0;
      window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
        supportsFiber: true, renderers: new Map(),
        inject(renderer) { const id = this.renderers.size + 1; this.renderers.set(id, renderer); return id; },
        onCommitFiberUnmount() {},
        onCommitFiberRoot(_id, root) {
          function walk(f) {
            if (!f) return;
            if (f.type === 'div' && f.memoizedProps?.role === 'grid' && f.memoizedProps?.['aria-label'] === 'Block Burst board, 8 by 8' && f.memoizedProps !== f.alternate?.memoizedProps) window.__boardCommits++;
            walk(f.child); walk(f.sibling);
          }
          walk(root.current);
        },
      };
      window.__lastPointer = null;
      document.addEventListener('pointermove', e => { window.__lastPointer = {x:e.clientX,y:e.clientY}; }, true);
      window.__haptics = [];
      Object.defineProperty(navigator, 'vibrate', { configurable: true, value: supported ? (pattern) => { window.__haptics.push(pattern); if(hapticMode === "error") throw Error("vibration rejected"); return hapticMode !== "blocked"; } : undefined });
      window.__tones = [];
      const createOscillator = AudioContext.prototype.createOscillator;
      AudioContext.prototype.createOscillator = function () {
        const osc = createOscillator.call(this);
        const originalSet = osc.frequency.setValueAtTime.bind(osc.frequency);
        osc.frequency.setValueAtTime = (freq, at) => { window.__tones.push(freq); return originalSet(freq, at); };
        return osc;
      };
    }, { seed: seed.toString(), supported: mode !== 'unsupported', hapticMode: mode });
    context.setDefaultTimeout(15000);
    const page = await context.newPage();
    console.log('START', mode);
    if(mode!=="capture") await page.clock.install();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/play/practice?game=block-puzzle&dev=demo`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.locator('.bp-board.live').waitFor({ timeout: 60000 });
    await page.locator('.fx-countdown').waitFor({ state: 'hidden' });
    await page.addStyleTag({ content: 'nextjs-portal { display:none !important; }' });
    // Test time advances explicitly so a busy host cannot exhaust the actual 90s game mid-replay.
    if(mode!=="capture") await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 5000);
    // Exercise clear effects together with the final-seconds warning, not only at the start.
    if (process.env.LATE === '1') {
      await page.clock.fastForward(76000);
      await page.locator('.bp-board.low').waitFor();
    }
    const cdp = await context.newCDPSession(page);
    const touch = async (type, p) => {
      await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: p ? [p] : [] });
      if(mode==="capture") await page.waitForTimeout(16); else await page.clock.runFor(16);
      if (type === 'touchMove') await page.waitForFunction(({x,y}) => window.__lastPointer && Math.abs(window.__lastPointer.x-x)<.1 && Math.abs(window.__lastPointer.y-y)<.1, p);
    };
    const boardState = () => page.evaluate(() => Array.from(document.querySelectorAll('.bp-board button')).map((c) => c.classList.contains('on') ? '1' : '0').join(''));
    const expected = (occ) => Array.from({length:64}, (_, i) => String(Number((occ >> BigInt(i)) & 1n))).join('');
    const metrics = await page.evaluate(() => {
      const b = document.querySelector('.bp-board'); const s = getComputedStyle(b); const r = b.getBoundingClientRect();
      const inset = parseFloat(s.paddingLeft) + parseFloat(s.borderLeftWidth), gap = parseFloat(s.columnGap);
      const cell = (r.width - inset * 2 - gap * 7) / 8;
      return { left: r.left + inset, top: r.top + inset, cell, pitch: cell + gap, gap };
    });
    async function dragMove(move, check = false) {
      const slot = move.piece % 3;
      const art = await page.locator('.bp-slot').nth(slot).locator('.bp-mini').boundingBox();
      assert.ok(art);
      const [w,h] = dims(pieceAt(seed, move.piece));
      const from = { x: art.x + art.width / 2, y: art.y + art.height / 2 };
      const to = { x: metrics.left + move.x * metrics.pitch + (w * metrics.cell + (w-1)*metrics.gap) / 2,
        y: metrics.top + move.y * metrics.pitch + (h * metrics.cell + (h-1)*metrics.gap) / 2 + 64 };
      await touch('touchStart', from);
      await touch('touchMove', to);
      if (check) {
        await page.waitForFunction(() => document.querySelector('.bp-ghost'));
        // Pickup is allowed to animate; steady held motion must match the board's actual cell width.
        await page.waitForTimeout(110);
        const ghost = await page.locator('.bp-ghost .bp-cell').first().boundingBox();
        assert.ok(Math.abs(ghost.width - metrics.cell) < .25, 'held cell equals board cell');
        const preview = await page.evaluate(() => Array.from(document.querySelectorAll('.bp-board button')).flatMap((el,i) => el.classList.contains('pv') ? [i] : []));
        const wanted = engine.pieceCells(pieceAt(seed, move.piece)).map(c => (move.y+c.dy)*8+move.x+c.dx);
        assert.deepEqual(preview, wanted, 'preview matches the exact committed footprint');
        const before = await page.locator('.bp-ghost').boundingBox();
        await touch('touchMove', {x:to.x + 3,y:to.y + 2});
        const after = await page.locator('.bp-ghost').boundingBox();
        assert.ok(Math.abs(after.x - before.x - 3) < .3 && Math.abs(after.y - before.y - 2) < .3, `held motion follows pointer 1:1: ${JSON.stringify({before,after,to})}`);
        await touch('touchMove', to);
        await page.screenshot({path:join(out, `${mode}-drag.png`)});
      }
      await touch('touchEnd');
      try {
        await page.waitForFunction((want) => Array.from(document.querySelectorAll('.bp-board button')).map(c => c.classList.contains('on')?'1':'0').join('') === want, expected(move.state.occ));
      } catch (error) {
        await page.screenshot({path:join(out,'failure.png')});
        console.error('MOVE FAILED', {piece:move.piece,x:move.x,y:move.y,expected:expected(move.state.occ),actual:await boardState(), text:await page.locator('.bpx').innerText()});
        throw error;
      }
      assert.equal(await boardState(), expected(move.state.occ));
    }

    // Invalid drop and cancellation must leave board/hand unchanged.
    const tray = await page.locator('.bp-slot').first().boundingBox();
    const from = {x:tray.x+tray.width/2,y:tray.y+tray.height/2};
    await touch('touchStart',from); await touch('touchMove',{x:5,y:40}); await touch('touchEnd');
    assert.equal(await boardState(), '0'.repeat(64));
    await page.locator('.bp-return').waitFor({state:'detached'});
    await touch('touchStart',from); await touch('touchMove',{x:180,y:400}); await touch('touchCancel');
    await page.locator('.bp-ghost').waitFor({state:'detached'});
    assert.equal(await boardState(), '0'.repeat(64));
    const count = ['expiry','profile-effects'].includes(mode) ? 7 : ['touch','capture'].includes(mode) ? sequence.length : ['settings','blocked','error'].includes(mode) ? 1 : 12;
    const seen = { lines: 0, doubles: 0, gems: 0, combos: 0 };
    for (let i=0; i<count; i++) {
      const move=sequence[i];
      if (i % 5 === 0) console.log(mode, 'move', i);
      await dragMove(move, i === 0);
      seen.lines += move.result.lines;
      seen.doubles += Number(move.result.lines>=2);
      seen.gems += move.result.gems;
      seen.combos += Number(move.combo>=2);
      if (move.result.lines && ['touch','capture'].includes(mode)) {
        const sweeps = await page.locator('.bp-sweep').evaluateAll(nodes => nodes.map(el => {
          const style = getComputedStyle(el);
          return { background: style.backgroundColor, image: style.backgroundImage, padding: style.padding,
            width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height };
        }));
        // Inspect the readable onset at a fixed animation time, not a screenshot-dependent instant.
        await page.evaluate(() => {
          const bonus = [...document.querySelectorAll('.bp-fly')].at(-1);
          for (const el of [document.querySelector('.bp-moment'), bonus]) for (const animation of el?.getAnimations() ?? []) { animation.pause(); animation.currentTime = 100; }
        });
        await page.screenshot({path:join(out, `sweep-${i}.png`)});
        assert.ok(sweeps.length > 0, 'clear mounts its sweep');
        for (const sweep of sweeps) {
          assert.equal(sweep.background, 'rgba(0, 0, 0, 0)', 'clear sweep must not paint a dark card over the board');
          assert.equal(sweep.image, 'none', 'only the animated light paints, never its container');
          assert.equal(sweep.padding, '0px', 'sweep must not inherit card padding');
          assert.ok(Math.min(sweep.width,sweep.height) <= metrics.cell + 1, 'sweep stays within one cell thickness');
        }
        const label = await page.locator('.bp-moment').boundingBox();
        const bonus = await page.locator('.bp-fly').last().boundingBox();
        assert.ok(label && bonus && (label.y + label.height <= bonus.y || bonus.y + bonus.height <= label.y), 'clear label and bonus must be readable separately');
        const area = await page.locator('.bp-board').boundingBox();
        assert.ok(label.y >= area.y && label.y + label.height <= area.y + area.height, 'reward label stays inside the board');
        await page.evaluate(() => {
          for (const el of [document.querySelector('.bp-moment'), [...document.querySelectorAll('.bp-fly')].at(-1)]) for (const animation of el?.getAnimations() ?? []) animation.play();
        });
        const anim = await page.evaluate(() => ({
          shake:document.querySelector('.bp-board-visual, .bp-board').getAnimations().map(a=>a.effect.getTiming().duration),
          space:getComputedStyle(document.querySelector('.bp-board-space')).transform,
          cells:Array.from(document.querySelectorAll('.bp-board button.on')).every(el=>getComputedStyle(el).opacity==='1'),
        }));
        assert.equal(anim.space,'none','hit-test space never shakes');
        assert.ok(anim.cells,'new occupied cells never inherit a clear fade');
        if (i < 10 || mode==='capture') {
          if (mode==='capture') await page.waitForTimeout(110);
          await page.screenshot({path:join(out,`clear-${i}.png`)});
        }
        if (mode==='capture') {
          await page.waitForTimeout(250);
          await page.screenshot({path:join(out,`bonus-${i}.png`)});
          await page.waitForTimeout(600);
        }
      }
      if(mode==="capture") await page.waitForTimeout(140);
    }
    if(mode==='expiry') {
      assert.ok(sequence[count-1].result.lines>0,'expiry fixture ends immediately after a clear');
      await page.clock.fastForward(90000);
      await page.getByRole('dialog',{name:'Game over',exact:true}).waitFor();
      assert.equal(await page.locator('.bp-fly').count(),0,'expiry removes in-flight bonuses');
      assert.equal(await page.locator('.bp-score-n').isVisible(),false,'live score stays hidden at expiry');
    }
    // Clear bonuses arrive after their nonblocking flight, then the total counts up.
    if(mode==="capture") await page.waitForTimeout(1100); else if(mode!=="profile-effects") await page.clock.runFor(1100);
    if (process.env.LATE === '1' && mode !== 'expiry') await page.locator('.bp-board.live.low').waitFor();
    if(mode!=='profile-effects') await page.waitForFunction((score)=>Number(document.querySelector('.bp-score-n').textContent)===score,sequence[count-1].state.score);
    const feedback = await page.evaluate(()=>({haptics:window.__haptics,tones:window.__tones}));
    if (mode==='unsupported') assert.equal(feedback.haptics.length,0);
    else {
      const nonzero=feedback.haptics.filter(p=>Array.isArray(p));
      assert.equal(nonzero.length,count,'one haptic event per accepted move, none for invalid/cancelled');
    }
    assert.ok(feedback.tones.length>0,'real Web Audio oscillator cues scheduled');
    if(mode==='touch') {
      assert.ok(feedback.haptics.some(p=>JSON.stringify(p)==='[30,35,18]'),'multi-line haptic');
      assert.ok(feedback.haptics.some(p=>JSON.stringify(p)==='[20,30,35]'),'gem haptic');
    }
    if(mode==='settings') {
      await page.getByRole('button',{name:'Game menu',exact:true}).tap();
      assert.equal(await page.getByRole('menuitemcheckbox',{name:'Vibration on',exact:true}).locator('svg.lucide-vibrate').count(),1);
      await page.getByRole('menuitemcheckbox',{name:'Vibration on',exact:true}).tap();
      await page.getByRole('menuitemcheckbox',{name:'Vibration off',exact:true}).waitFor();
      assert.equal(await page.getByRole('menuitemcheckbox',{name:'Vibration off',exact:true}).locator('svg.lucide-vibrate-off').count(),1,'disabled vibration uses the off icon');
      assert.equal(await page.getByRole('menuitem',{name:'Test vibration',exact:true}).count(),0,'no diagnostic action in game menu');
      await page.getByRole('menuitemcheckbox',{name:'Sound on',exact:true}).tap();
      await page.getByRole('button',{name:'Game menu',exact:true}).tap();
      await page.getByRole('button',{name:'Pause',exact:true}).tap();
      await page.getByRole('dialog',{name:'Paused'}).getByRole('button',{name:'Vibration off'}).waitFor();
      await page.getByRole('dialog',{name:'Paused'}).getByRole('button',{name:'Sound off'}).waitFor();
      await page.screenshot({path:join(out,'pause-settings.png')});
      assert.equal(await page.getByRole('dialog',{name:'Paused'}).getByRole('button',{name:'Vibration off',exact:true}).locator('svg.lucide-vibrate-off').count(),1);
      assert.equal(await page.getByRole('button',{name:'Test vibration',exact:true}).count(),0,'no diagnostic action while paused');
      // Reload proves preference persistence; an actual move proves sound and haptics stay off.
      await page.clock.resume();
      await page.reload({waitUntil:'domcontentloaded'});
      await page.locator('.bp-board.live').waitFor();
      await page.locator('.fx-countdown').waitFor({state:'hidden'});
      if(mode!=="capture") await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 5000);
      await dragMove(sequence[0]);
      assert.deepEqual(await page.evaluate(()=>({haptics:window.__haptics,tones:window.__tones})),{haptics:[],tones:[]});
    }
    if(mode==='reduced') {
      const moving=await page.evaluate(()=>document.querySelector('.bp-board-visual, .bp-board').getAnimations().length);
      assert.equal(moving,0,'reduced motion has no board kick');
    }
    if(mode==='unsupported') {
      await page.getByRole('button',{name:'Game menu',exact:true}).tap();
      assert.equal(await page.getByRole('menuitemcheckbox',{name:/Vibration/}).count(),0);
    }
    if (mode === 'profile' || mode === 'profile-effects') {
      await page.clock.resume();
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      // Hold only the game clock constant so countdown commits cannot masquerade as pointer work.
      if(mode==='profile') await page.evaluate(() => { const now = performance.now(); performance.now = () => now; });
      const slot = sequence[count].piece % 3;
      const art = await page.locator('.bp-slot').nth(slot).boundingBox();
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{x:art.x+art.width/2,y:art.y+art.height/2}] });
      await page.waitForTimeout(150);
      await page.evaluate(() => { window.__boardCommits = 0; window.__frameDeltas = []; let last; window.__profiling = true; const tick = t => { if(last) window.__frameDeltas.push(t-last); last=t; if(window.__profiling) requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
      const trace = []; const receive = ({value}) => trace.push(...value);
      cdp.on('Tracing.dataCollected',receive);
      await cdp.send('Tracing.start',{categories:'devtools.timeline,disabled-by-default-devtools.timeline',transferMode:'ReportEvents'});
      const profileStarted = Date.now();
      for (let i=0;i<40;i++) {
        await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:metrics.left+metrics.pitch*(1+i%6),y:metrics.top+metrics.pitch*(2+Math.floor(i/6)%4)+64}]});
        await page.waitForTimeout(40);
      }
      const finished = new Promise(resolve=>cdp.once('Tracing.tracingComplete',resolve));
      await cdp.send('Tracing.end'); await finished; cdp.off('Tracing.dataCollected',receive);
      const measured = await page.evaluate(()=>{window.__profiling=false;return {boardCommits:window.__boardCommits,frames:window.__frameDeltas};});
      const paints = trace.filter(e=>e.name==='Paint'&&e.ph==='X');
      const metric = {elapsedMs:Date.now()-profileStarted,boardCommits:measured.boardCommits, paints:paints.length,paintMs:paints.reduce((n,e)=>n+(e.dur??0)/1000,0),p95FrameMs:measured.frames.sort((a,b)=>a-b)[Math.floor(measured.frames.length*.95)]};
      await writeFile(join(out,'drag-profile.json'),JSON.stringify(metric,null,2));
      await writeFile(join(out,'drag-trace.json'),JSON.stringify({traceEvents:trace}));
      await page.screenshot({path:join(out,'filled-board-drag.png')});
      await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});
      assert.equal(await boardState(),expected(sequence[count-1].state.occ),'profiling drag does not place a piece');
      console.log('DRAG PROFILE',JSON.stringify(metric));
      const budget = mode==='profile-effects' ? Math.ceil(metric.elapsedMs/1000)*3+5 : 8;
      assert.ok(metric.boardCommits<=budget,`drag preview rebuilt the game ${metric.boardCommits} times (budget ${budget})`);
      if(mode==='profile-effects') await page.waitForFunction((score)=>Number(document.querySelector('.bp-score-n').textContent)===score,sequence[count-1].state.score);
    }
    if(mode==='expiry') {
      assert.equal(Number(await page.locator('.bp-final').innerText()),sequence[count-1].state.score,'result uses authoritative score including pending bonus');
      await page.clock.resume();
      await page.getByRole('button',{name:'Play again',exact:true}).tap();
      await page.locator('.bp-board.live').waitFor();
      await page.locator('.fx-countdown').waitFor({state:'hidden'});
      assert.equal(await boardState(),'0'.repeat(64),'replay starts with empty board');
      assert.equal(Number(await page.locator('.bp-score-n').innerText()),0,'old bonus cannot enter the new round');
      assert.equal(await page.locator('.bp-board .pv, .bp-board .hint').count(),0,'replay clears preview classes');
    }
    assert.deepEqual(errors,[],'no runtime errors');
    results.push({ mode, seed:seed.toString(), moves:count, score:sequence[count-1].state.score, ...seen, hapticCalls:feedback.haptics.length, oscillatorTones:feedback.tones.length });
    console.log('PASS',JSON.stringify(results.at(-1)));
    await cdp.detach(); await context.close();
    await writeFile(join(out,'results.json'),JSON.stringify(results,null,2));
  }
} finally { await browser.close(); }
