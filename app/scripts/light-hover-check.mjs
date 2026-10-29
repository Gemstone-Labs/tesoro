// Walks the main pages and hovers every button, link, tab and chip. Fails when a control with a light
// fill turns dark on hover, or when its hovered text falls below 4.5:1 against its hovered fill.
// Run against a dev server that reads devnet (needs NEXT_PUBLIC_DEV_WALLET=1):
//   BASE=http://localhost:3000 [OUT=dir] [CHROME=/path/to/chrome] node scripts/light-hover-check.mjs
// Exit code 1 and a table of offenders on failure. Full JSON goes to $OUT/light-hover.json.
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? "playwright-core");
const base = process.env.BASE ?? "http://localhost:3000";
const out = process.env.OUT ?? join(homedir(), ".cache/tesoro-tmp/light-hover");
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? join(homedir(), ".cache/ms-playwright/chromium-1228/chrome-linux64/chrome"),
  args: ["--no-sandbox"],
});

const SELECTOR = [
  "button", "a[href]", "[role=tab]", "[role=button]", "[role=radio]", "[role=switch]", "summary", "label:has(input)", ".chip", "[aria-current]", "[aria-pressed]",
].join(",");

// Runs in the page. Returns the effective fill (first opaque colour behind the element, gradients use their first stop) and text colour.
function measure(el) {
  const parse = (s) => {
    const m = s && s.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 };
  };
  // Bottom-most background layer decides the fill; a tiny icon layer (chevron) is not a fill.
  const firstGradientColour = (img, size) => {
    if (!img || img === "none") return null;
    if (size && size !== "auto" && size !== "cover" && size !== "100% 100%" && size !== "auto, auto") return null;
    const layers = [];
    let depth = 0, start = 0;
    for (let i = 0; i < img.length; i++) {
      if (img[i] === "(") depth++;
      else if (img[i] === ")") depth--;
      else if (img[i] === "," && depth === 0) { layers.push(img.slice(start, i)); start = i + 1; }
    }
    layers.push(img.slice(start));
    const m = layers[layers.length - 1].match(/rgba?\([^)]+\)/);
    return m ? parse(m[0]) : null;
  };
  const over = (top, bottom) => {
    const a = top.a + bottom.a * (1 - top.a);
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    const c = (k) => (top[k] * top.a + bottom[k] * bottom.a * (1 - top.a)) / a;
    return { r: c("r"), g: c("g"), b: c("b"), a };
  };
  const layers = [];
  for (let n = el; n; n = n.parentElement) {
    const cs = getComputedStyle(n);
    const bg = parse(cs.backgroundColor);
    const grad = firstGradientColour(cs.backgroundImage, cs.backgroundSize);
    if (grad && grad.a > 0.05) layers.push(grad);
    if (bg && bg.a > 0) layers.push(bg);
    if (bg && bg.a >= 0.99) break;
    if (grad && grad.a >= 0.99) break;
  }
  let fill = { r: 11, g: 15, b: 18, a: 1 };
  for (const l of layers.reverse()) fill = over(l, fill);
  // The control's own fill (not its ancestors') decides "light button".
  const cs = getComputedStyle(el);
  const own = over(firstGradientColour(cs.backgroundImage, cs.backgroundSize) ?? { r: 0, g: 0, b: 0, a: 0 }, parse(cs.backgroundColor) ?? { r: 0, g: 0, b: 0, a: 0 });
  const filter = cs.filter !== "none" ? cs.filter : "";
  const text = parse(cs.color);
  return { fill, own, text: over(text, fill), filter, opacity: Number(cs.opacity) };
}

const lum = ({ r, g, b }) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
// A `brightness()` filter on hover shifts the whole control; apply it to both colours so the ratio is honest.
const applyFilter = (c, filter) => {
  const m = filter.match(/brightness\(([\d.]+)\)/);
  if (!m) return c;
  const k = Number(m[1]);
  return { r: Math.min(255, c.r * k), g: Math.min(255, c.g * k), b: Math.min(255, c.b * k), a: 1 };
};

