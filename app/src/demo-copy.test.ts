import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname);
const SKIP_DIRS = new Set(["node_modules", "(marketing)", "idl"]);

const BANNED: [RegExp, string][] = [
  [/Test mode\s*·\s*(Gemas come|simulated yield)/i, "the Test mode / simulated-yield note"],
  [/Simulated yield\s*·/i, "the 'Simulated yield · 1 month = 10 min' label"],
  [/Simulated\s*·/, "the 'Simulated · … 1 month = 10 min' label"],
  [/Yield here is simulated/i, "the 'Yield here is simulated' sentence"],
  [/redeemable as their yield/i, "the 'Pending · redeemable as their yield lands' line"],
  [/Receipts\s*\(|<Receipts\b/, "a Receipts list"],
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return SKIP_DIRS.has(name) ? [] : files(p);
    return /\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

describe("demo copy", () => {
  it("no screen shows Receipts, Test mode notes or simulated-yield labels", () => {
    const hits: string[] = [];
    for (const f of files(SRC)) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        if (/^\s*(\/\/|\/?\*)/.test(line)) return;
        for (const [re, what] of BANNED) {
          if (re.test(line)) hits.push(`${relative(SRC, f)}:${i + 1} shows ${what}`);
        }
      });
    }
    expect(hits, "Remove this copy (match-flow-polish ticket 03): the app shows no demo notes or Receipts lists. Marketing pages are exempt.").toEqual([]);
  });
});
