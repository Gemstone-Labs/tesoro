/**
 * Walks `/welcome` the way a visitor scrolls it and checks what they see at each position.
 * Runs: desktop-dark and desktop-light (1440x900, mouse wheel), phone (390x844, scrollBy) and reduced
 * (1440x900, prefers-reduced-motion). Per run it writes a screenshot per step, steps.json (section,
 * Gemas card opacities, faded reveals, largest empty band per sample), layout.json (section order and
 * heights, pinned spans) and sheet.png; report.json at the top lists every check result. Exits 1 when a
 * check fails.
 *
 *   PW=/path/to/node_modules/playwright-core BASE=http://localhost:3301 node scripts/landing-scroll-check.mjs [run ...]
 *
 * Env: BASE (default http://localhost:3301), PW (playwright-core path or package, default "playwright-core"),
 * OUT (default ~/.cache/tesoro-tmp/landing-scroll-check/<timestamp>), CHROME (browser executable).
 * Needs a dev or production server of the app. Name runs on the command line to run a subset.
 *
 * Add a check: append one entry to CHECKS below. `runs` lists the runs it applies to; `fn(ctx)` calls
 * `ctx.assert(ok, detail)`. ctx has the run's `layout`, `down` (samples scrolling down), `up` (samples
 * scrolling back up through the Gemas pin) and `page`. Informational measurements go in `ctx.note(key, value)`.
 */
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? "playwright-core");
const BASE = process.env.BASE ?? "http://localhost:3301";
const OUT = process.env.OUT ?? join(homedir(), ".cache/tesoro-tmp/landing-scroll-check", new Date().toISOString().replace(/[:.]/g, "-"));
const CHROME = process.env.CHROME ?? join(homedir(), ".cache/ms-playwright/chromium-1228/chrome-linux64/chrome");

const RUNS = {
  "desktop-dark": { w: 1440, h: 900, scheme: "dark" },
  "desktop-light": { w: 1440, h: 900, scheme: "light" },
  phone: { w: 390, h: 844, scheme: "dark", phone: true },
  reduced: { w: 1440, h: 900, scheme: "dark", reduced: true },
};

const FULL = 0.99;
const DESKTOP = ["desktop-dark", "desktop-light"];

const CHECKS = [
  {
    name: "gemas cards full strength after the pin",
    runs: [...DESKTOP, "phone", "reduced"],
    fn({ layout, down, assert }) {
      // Without a pin (phone, reduced motion) "after" means the section has scrolled out of view.
      const from = layout.gemasPin ? layout.gemasPin.end + 5 : layout.gemasBottom;
      const after = down.filter((s) => s.y >= from);
      assert(after.length > 0, "no sample after the Gemas pin");
      const bad = after.filter((s) => s.cards.some((o) => o < FULL));
      assert(bad.length === 0, `cards below full opacity at y=${bad.map((s) => s.y).join(",")}: ${JSON.stringify(bad[0]?.cards)}`);
    },
  },
  {
    name: "gemas pin lights only the active card, again on re-entry",
    runs: DESKTOP,
    fn({ layout, up, assert }) {
      assert(!!layout.gemasPin, "Gemas section is not pinned");
      const inPin = up.filter((s) => s.y > layout.gemasPin.start + 5 && s.y < layout.gemasPin.end - 5);
      assert(inPin.length > 0, "no upward sample inside the Gemas pin");
      const bad = inPin.filter((s) => s.cards.filter((o) => o >= FULL).length !== 1 || s.cards.filter((o) => o < 0.6).length !== 2);
      assert(bad.length === 0, `expected exactly one lit card, got ${JSON.stringify(bad.map((s) => [s.y, s.cards]))}`);
    },
  },
  {
    name: "reduced motion leaves every reveal at full opacity",
    runs: ["reduced"],
    fn({ down, assert }) {
      const bad = down.filter((s) => s.faded.length > 0);
      assert(bad.length === 0, `faded at y=${bad.map((s) => s.y).join(",")}: ${bad[0]?.faded.join(" | ")}`);
    },
  },
  {
    name: "empty band measured",
    runs: [...DESKTOP, "phone", "reduced"],
    fn({ down, note, assert }) {
      const worst = down.reduce((a, s) => (s.gap > a.gap ? s : a), { gap: 0, y: 0 });
      note("largestEmptyBand", { fractionOfViewport: worst.gap, atY: worst.y, section: worst.sec });
      assert(Number.isFinite(worst.gap), "no measurement");
    },
  },
];

