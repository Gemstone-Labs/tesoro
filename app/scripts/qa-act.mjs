/**
 * Click a Wallet Position button as a dev wallet and log the tracker's text over time.
 *   node scripts/qa-act.mjs <dev> "<button label>" [confirm label] [maxSec]
 * Examples: "Report yield", "Redeem", "Unlock", "Return Gemas" "Return" (sheet confirm).
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW);
const [dev, label, confirm, maxSec = "300"] = process.argv.slice(2);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const keys = JSON.parse(readFileSync(process.env.QA_KEYS ?? `${process.env.HOME}/.cache/tesoro-tmp/e2e-hype/devkeys.json`, "utf8"));
const b = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
const ctx = await b.newContext({ viewport: { width: Number(process.env.W ?? 390), height: 844 } });
await ctx.addInitScript(([d, k]) => { localStorage.setItem(`tesoro-dev-wallet:${d}`, k.sol); localStorage.setItem(`tesoro-dev-evm:${d}`, k.evm); localStorage.setItem("tesoro-guide-dismissed", JSON.stringify(["account","backing","backing-first","gemas","lobby-first","matches","redeem","trouble","wallet-first","xc-open","wallet","lobby","play","help"])); }, [dev, keys[dev]]);
const p = await ctx.newPage();
const shot = (n) => p.screenshot({ path: `${process.cwd()}/docs/screens/qa-2026-10-02-hype-${n}.png`, fullPage: true }).catch(() => {});
const tag = `${dev}-${label.toLowerCase().replace(/\W+/g, "-")}`;
try {
  await p.goto(`${process.env.BASE ?? "http://localhost:3152"}/wallet?dev=${dev}`, { waitUntil: "load", timeout: 180000 });
  await p.waitForTimeout(3000);
  const g = p.getByRole("button", { name: "Got it" });
  if (await g.count()) await g.click();
  const btn = (n) => p.waitForFunction((n) => [...document.querySelectorAll("button")].some((x) => x.textContent?.trim().startsWith(n) && !x.disabled), n, { timeout: 120000 });
  const press = (n) => p.evaluate(([n, first]) => { const bs = [...document.querySelectorAll("button")].filter((x) => x.textContent?.trim().startsWith(n) && !x.disabled); (first ? bs[0] : bs[bs.length - 1]).click(); }, [n, !!process.env.FIRST]);
  await p.waitForTimeout(Number(process.env.PRE ?? 0));
  await btn(label);
  await shot(`${tag}-0-before`);
  const t0 = Date.now();
  await press(label);
  log("pressed", label);
  if (confirm) {
    await p.waitForTimeout(1500);
    log("sheet:", (await p.locator("[role=dialog]").innerText().catch(() => "")).replace(/\n+/g, " | ").slice(0, 400));
    await shot(`${tag}-1-sheet`);
    await btn(confirm);
    await press(confirm);
    log("confirmed", confirm);
  }
  let last = "";
  const end = Date.now() + Number(maxSec) * 1000;
  let n = 0;
  while (Date.now() < end) {
    await p.waitForTimeout(4000);
    const txt = (await p.locator("main").innerText()).split("\n").filter((l) => /confirmed|delivered|sent|recorded|arrived|Redeemed|Unlocked|Principal|Debt|error|failed|limit|too long|Reporting|Redeeming|Unlocking|Report yield|Delivering|LayerZero|HyperEVM|Hoodi|Gemas are|Returned/i.test(l) && l.length < 200).join(" | ");
    if (txt !== last) { log(`+${Math.round((Date.now() - t0) / 1000)}s`, txt.slice(0, 600)); last = txt; if (++n % 3 === 0) await shot(`${tag}-2-progress${n}`); }
    const busy = await p.evaluate(() => /Reporting…|Redeeming…|Unlocking…|Returning…/.test(document.body.innerText));
    if (!busy && Date.now() - t0 > 20000) { await p.waitForTimeout(6000); if (!(await p.evaluate(() => /Reporting…|Redeeming…|Unlocking…|Returning…/.test(document.body.innerText)))) break; }
  }
  log("settled in", Math.round((Date.now() - t0) / 1000), "s");
  await shot(`${tag}-3-after`);
  console.log((await p.locator("main").innerText()).split("\n").filter(Boolean).join(" | ").slice(0, 1500));
} catch (e) {
  log("FAILED", e.message.split("\n")[0], (e.stack.match(/qa-act.mjs:\d+/) ?? [])[0]);
  await shot(`${tag}-failed`);
  process.exitCode = 1;
}
await b.close();
