/** Uses the agent-browser wrapper so browser placement and cleanup follow machine policy.
 * BASE=http://localhost:3377 OUT=/path/to/evidence node scripts/check-match-waiting.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const base = process.env.BASE ?? "http://localhost:3377";
const out = resolve(process.env.OUT ?? ".tmp/match-waiting");
mkdirSync(out, { recursive: true });
const session = "tesoro-waiting-fit";
const run = (...args) => execFileSync("agent-browser", ["--session", session, ...args], { encoding: "utf8", timeout: 180000 });
const read = (output) => { const value = JSON.parse(output.trim()); return typeof value === "string" ? JSON.parse(value) : value; };
const results = [];
const failures = [];
const viewports = process.env.VIEWPORTS ? JSON.parse(process.env.VIEWPORTS) : [[1885, 902], [1440, 900], [1280, 720], [1024, 768], [390, 844], [375, 667], [360, 640], [320, 568]];
const games = process.env.GAMES?.split(",") ?? ["block-puzzle", "holdem", "trading-duel", "vanguard"];
try {
  for (const [width, height] of viewports) {
    run("set", "viewport", String(width), String(height));
    for (const game of games) {
      run("open", `${base}/play/match/layout-check?game=${game}`);
      run("wait", ".stage-how");
      run("eval", "document.fonts.ready.then(() => new Promise(r => setTimeout(r, 1600)))");
      const layout = read(run("eval", `JSON.stringify((() => {
        const root = document.documentElement;
        const rect = s => { const r = document.querySelector(s).getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, bottom:r.bottom, right:r.right }; };
        return { scrollHeight:root.scrollHeight, scrollWidth:root.scrollWidth, height:innerHeight, width:innerWidth,
          me:rect('.stage-seat.l .stage-av'), opponent:rect('.stage-seat.r .stage-av'),
          action:rect('.stage-quiet button'), how:rect('.stage-how summary'),
          navTop:document.querySelector('.bottom-nav').getBoundingClientRect().top,
          line:!!document.querySelector('.stage-line'),
          testNote:document.body.innerText.includes('Test mode · Gemas come from simulated yield'),
          mobileArt:getComputedStyle(document.querySelector('.fx-arena-bg'), '::before').backgroundImage,
          art:getComputedStyle(document.querySelector('.fx-arena-bg')).backgroundImage };
      })())`));
      results.push({ width, height, game, ...layout });
      try {
        assert(layout.scrollHeight <= height + 1, `${layout.scrollHeight}px page exceeds ${height}px viewport`);
        assert(layout.scrollWidth <= width, "horizontal overflow");
        assert(!layout.line, "waiting paragraph must be removed");
        assert(!layout.testNote, "test-mode note must be removed");
        assert(Math.abs(layout.me.y - layout.opponent.y) < 1, "avatars must align");
        assert(layout.me.x >= 0 && layout.opponent.right <= width, "both seats must fit");
        assert(layout.how.bottom <= (width < 1024 ? layout.navTop : height), "disclosure obscured by navigation");
        assert(layout.action.height >= 44 && layout.how.height >= 44, "actions need 44px touch targets");
        if (width < 1024) assert(layout.mobileArt.includes("url("), "phone art must use the rotated backdrop");
        console.log(`PASS ${width}x${height}/${game}`);
      } catch (error) {
        failures.push(`${width}x${height}/${game}: ${error.message}`);
        console.log(`FAIL ${failures.at(-1)}`);
      }
      if (game === "block-puzzle") run("screenshot", `${out}/waiting-${width}x${height}.png`);
      writeFileSync(`${out}/layout.json`, JSON.stringify({ results, failures }, null, 2));
    }
  }
  // Expanded help, long challenge links and refund errors must remain reachable through normal scrolling.
  run("set", "viewport", "320", "568");
  run("open", `${base}/play/match/layout-check?challenge=1&error=1`);
  run("wait", ".stage-link");
  run("click", ".stage-how summary");
  const expanded = read(run("eval", "JSON.stringify({open:document.querySelector('.stage-how').open,overflowX:document.documentElement.scrollWidth>innerWidth,overflowY:getComputedStyle(document.documentElement).overflowY,copy:!!document.querySelector('.stage-link button'),error:!!document.querySelector('[role=alert]')})"));
  assert(expanded.open && expanded.copy && expanded.error && !expanded.overflowX && expanded.overflowY !== "hidden", "expanded help, Copy and errors remain accessible");
  console.log("PASS expanded help, challenge link and refund error at 320x568");
  writeFileSync(`${out}/layout.json`, JSON.stringify({ results, failures, expanded }, null, 2));
  assert.equal(failures.length, 0, failures.join("\n"));
} finally {
  run("close");
}
