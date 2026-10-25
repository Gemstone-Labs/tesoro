/** PW=/path/to/playwright-core OUT=/path/to/evidence node scripts/check-friend-share.mjs
 * Runs the real Friends page with account data, identity and Next navigation stubbed.
 * Browser sharing/clipboard are simulated; this does not send messages or test an OS share sheet.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = resolve(process.env.OUT ?? `${root}/.tmp/friend-share`);
const harness = resolve(out, "harness");
await mkdir(harness, { recursive: true });
const stub = resolve(harness, "stubs.tsx");
await writeFile(stub, `
export function usePlayerLabel() { return "Taylor"; }
export function PlayerName() { return <>Taylor</>; }
export function PlayerAvatar({size}) { return <span style={{display:'grid',placeItems:'center',width:size,height:size,background:'#173e35',fontSize:size/2}}>T</span>; }
export function VerifiedMark() { return null; }
export function AddFriendButton() { return <button className="cut cut-btn btn neutral">Add friend</button>; }
export function Image({fill,priority,sizes,src,...props}) { return <img {...props} src={typeof src === 'string' ? src : src.src} style={fill ? {position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'cover'} : undefined}/>; }
const friends = {
  status: 'ready', me: 'my-account',
  view: { friends: [], incoming: [], challenges: [] },
  act: async (op) => {
    if (op === 'link' && new URLSearchParams(location.search).has('loading')) await new Promise(() => {});
    return { code: op === 'reset-link' ? 'new-add-me-code' : 'add-me-code' };
  },
};
export function useFriends() { return friends; }
export function useAccount() { return { auth: {status:'signed-in'}, snapshot:null }; }
export function usePlayerAccount() { return { data:null }; }
export function ChallengeSheet() { return null; }
export function Link({href,children,...props}) { return <a href={href} {...props}>{children}</a>; }
`);
await writeFile(resolve(harness, "entry.tsx"), `
import { createRoot } from 'react-dom/client';
import { AccountHero } from '${resolve(root, "src/components/account/AccountHero.tsx")}';
import { FriendsPage } from '${resolve(root, "src/components/friends/FriendsPage.tsx")}';
import '${resolve(root, "src/app/globals.css")}';
import '${resolve(root, "src/components/ui/ui.css")}';
import '${resolve(root, "src/components/account/account.css")}';
const profile = new URLSearchParams(location.search).has('profile');
const now = Date.now();
createRoot(document.getElementById('root')).render(<main className="pa">{profile ? <AccountHero
  address="9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" own={true} visitor={false}
  s={{latest:now-60000,first:now-86400000*30,record:{wins:7,matches:10},byGame:[]}}
  now={now} otherNames={[]} asking={0} onChallenge={() => {}}
/> : <FriendsPage />}</main>);
`);
const aliases = [
  ["@/components/account/Player", stub],
  ["@/lib/account", stub],
  ["@/lib/friends/FriendsProvider", stub],
  ["@/lib/chain/usePlayerAccount", stub],
  ["@/components/match/ChallengeSheet", stub],
  ["@/components/friends/AddFriendButton", stub],
  ["next/image", resolve(harness, "image.ts")],
  ["next/link", resolve(harness, "link.ts")],
  ["@", resolve(root, "src")],
].map(([find, replacement]) => ({ find, replacement }));
await writeFile(resolve(harness, "image.ts"), `export { Image as default } from './stubs';`);
await writeFile(resolve(harness, "link.ts"), `export { Link as default } from './stubs';`);
const dist = resolve(harness, "dist");
await build({
  configFile: false,
  root,
  publicDir: false,
  logLevel: "warn",
  plugins: [{
    name: "browser-only-fixture",
    enforce: "pre",
    // Every fixture module runs in the browser; there is no React Server Component boundary.
    transform(code, id) {
      if (/\.[cm]?[jt]sx?$/.test(id)) return code.replace(/^["']use client["'];?\s*$/gm, "");
    },
  }],
  define: {
    "process.env.NODE_ENV": '"production"',
    "process.env": JSON.stringify({ NODE_ENV: "production", NEXT_PUBLIC_TESORO_CLUSTER: "test" }),
  },
  resolve: { alias: aliases, dedupe: ["react", "react-dom"] },
  oxc: { jsxInject: `import React from 'react'` },
  build: {
    outDir: dist,
    emptyOutDir: true,
    minify: false,
    reportCompressedSize: false,
    lib: { entry: resolve(harness, "entry.tsx"), name: "FriendShareCheck", formats: ["iife"], fileName: () => "bundle.js" },
  },
});
const files = await readdir(dist);
const js = await readFile(resolve(dist, "bundle.js"));
const css = await readFile(resolve(dist, files.find((name) => name.endsWith(".css"))));
const origin = "https://friends.test";
const expected = `${origin}/friend/add-me-code`;
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"><style>:root{--font-schibsted:Arial;--font-display:Arial;--font-plex-mono:monospace}body{padding:20px}.pa{margin:0 auto}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`;
const { chromium } = await import(process.env.PW ?? "playwright-core");
const browser = await chromium.launch({ headless: true });
const checks = [];
const errors = [];
try {
  const context = await browser.newContext({ hasTouch: true, reducedMotion: "reduce" });
  await context.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/bundle.js") return route.fulfill({ contentType: "application/javascript", body: js });
    if (path === "/style.css") return route.fulfill({ contentType: "text/css", body: css });
    if (path.startsWith("/art/")) {
      try { return await route.fulfill({ contentType: "image/webp", body: await readFile(resolve(root, `public${path}`)) }); }
      catch { return route.abort(); }
    }
    return route.fulfill({ contentType: "text/html", body: html });
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error(`Browser error: ${error.message}`);
  });
  for (const width of [320, 360, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${origin}/friends?dev=demo`, { waitUntil: "load" });
    assert.deepEqual(errors, [], "fixture boots without page errors");
    const share = page.getByRole("button", { name: "Share", exact: true });
    await share.waitFor({state:'visible'});
    await page.waitForFunction(() => !document.querySelector('.fr-link-actions button')?.disabled);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `overflow at ${width}`);
    const group = page.getByRole("group", { name: "Add-me link actions" });
    assert.equal(await group.getByRole('button').count(), 2);
    const boxes = [];
    for (const button of await group.getByRole('button').all()) {
      const box = await button.boundingBox();
      assert(box && box.x >= 0 && box.x + box.width <= width + 1, `button fits at ${width}`);
      assert(box.height >= (width < 640 ? 44 : 34), "existing Button small size: 44px on phones, 34px on desktop");
      boxes.push(box);
    }
    assert.equal(boxes[0].y, boxes[1].y, 'Copy and Share sit beside each other');
    await page.screenshot({ path: resolve(out, `friends-${width}.png`), fullPage: true });
    checks.push(`Friends layout ${width}: Share beside Copy`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/friends?dev=demo`);
  const share = page.getByRole("button", { name: "Share", exact: true });
  const copy = page.getByRole("group", {name:"Add-me link actions"}).getByRole("button").first();
  await page.waitForFunction(() => !document.querySelector('.fr-link-actions button')?.disabled);
  await page.evaluate(() => {
    window.actions = { shares: [], copies: [] };
    window.mode = "success";
    Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
    Object.defineProperty(navigator, "share", { configurable: true, value: async (data) => {
      window.actions.shares.push(data);
      if (window.mode === "cancel") throw new DOMException("Cancelled", "AbortError");
      if (window.mode === "busy") await new Promise((resolve) => { window.releaseShare = resolve; });
    } });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text) => {
      if (window.mode === "denied") throw new DOMException("Denied", "NotAllowedError");
      window.actions.copies.push(text);
    } } });
  });
  await share.tap();
  await page.getByRole("status").filter({ hasText: "Share menu opened" }).waitFor();
  assert.equal(await page.evaluate(() => window.actions.shares[0].url), expected);
  assert.equal(await page.evaluate(() => window.actions.copies.length), 0);
  checks.push("native payload and clean URL");
  await copy.tap();
  await page.getByRole("status").filter({ hasText: "Add-me link copied" }).waitFor();
  assert.equal(await page.evaluate(() => window.actions.copies[0]), expected);
  checks.push("explicit copy");
  await page.evaluate(() => { window.mode = "cancel"; });
  await share.tap();
  assert.equal(await page.evaluate(() => window.actions.copies.length), 1);
  assert.equal(await page.getByRole("textbox", { name: "Add-me link" }).count(), 0);
  checks.push("cancellation has no copy side effect");
  await page.evaluate(() => { Object.defineProperty(navigator, "share", { configurable: true, value: undefined }); });
  await share.tap();
  await page.getByRole("status").filter({ hasText: "Add-me link copied" }).waitFor();
  assert.equal(await page.evaluate(() => window.actions.copies.length), 2);
  checks.push("unsupported native share copies");
  await page.evaluate(() => { window.mode = "denied"; });
  await share.tap();
  const field = page.getByRole("textbox", { name: "Add-me link" });
  await field.waitFor();
  assert.equal(await field.inputValue(), expected);
  await field.focus();
  assert.equal(await field.evaluate((input) => input.selectionEnd - input.selectionStart), expected.length);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: resolve(out, "friends-manual-fallback-390.png"), fullPage: true });
  checks.push("denied clipboard gives selectable URL");
  await page.getByRole('button', {name:'Reset link', exact:true}).click();
  await page.getByRole('dialog').getByRole('button', {name:'Reset link', exact:true}).click();
  await page.waitForFunction(() => document.querySelector('.fr-link-url')?.textContent?.includes('new-add-me-code'));
  assert.equal(await field.count(), 0, 'reset clears the old manual URL');
  await page.evaluate(() => { window.mode = 'success'; });
  await copy.tap();
  await page.getByRole('status').filter({hasText:'Add-me link copied'}).waitFor();
  assert.equal(await page.evaluate(() => window.actions.copies.at(-1)), `${origin}/friend/new-add-me-code`);
  checks.push('Reset replaces the shared link and clears stale feedback');
  await page.goto(`${origin}/friends?loading=1`);
  const loadingActions = page.getByRole('group', {name:'Add-me link actions'}).getByRole('button');
  assert.equal(await loadingActions.count(), 2);
  assert.equal(await loadingActions.nth(0).isDisabled(), true);
  assert.equal(await loadingActions.nth(1).isDisabled(), true);
  checks.push('Copy and Share disabled until the add-me link loads');
  await page.goto(`${origin}/account/my-account?profile=1`);
  await page.getByRole('button', {name:'Copy link to this Account'}).waitFor();
  assert.equal(await page.getByRole('button', {name:'Share profile',exact:true}).count(), 0);
  checks.push('Profile header retains its original copy link without the new sharing controls');
  assert.deepEqual(errors, []);
  await writeFile(resolve(out, "report.json"), JSON.stringify({ checks, errors, scope: "Real FriendsPage and sharing controls; simulated account data, native share and clipboard; not a device or full-app test." }, null, 2));
  console.log(`PASS: ${checks.length} browser checks; no page errors. Evidence: ${out}`);
} finally {
  await browser.close();
}