/** Runs in the page: layout facts used by the checks. */
function readLayout() {
  const secs = [...document.querySelectorAll("main section, main > footer, footer")].filter((s) => !s.parentElement.closest("section"));
  const spacer = document.querySelector("[data-gemas]")?.closest(".pin-spacer");
  const g = document.querySelector("[data-gemas]");
  let gemasPin = null;
  if (spacer && g) {
    const top = Math.round(spacer.getBoundingClientRect().top + scrollY);
    gemasPin = { start: top, end: top + spacer.offsetHeight - g.offsetHeight, spacerHeight: spacer.offsetHeight };
  }
  const gr = g?.getBoundingClientRect();
  const gemasBottom = g ? Math.round(gr.bottom + scrollY) : null;
  return {
    viewport: [innerWidth, innerHeight],
    total: document.documentElement.scrollHeight,
    sections: secs.map((s) => {
      const r = s.getBoundingClientRect();
      return { id: s.id || s.className.split(" ")[0], top: Math.round(r.top + scrollY), height: Math.round(r.height) };
    }),
    pins: [...document.querySelectorAll(".pin-spacer")].map((p) => ({ top: Math.round(p.getBoundingClientRect().top + scrollY), height: p.offsetHeight })),
    gemasPin,
    gemasBottom,
  };
}

/** Runs in the page: what the visitor sees at the current scroll position. */
function readSample() {
  const vh = innerHeight;
  const mid = vh / 2;
  const sec = [...document.querySelectorAll("main section, footer")].find((s) => {
    const r = s.getBoundingClientRect();
    return r.top <= mid && r.bottom >= mid;
  });
  const cards = [...document.querySelectorAll("[data-gemas] .lp-beat")].map((c) => +(+getComputedStyle(c).opacity).toFixed(2));
  const faded = [...document.querySelectorAll("[data-reveal]")]
    .filter((el) => +getComputedStyle(el).opacity < 0.99)
    .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]}`);
  // Union of visible content boxes along the viewport height; the gap is the tallest stretch with none.
  const spans = [...document.querySelectorAll("main :is(h1,h2,h3,p,li,a,button,img,svg,canvas,video,picture,figure)")]
    .filter((el) => {
      const cs = getComputedStyle(el);
      return +cs.opacity > 0.05 && cs.visibility !== "hidden" && cs.display !== "none";
    })
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 8 && r.height > 8 && r.bottom > 0 && r.top < vh)
    .map((r) => [Math.max(0, r.top), Math.min(vh, r.bottom)])
    .sort((a, b) => a[0] - b[0]);
  let gap = 0;
  let edge = 0;
  for (const [a, b] of spans) {
    gap = Math.max(gap, a - edge);
    edge = Math.max(edge, b);
  }
  gap = Math.max(gap, vh - edge);
  return { sec: sec?.id || sec?.className.split(" ")[0] || null, beat: document.querySelector("[data-gemas]")?.dataset.beat ?? null, cards, faded, gap: +(gap / vh).toFixed(2) };
}

async function scrollStep(page, run, dy) {
  if (run.phone) await page.evaluate((d) => scrollBy(0, d), dy);
  else await page.mouse.wheel(0, dy);
  await page.waitForTimeout(1300);
}

async function walk(browser, name, run) {
  const dir = join(OUT, name);
  mkdirSync(dir, { recursive: true });
  const ctx = await browser.newContext({
    viewport: { width: run.w, height: run.h },
    colorScheme: run.scheme,
    reducedMotion: run.reduced ? "reduce" : "no-preference",
    isMobile: !!run.phone,
    hasTouch: !!run.phone,
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/welcome`, { waitUntil: "networkidle", timeout: 90000 });
  await page.waitForTimeout(2500);
  if (!run.phone && !run.reduced) await page.waitForSelector("[data-gemas]", { state: "attached" }).then(() => page.waitForFunction(() => !!document.querySelector("[data-gemas]")?.closest(".pin-spacer"), null, { timeout: 15000 })).catch(() => {});
  const shots = [];
  const sample = async (dirn, i) => {
    const y = await page.evaluate(() => Math.round(scrollY));
    const s = { dir: dirn, y, ...(await page.evaluate(readSample)) };
    const file = `${dirn}-${String(i).padStart(2, "0")}.png`;
    await page.screenshot({ path: join(dir, file) });
    shots.push({ file, label: `${dirn} ${y} ${s.sec ?? ""}${s.beat !== null ? " b" + s.beat : ""}` });
    return s;
  };

  const step = run.h * 0.5;
  const down = [];
  let stuck = 0;
  for (let i = 0; i < 90; i++) {
    const s = await sample("down", i);
    down.push(s);
    await scrollStep(page, run, step);
    const now = await page.evaluate(() => ({ y: Math.round(scrollY), end: document.documentElement.scrollHeight - innerHeight }));
    stuck = now.y <= s.y + 2 ? stuck + 1 : 0;
    if (now.y >= now.end - 2 || stuck >= 3) break;
  }
  down.push(await sample("down", down.length));

  const layout = await page.evaluate(readLayout);

  // Back up through the Gemas pin: stop sampling once above it.
  const up = [];
  if (layout.gemasPin) {
    for (let i = 0; i < 90; i++) {
      await scrollStep(page, run, -step);
      const s = await sample("up", i);
      up.push(s);
      if (s.y <= layout.gemasPin.start - 5 || s.y <= 2) break;
    }
  }

  writeFileSync(join(dir, "layout.json"), JSON.stringify(layout, null, 2));
  writeFileSync(join(dir, "steps.json"), JSON.stringify({ down, up }, null, 2));
  await contactSheet(browser, dir, shots, run);
  await ctx.close();
  return { layout, down, up, page: null };
}

