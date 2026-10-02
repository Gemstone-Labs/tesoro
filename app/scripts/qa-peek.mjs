/** Open a page as a dev wallet in a fresh browser context, print its text and screenshot it.
 *  node scripts/qa-peek.mjs <dev> <path> <shotname> [waitMs] [width] */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW);
const [dev, path, name, wait = "8000", w = "390"] = process.argv.slice(2);
const keys = JSON.parse(readFileSync(process.env.QA_KEYS ?? `${process.env.HOME}/.cache/tesoro-tmp/e2e-hype/devkeys.json`, "utf8"));
const b = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
const ctx = await b.newContext({ viewport: { width: Number(w), height: 844 } });
await ctx.addInitScript(([d, k]) => { localStorage.setItem(`tesoro-dev-wallet:${d}`, k.sol); localStorage.setItem(`tesoro-dev-evm:${d}`, k.evm); localStorage.setItem("tesoro-guide-dismissed", JSON.stringify(["account","backing","backing-first","gemas","lobby-first","matches","redeem","trouble","wallet-first","xc-open","wallet","lobby","play","help"])); localStorage.setItem("tesoro-guide-off", "1"); }, [dev, keys[dev]]);
const p = await ctx.newPage();
await p.goto(`${process.env.BASE ?? "http://localhost:3152"}${path}${path.includes("?") ? "&" : "?"}dev=${dev}`, { waitUntil: "load", timeout: 120000 });
await p.waitForTimeout(Number(wait));
const g = p.getByRole("button", { name: "Got it" });
if (await g.count()) await g.click();
console.log(p.url());
console.log(await p.locator("main").innerText());
await p.screenshot({ path: `${process.cwd()}/docs/screens/qa-2026-10-02-hype-${name}.png`, fullPage: true });
await b.close();
