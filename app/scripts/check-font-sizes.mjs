// Warning-only: lists CSS font sizes written as raw px instead of a --fs-* token (landing and waitlist excluded). Never fails.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const skip = /components\/(landing|waitlist)\//;
const hits = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".css") && !skip.test(p)) {
      readFileSync(p, "utf8").split("\n").forEach((line, i) => {
        if (/font-size:\s*[\d.]+px|\bfont:\s*[^;{}]*?\b[\d.]+px/.test(line)) hits.push(`${p}:${i + 1}`);
      });
    }
  }
};
walk("src");
for (const h of hits) console.warn(`raw px font size: ${h}`);
console.warn(`${hits.length} raw px font sizes (display sizes above 24px are expected)`);
