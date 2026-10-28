import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname);
const SKIP_DIRS = new Set(["node_modules", "(marketing)", "idl"]);
/** Marketing pages are exempt, except the shared win page. */
const ALSO = [join("app", "(marketing)", "win")];

const BANNED: [RegExp, string][] = [
  [/Test mode\s*·\s*(Gemas come|simulated yield|no card)/i, "the Test mode / simulated-yield / no-card note"],
  [/Test mode:\s*Gemas/i, "the shared win page's Test mode note"],
  [/>\s*Test mode\s*</, "a bare Test mode tag"],
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
    for (const f of [...files(SRC), ...ALSO.flatMap((d) => files(join(SRC, d)))]) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        if (/^\s*(\/\/|\/?\*)/.test(line)) return;
        for (const [re, what] of BANNED) {
          if (re.test(line)) hits.push(`${relative(SRC, f)}:${i + 1} shows ${what}`);
        }
      });
    }
    expect(hits, "Remove this copy (match-flow-polish ticket 03): the app shows no demo notes or Receipts lists. Marketing pages are exempt.").toEqual([]);
  });
  it("keeps the sign-in sheet's one Test mode line, said before anyone signs in", () => {
    expect(readFileSync(join(SRC, "components", "shell", "SignInSheet.tsx"), "utf8")).toContain("Browsing needs no sign-in · Test mode");
  });
});
