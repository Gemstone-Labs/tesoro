import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW);
const dev = process.argv[2];
const keys = JSON.parse(readFileSync(`${process.env.HOME}/.cache/tesoro-tmp/e2e-hype/devkeys.json`, "utf8"));
const b = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addInitScript(([d, k]) => { localStorage.setItem(`tesoro-dev-wallet:${d}`, k.sol); localStorage.setItem(`tesoro-dev-evm:${d}`, k.evm); localStorage.setItem("tesoro-guide-dismissed", JSON.stringify(["lobby-first","wallet-first","gemas"])); }, [dev, keys[dev]]);
const p = await ctx.newPage(); p.setDefaultTimeout(120000);
await p.goto(`http://localhost:3152/?dev=${dev}`, { waitUntil: "load" });
try {
await p.getByText("Waiting to be paired").waitFor();
await p.getByText("Waiting to be paired").click();
await p.getByRole("button", { name: "Cancel and refund entry" }).click();
await p.getByText(/Refunded/i).first().waitFor();
console.log((await p.locator("main").innerText()).split("\n").filter(Boolean).join(" | ").slice(0, 500));
await p.screenshot({ path: `${process.cwd()}/docs/screens/qa-2026-10-02-hype-cancel-refund-${dev}.png` });
} catch (e) { console.log("FAILED", e.message.split("\n")[0]); await p.screenshot({ path: `${process.cwd()}/docs/screens/qa-2026-10-02-hype-cancel-failed.png` }); }
await b.close();
