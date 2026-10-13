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
 * scrolling back up through the Gemas pin), `how` (dense samples every 160px from just above to just below the
 * How it works pin; the pin's own span when there is none) and `page`. Informational measurements go in `ctx.note(key, value)`.
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
    name: "gemas pin is about 120% of the viewport",
    runs: DESKTOP,
    fn({ layout, note, assert }) {
      assert(!!layout.gemasPin, "Gemas section is not pinned");
      const span = layout.gemasPin.end - layout.gemasPin.start;
      note("gemasPinSpan", { px: span, viewports: +(span / layout.viewport[1]).toFixed(2) });
      assert(Math.abs(span / layout.viewport[1] - 1.2) <= 0.1, `gemas pin ${span}px is ${(span / layout.viewport[1]).toFixed(2)} viewports`);
    },
  },
  {
    name: "gemas outline sweep advances with scroll inside the pin",
    runs: DESKTOP,
    fn({ layout, down, up, assert }) {
      const p = layout.gemasPin;
      assert(!!p, "Gemas section is not pinned");
      const inPin = [...down, ...up].filter((s) => s.y >= p.start - 2 && s.y <= p.end + 2 && s.sweep !== null).sort((a, b) => a.y - b.y);
      assert(inPin.length >= 3, `only ${inPin.length} samples inside the pin`);
      for (let i = 1; i < inPin.length; i++) {
        if (inPin[i].y - inPin[i - 1].y < 20) continue;
        assert(inPin[i].sweep < inPin[i - 1].sweep - 0.5, `sweep did not advance between y=${inPin[i - 1].y} (${inPin[i - 1].sweep}) and y=${inPin[i].y} (${inPin[i].sweep})`);
      }
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
    name: "how it works holds longer than gemas",
    runs: DESKTOP,
    fn({ layout, assert }) {
      assert(!!layout.howPin, "How it works is not pinned");
      const how = layout.howPin.end - layout.howPin.start;
      const gemas = layout.gemasPin ? layout.gemasPin.end - layout.gemasPin.start : 0;
      assert(how > gemas, `how pin ${how}px vs gemas pin ${gemas}px`);
    },
  },
  {
    name: "how it works lights its stops in order across the pin, closing line last",
    runs: DESKTOP,
    fn({ layout, how, assert }) {
      const p = layout.howPin;
      assert(!!p, "How it works is not pinned");
      const inPin = how.filter((s) => s.y >= p.start - 2 && s.y <= p.end + 2);
      assert(inPin.length >= 5, `only ${inPin.length} samples inside the pin`);
      const first = inPin[0].how.stops;
      assert(first[0] >= FULL, `Position not lit at the start: ${first[0]}`);
      assert(first.slice(1).every((o) => o < 0.5), `later stops already lit at the start: ${JSON.stringify(first)}`);
      // advance, play, settle, win, closing line
      const order = [1, 2, 4, 5, 7];
      for (let i = 0; i < inPin.length; i++) {
        const st = inPin[i].how.stops;
        assert(st[0] >= FULL, `Position dimmed at y=${inPin[i].y}`);
        if (i) for (let k = 1; k < st.length; k++) assert(st[k] >= inPin[i - 1].how.stops[k] - 0.01, `stop ${k} dims going down at y=${inPin[i].y}`);
        for (let k = 1; k < order.length; k++) assert(st[order[k]] <= st[order[k - 1]] + 0.01, `stop ${order[k]} lit before ${order[k - 1]} at y=${inPin[i].y}: ${JSON.stringify(st)}`);
      }
      const last = how.find((s) => s.y >= p.end - 2) ?? inPin[inPin.length - 1];
      assert(last.how.stops.every((o) => o >= FULL), `not everything lit at the end of the pin: ${JSON.stringify(last.how.stops)}`);
      assert(last.how.foot, "closing line not fully on screen at the end of the pin");
      const mid = inPin.filter((s) => s.how.stops.some((o, k) => k && o > 0.3 && o < 0.99)).length;
      assert(mid >= 2, "stops never seen part way (not scroll-tied)");
    },
  },
  {
    name: "how it works shows the complete diagram without the pin",
    runs: ["phone", "reduced"],
    fn({ how, assert }) {
      assert(how.length > 0, "no samples");
      const bad = how.filter((s) => s.how.stops.some((o) => o !== null && o < FULL));
      assert(bad.length === 0, `dimmed stops at y=${bad.map((s) => s.y).join(",")}: ${JSON.stringify(bad[0]?.how.stops)}`);
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
  const hs = document.querySelector("[data-how]")?.closest(".pin-spacer");
  const hw = document.querySelector("[data-how]");
  let howPin = null;
  if (hs && hw) {
    const top = Math.round(hs.getBoundingClientRect().top + scrollY);
    howPin = { start: top, end: top + hs.offsetHeight - hw.offsetHeight, spacerHeight: hs.offsetHeight };
  }
  const howRect = hw?.getBoundingClientRect();
  return {
    howPin,
    howTop: hw ? Math.round(howRect.top + scrollY) : null,
    howBottom: hw ? Math.round(howRect.bottom + scrollY) : null,
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
  const sw = document.querySelector("[data-gemas] .lp-vitrine .sweep");
  const sweep = sw ? +parseFloat(getComputedStyle(sw).strokeDashoffset).toFixed(2) : null;
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
  const op = (q) => {
    const el = document.querySelector(q);
    return el ? +(+getComputedStyle(el).opacity).toFixed(2) : null;
  };
  const how = {
    stops: [".lp-oct-node.n-position", ".lp-oct-node.n-advance", ".lp-oct-node.n-play", ".lp-oct-node.n-back", ".lp-oct-node.settle.n-settle", ".lp-outcome-card.win", ".lp-outcome-card.lose", ".lp-flow-foot .lp-hold"].map(op),
    tube0: document.querySelector("[data-how]") ? getComputedStyle(document.querySelector("[data-how]")).getPropertyValue("--h-tube0").trim() : "",
    foot: (() => {
      const r = document.querySelector(".lp-flow-foot")?.getBoundingClientRect();
      return r ? r.top >= 0 && r.bottom <= vh : false;
    })(),
  };
  return { how, sec: sec?.id || sec?.className.split(" ")[0] || null, beat: document.querySelector("[data-gemas]")?.dataset.beat ?? null, cards, sweep, faded, gap: +(gap / vh).toFixed(2) };
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
    await settle(page);
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

  // Dense walk through the How it works pin (or its section when it is not pinned).
  const howSamples = [];
  const hp = layout.howPin ?? (layout.howTop !== null ? { start: layout.howTop, end: layout.howBottom - run.h } : null);
  if (hp) {
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForTimeout(2000);
    for (let y = Math.max(0, hp.start - 100); y <= hp.end + 420; y += 160) {
      await page.evaluate((v) => scrollTo(0, v), y);
      await page.waitForTimeout(700);
      await settle(page);
      const s = { dir: "how", y: await page.evaluate(() => Math.round(scrollY)), ...(await page.evaluate(readSample)) };
      const file = `how-${String(howSamples.length).padStart(2, "0")}.png`;
      await page.screenshot({ path: join(dir, file) });
      shots.push({ file, label: `how ${s.y}` });
      howSamples.push(s);
    }
  }

  writeFileSync(join(dir, "layout.json"), JSON.stringify(layout, null, 2));
  writeFileSync(join(dir, "steps.json"), JSON.stringify({ down, up, how: howSamples }, null, 2));
  await contactSheet(browser, dir, shots, run);
  await ctx.close();
  return { layout, down, up, how: howSamples, page: null };
}

/** Waits for the Gemas cards' opacity transitions to finish so a sample never reads a mid-fade value. */
async function settle(page) {
  await page
    .waitForFunction(() => !document.getAnimations().some((a) => a instanceof CSSTransition && a.effect?.target?.closest?.("[data-gemas]")), null, { timeout: 3000 })
    .catch(() => {});
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
    howPin: data.layout.howPin,
    notes,
    results,
  };
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} [${name}] ${r.check}${r.ok ? "" : ": " + r.detail}`);
}
await browser.close();
writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
console.log(`report: ${join(OUT, "report.json")}`);
process.exit(report.failed ? 1 : 0);
