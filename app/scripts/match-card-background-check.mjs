import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile, rm, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? "playwright-core");
const base = process.env.BASE ?? "http://localhost:3391";
const out = process.env.OUT ?? join(homedir(), ".cache/tesoro-tmp/match-card-backgrounds");
// Render the actual components with deterministic open Matches; no wallet or chain writes.
// The temporary route is removed even when an assertion fails.
const route = resolve("src/app/(app)/card-background-regression");
await mkdir(out, { recursive: true });
await mkdir(route);
await writeFile(join(route, "page.tsx"), `"use client";
import { useEffect, useState } from "react";
import { ContinueRail } from "@/components/lobby/ContinueRail";
import { MatchBanner } from "@/components/match/MatchBanner";
import { match } from "@/lib/chain/fixture";
import { historyRow } from "@/lib/chain/history";
import type { ChainMatch } from "@/lib/chain/read";
import type { GameId } from "@/lib/mock";
const games: GameId[] = ["block-puzzle", "holdem", "trading-duel", "vanguard"];
export default function CardBackgroundRegression() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <div>Loading card fixtures…</div>;
  return <div className="stack-lg">{games.map(game => {
    const finished = match(game, 2500, true, 2, [171, 55]);
    const open: ChainMatch = { ...finished, status: "open", opponent: null, deadline: Math.floor(Date.now() / 1000) + 86400, session: null, winner: null, sides: [finished.sides[0], null] };
    const challenge = { matchId: finished.id.toString(), game, from: finished.sides[0].player, entry: 500, at: Date.now() };
    return <section className="stack-lg" key={game} data-game={game}>
      <ContinueRail matches={[open]} />
      <ContinueRail matches={[open]} title="Open" rows />
      <ContinueRail matches={[]} challenges={[challenge]} title="Challenge" />
      <div className="mb-list"><MatchBanner r={historyRow(finished)!} account={finished.sides[0].player} now={Date.now()} /></div>
    </section>;
  })}</div>;
}
`);
let browser;
const results = [];
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME ?? join(homedir(), ".cache/ms-playwright/chromium-1228/chrome-linux64/chrome"), args: ["--no-sandbox"] });
  for (const width of [390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 }, isMobile: width === 390, hasTouch: width === 390 });
    await page.goto(`${base}/card-background-regression?dev=demo`, { waitUntil: "domcontentloaded", timeout: 90000 });
    // Next's route watcher can briefly serve its cached not-found page for a newly added route.
    for (let attempt = 0; attempt < 10 && await page.locator(".continue-art img").count() === 0; attempt++) {
      await page.waitForTimeout(1000);
      await page.reload({ waitUntil: "domcontentloaded" });
    }
    await page.locator(".continue-art img").first().waitFor({ timeout: 90000 });
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    for (const section of await page.locator("[data-game]").all()) {
      await section.scrollIntoViewIfNeeded();
      await section.locator("img").evaluateAll(imgs => Promise.all(imgs.map(img => img.decode())));
      const game = await section.getAttribute("data-game");
      await section.screenshot({ path: join(out, `${game}-${width}.png`), animations: "disabled" });
      const reference = await section.locator(".mb-art").evaluate(el => ({ scrim: getComputedStyle(el, "::after").backgroundImage, opacity: getComputedStyle(el.querySelector("img")).opacity, source: el.querySelector("img").getAttribute("src") }));
      for (const card of await section.locator(".continue-card").all()) {
        const actual = await card.evaluate(el => {
          const art = el.querySelector(".continue-art");
          const img = art.querySelector("img");
          const box = el.getBoundingClientRect();
          const artBox = art.getBoundingClientRect();
          return { scrim: getComputedStyle(art, "::after").backgroundImage, opacity: getComputedStyle(img).opacity, source: img.getAttribute("src"), inset: [artBox.x - box.x, artBox.y - box.y, artBox.width - box.width, artBox.height - box.height], position: getComputedStyle(img).objectPosition };
        });
        if (process.env.CAPTURE_ONLY !== "1") {
          assert.equal(actual.scrim, reference.scrim, `${game} ${width}: dark overlay matches Finished and is valid CSS`);
          assert.equal(actual.opacity, reference.opacity, `${game} ${width}: same art opacity as Finished`);
          assert.equal(actual.source.split("&w=")[0], reference.source.split("&w=")[0], `${game}: wide hero art matches Finished`);
          assert.ok(actual.inset.every(n => Math.abs(n) < 1), `${game} ${width}: artwork covers the whole card`);
          assert.equal(actual.position, "100% 50%", "art stays on the right");
        }
        results.push({ game, width, ...actual });
      }
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, "no horizontal overflow");
    await page.close();
  }
  await writeFile(join(out, "results.json"), JSON.stringify(results, null, 2));
  console.log(`${process.env.CAPTURE_ONLY === "1" ? "CAPTURE" : "PASS"}: ${results.length} Continue/Open/Challenge backgrounds at 390px and 1440px`);
} finally {
  await browser?.close();
  await rm(join(route, "page.tsx"));
  await rmdir(route);
}