/** One image of all steps, for a human look. */
async function contactSheet(browser, dir, shots, run) {
  const cols = run.phone ? 10 : 6;
  const w = run.phone ? 160 : 320;
  const cells = shots
    .map((s) => `<figure><img src="data:image/png;base64,${readFileSync(join(dir, s.file)).toString("base64")}" width="${w}"><figcaption>${s.label}</figcaption></figure>`)
    .join("");
  const html = `<body style="margin:0;background:#222;color:#ddd;font:11px monospace"><div style="display:grid;grid-template-columns:repeat(${cols},${w}px);gap:6px;padding:6px">${cells}</div><style>figure{margin:0}img{display:block;border:1px solid #444}</style>`;
  const page = await browser.newPage({ viewport: { width: cols * (w + 6) + 6, height: 400 } });
  await page.setContent(html);
  await page.screenshot({ path: join(dir, "sheet.png"), fullPage: true });
  await page.close();
}

const wanted = process.argv.slice(2);
const names = wanted.length ? wanted : Object.keys(RUNS);
for (const n of names) if (!RUNS[n]) throw new Error(`unknown run ${n}; known: ${Object.keys(RUNS).join(", ")}`);

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: existsSync(CHROME) ? CHROME : "/usr/bin/chromium" });
const report = { base: BASE, out: OUT, runs: {}, failed: 0 };
for (const name of names) {
  const data = await walk(browser, name, RUNS[name]);
  const notes = {};
  const results = [];
  for (const c of CHECKS.filter((c) => c.runs.includes(name))) {
    let ok = true;
    let detail = "";
    c.fn({
      ...data,
      assert: (cond, msg) => {
        if (!cond && ok) {
          ok = false;
          detail = msg;
        }
      },
      note: (k, v) => (notes[k] = v),
    });
    results.push({ check: c.name, ok, detail });
    if (!ok) report.failed++;
  }
  report.runs[name] = {
    total: data.layout.total,
    sections: data.layout.sections,
    pins: data.layout.pins,
    gemasPin: data.layout.gemasPin,
    notes,
    results,
  };
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} [${name}] ${r.check}${r.ok ? "" : ": " + r.detail}`);
}
await browser.close();
writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
console.log(`report: ${join(OUT, "report.json")}`);
process.exit(report.failed ? 1 : 0);
