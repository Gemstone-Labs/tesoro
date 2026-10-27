/** Sample real CSS animation timelines through agent-browser (which chooses the browser host).
 * BASE=http://localhost:3377 OUT=/path/to/evidence node scripts/check-match-rail-motion.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const base = process.env.BASE ?? "http://localhost:3377";
const out = resolve(process.env.OUT ?? ".tmp/match-rail-motion");
mkdirSync(out, { recursive: true });
const run = (...args) => execFileSync("agent-browser", ["--session", "tesoro-rail-motion", ...args], { encoding: "utf8", timeout: 180000 });
const read = (output) => { const value = JSON.parse(output.trim()); return typeof value === "string" ? JSON.parse(value) : value; };
const results = [];
try {
  run("open", `${base}/play/match/layout-check?motion=1`);
  run("wait", "[data-rail-preview] .stage-rail.out");
  for (const width of [320, 390, 768, 1024, 1440]) {
    run("set", "viewport", String(width), "844");
    const samples = read(run("eval", `(() => {
      document.querySelectorAll('.stage').forEach(stage => stage.getAnimations({subtree:true}).forEach(a => { a.pause(); a.currentTime = 10000; }));
      const rails = [...document.querySelectorAll('[data-rail-case] .stage-rail')];
      const records = rails.map(rail => ({case:rail.closest('[data-rail-case]').dataset.railCase,
        side:rail.classList.contains('l') ? 'l' : 'r', maxVisible:0, positions:new Set(),
        tokens:[...rail.querySelectorAll(':scope > i')].map(node => ({node, animations:node.getAnimations()}))}));
      for (let t = 0; t <= 8400; t += 25) {
        records.forEach(r => r.tokens.forEach(({animations}) => animations.forEach(a => {a.currentTime=t;})));
        for (const record of records) {
          let count=0;
          for (const {node} of record.tokens) {
            const css=getComputedStyle(node);
            if (css.display !== 'none' && Number(css.opacity) > .01) {
              count++;
              record.positions.add(Math.round(node.getBoundingClientRect().x * 10));
            }
          }
          record.maxVisible=Math.max(record.maxVisible,count);
        }
      }
      return records.map(({case:kind,side,maxVisible,positions}) => ({case:kind,side,maxVisible,positions:positions.size}));
    })()`));
    assert.equal(samples.length, 16, "all four Games, both flows and both rails must be rendered");
    for (const row of samples) {
      assert.equal(row.maxVisible, width < 1024 ? 1 : row.case.endsWith('/waiting') ? 3 : 4, `${width}/${row.case}/${row.side}: unexpected simultaneous tokens (${row.maxVisible})`);
      assert(row.positions > 4, `${width}/${row.case}/${row.side}: the token must still travel`);
    }
    results.push({ width, samples });
    writeFileSync(`${out}/motion.json`, JSON.stringify(results, null, 2));
    console.log(`PASS ${width}px: ${samples.length} rails; ${width < 1024 ? 'one moving item at a time' : 'desktop stream retained'}`);
  }
  run("set", "media", "dark", "reduced-motion");
  run("set", "viewport", "390", "844");
  const reduced = read(run("eval", `({hidden:[...document.querySelectorAll('.stage-rail > i')].every(n => getComputedStyle(n).display === 'none'), active:document.getAnimations().filter(a => a.effect?.target?.matches('.stage-rail, .stage-rail *')).length})`));
  assert(reduced.hidden && reduced.active === 0, "reduced motion must suppress rail movement");
  console.log("PASS reduced motion: rail items hidden and no active rail animations");
} finally {
  run("close");
}
