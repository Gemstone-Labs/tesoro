/**
 * Opens every Storybook story and fails on page errors, console errors or requests that leave the machine.
 *   PW=/path/to/playwright-core BASE=http://localhost:6006 node scripts/storybook-smoke.mjs [filter] [--shots=dir]
 * BASE can be the dev server, `npx http-server storybook-static` or the deployed Storybook. `filter` keeps story ids containing it.
 * With --shots, saves <dir>/<story-id>-<1440|390>.png.
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? "playwright-core");
const BASE = process.env.BASE ?? "http://localhost:6006";
const args = process.argv.slice(2);
const filter = args.find((a) => !a.startsWith("--"));
const shots = args.find((a) => a.startsWith("--shots="))?.slice(8);
const widths = shots ? [1440, 390] : [1440];
if (shots) mkdirSync(shots, { recursive: true });

// Expected noise: blocked network in stories (by design) and React dev warnings about keys are not failures.
// Google Fonts is the one remote origin allowed: next/font serves the three faces from it in Storybook dev.
const ALLOWED_HOSTS = ["localhost", "127.0.0.1", "fonts.gstatic.com", "fonts.googleapis.com", new URL(BASE).hostname];
const IGNORE = [/Offline in Storybook/, /\[chain\]/, /Download the React DevTools/, /THREE\.WebGLRenderer/, /WebGL/];

const index = await (await fetch(`${BASE}/index.json`)).json();
const stories = Object.values(index.entries).filter((e) => e.type === "story" && (!filter || e.id.includes(filter)));
const browser = await chromium.launch();
const failures = [];
for (const width of widths) {
  const page = await browser.newPage({ viewport: { width, height: width > 500 ? 900 : 844 } });
  let current = null;
  page.on("pageerror", (e) => current?.errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !IGNORE.some((r) => r.test(m.text()))) current?.errors.push(`console: ${m.text().slice(0, 300)}`);
  });
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.protocol.startsWith("http") && !ALLOWED_HOSTS.includes(u.hostname)) current?.errors.push(`network: ${u.origin}${u.pathname}`);
  });
  for (const s of stories) {
    current = { id: s.id, errors: [] };
    if (process.env.DEBUG) console.log("open", s.id, width);
    await page.goto(`${BASE}/iframe.html?id=${s.id}&viewMode=story`, { waitUntil: "domcontentloaded", timeout: 180_000 });
    await page.waitForSelector("#storybook-root > *, .sb-show-errordisplay", { state: "attached", timeout: 120_000 }).catch(() => current.errors.push("timeout: nothing rendered"));
    await page.waitForTimeout(600);
    if (await page.$(".sb-show-errordisplay")) current.errors.push(`render: ${(await page.textContent("#error-message"))?.slice(0, 300)}`);
    if (shots) await page.screenshot({ path: join(shots, `${s.id}-${width}.png`), fullPage: true });
    if (current.errors.length) failures.push(current);
    process.stdout.write(current.errors.length ? "F" : ".");
  }
  await page.close();
}
await browser.close();
console.log(`\n${stories.length} stories × ${widths.length} widths, ${failures.length} failing`);
for (const f of failures) console.log(`\n${f.id}\n  ${[...new Set(f.errors)].join("\n  ")}`);
process.exit(failures.length ? 1 : 0);