const rows = [];
async function scan(page, label, viewport) {
  const handles = await page.$$(SELECTOR);
  const seen = new Set();
  for (const h of handles) {
    const info = await h.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width < 8 || r.height < 8 || cs.visibility === "hidden" || cs.display === "none" || cs.pointerEvents === "none") return null;
      if (el.matches(":disabled, [aria-disabled=true]")) return null;
      const path = [];
      for (let n = el; n && path.length < 4; n = n.parentElement) path.push(n.tagName.toLowerCase() + (typeof n.className === "string" && n.className.trim() ? "." + n.className.trim().split(/\s+/).slice(0, 3).join(".") : ""));
      return { key: path.join(" < "), text: (el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 24), x: r.x, y: r.y, w: r.width, h: r.height };
    }).catch(() => null);
    if (!info) continue;
    const key = `${info.key}|${info.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await h.evaluate((el) => el.scrollIntoView({ block: "center" })).catch(() => {});
    await page.mouse.move(1, 1);
    await page.waitForTimeout(40);
    const rest = await h.evaluate(measure, undefined).catch(() => null);
    const box = await h.boundingBox();
    if (!rest || !box) continue;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(260);
    const hov = await h.evaluate(measure, undefined).catch(() => null);
    if (!hov) continue;
    const restLight = lum(rest.own) > 0.5 && rest.own.a > 0.5;
    const hovFill = applyFilter(hov.own.a > 0.5 ? hov.own : hov.fill, hov.filter);
    const hovText = applyFilter(hov.text, hov.filter);
    const contrast = ratio(hovFill, hovText);
    const flipsDark = restLight && lum(hovFill) < 0.25;
    const lightHover = lum(hovFill) > 0.5;
    const bad = flipsDark || ((restLight || lightHover) && contrast < 4.5);
    rows.push({ page: label, viewport, control: info.key, text: info.text, restFill: rest.own, hovFill: hov.own, contrast: Number(contrast.toFixed(2)), restLight, flipsDark, bad });
  }
}

try {
  const ctx = await browser.newContext();
  const seed = await ctx.newPage();
  await seed.goto(`${base}/play?dev=demo`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await seed.waitForSelector('a[href^="/account/"]', { timeout: 120000 });
  const account = await seed.locator('a[href^="/account/"]').first().getAttribute("href");
  await seed.close();
  const views = process.env.VIEWPORTS ? JSON.parse(process.env.VIEWPORTS) : [{ width: 1440, height: 900 }];
  const pages = [
    ["play", "/play"], ["matches", "/matches"], ["friends", "/friends"], ["leaderboard", "/leaderboard"], ["leaderboard-p2", "/leaderboard?page=2"],
    ["vault", "/vault"], ["backing", "/backing"], ["account", account], ["help", "/help"], ["docs", "/docs"],
    ["game-block-puzzle", "/play/block-puzzle"], ["game-holdem", "/play/holdem"],
  ];
  for (const viewport of views) {
    const vp = `${viewport.width}x${viewport.height}`;
    for (const [label, path] of pages) {
      const page = await ctx.newPage();
      await page.setViewportSize(viewport);
      await page.goto(`${base}${path}${path.includes("?") ? "&" : "?"}dev=demo`, { waitUntil: "domcontentloaded", timeout: 120000 });
      await page.waitForTimeout(Number(process.env.SETTLE ?? 9000));
      await scan(page, label, vp);
      if (label === "vault") {
        for (const view of ["Pro", "Simple"]) {
          const t = page.getByRole("button", { name: new RegExp(`^${view}$`) }).first();
          if (await t.count()) { await t.click().catch(() => {}); await page.waitForTimeout(800); await scan(page, `vault-${view.toLowerCase()}`, vp); }
        }
        const buy = page.getByRole("button", { name: /buy|add gemas|get gemas/i }).first();
        if (await buy.count()) {
          await buy.click().catch(() => {});
          await page.waitForTimeout(1200);
          await scan(page, "buy-gemas-sheet", vp);
          const pro = page.getByRole("button", { name: /^pro$/i }).first();
          if (await pro.count()) { await pro.click().catch(() => {}); await page.waitForTimeout(800); await scan(page, "buy-gemas-sheet-pro", vp); }
        }
      }
      await page.close();
    }
  }
} finally {
  await browser.close();
}

await writeFile(join(out, "light-hover.json"), JSON.stringify(rows, null, 1));
const bad = rows.filter((r) => r.bad);
const fmt = (c) => `rgb(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)})`;
console.log(`${rows.length} controls hovered, ${rows.filter((r) => r.restLight).length} with a light fill, ${bad.length} failing`);
for (const r of bad) console.log(`FAIL [${r.page} ${r.viewport}] "${r.text}" ${r.control}\n     rest ${fmt(r.restFill)} -> hover ${fmt(r.hovFill)} contrast ${r.contrast}`);
process.exit(bad.length ? 1 : 0);
