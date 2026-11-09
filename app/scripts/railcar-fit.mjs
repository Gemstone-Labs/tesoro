/**
 * Railcar fits the screen: the controls a Player needs (Board, Practice free, Step off, Jump, Brake) are on screen with no
 * page scroll at the three viewports the founder uses. Opens Storybook stories (a built Storybook or the dev server).
 *   PW=/path/to/playwright-core BASE=http://localhost:6006 node scripts/railcar-fit.mjs [--shots=dir]
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? "playwright-core");
const BASE = process.env.BASE ?? "http://localhost:6006";
const shots = process.argv.find((a) => a.startsWith("--shots="))?.slice(8);
if (shots) mkdirSync(shots, { recursive: true });

const VIEWPORTS = [
  { name: "390x844", width: 390, height: 844 },
  { name: "1512x725", width: 1512, height: 725 },
  { name: "1440x900", width: 1440, height: 900 },
];
/** Story id -> the buttons that must be visible without scrolling. */
const STORIES = {
  "games-railcar--boarding-not-aboard": ["Board", "Practice free"],
  "games-railcar--boarding-waiting": ["Step off"],
  "games-railcar--riding-brake-ready": ["Jump", "Brake"],
  "games-railcar--practice-riding": ["Jump", "Brake"],
};

const browser = await chromium.launch();
const failures = [];
for (const vp of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
  for (const [id, buttons] of Object.entries(STORIES)) {
    await page.goto(`${BASE}/iframe.html?id=${id}&viewMode=story`, { waitUntil: "domcontentloaded", timeout: 180_000 });
    await page.waitForSelector(".rc", { timeout: 120_000 });
    await page.waitForTimeout(1800);
    const m = await page.evaluate((names) => {
      const full = document.documentElement.classList.contains("game-full");
      // In Full screen the Arena covers the window and scrolls itself. In the shell the page has a footer under the content,
      // so what must fit is the Railcar section itself (and every control in it).
      const arena = full ? document.querySelector(".fx-arena") : null;
      const rcBottom = Math.round(document.querySelector(".rc").getBoundingClientRect().bottom);
      const scroll = arena ? arena.scrollHeight : rcBottom;
      const client = arena ? arena.clientHeight : window.innerHeight;
      const boxes = names.map((n) => {
        const b = [...document.querySelectorAll("button, a")].find((x) => x.textContent.trim().startsWith(n));
        const r = b?.getBoundingClientRect();
        return { n, found: !!b, bottom: r ? Math.round(r.bottom) : null, top: r ? Math.round(r.top) : null };
      });
      return { scroll, client, full, boxes };
    }, buttons);
    const problems = [];
    if (m.scroll > m.client + 1) problems.push(`does not fit (${m.scroll} > ${m.client})`);
    for (const b of m.boxes) if (!b.found) problems.push(`${b.n} missing`);
    else if (b.bottom > vp.height) problems.push(`${b.n} below the fold (bottom ${b.bottom} > ${vp.height})`);
    if (shots) await page.screenshot({ path: join(shots, `${id.replace("games-railcar--", "")}-${vp.name}.png`) });
    console.log(`${problems.length ? "FAIL" : "ok  "} ${vp.name} ${id}${problems.length ? `: ${problems.join("; ")}` : ""}`);
    if (problems.length) failures.push(`${vp.name} ${id}`);
  }
  await page.close();
}
await browser.close();
process.exit(failures.length ? 1 : 0);
