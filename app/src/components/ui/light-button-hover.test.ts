import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..");

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "mocks" ? [] : files(path, ext);
    return ext.test(name) && !/\.(test|stories)\./.test(name) ? [path] : [];
  });
}

const LIGHT_FILL = /^(var\(--fg\)|#fff\b|#f[0-9a-f]{2,5}\b|#e[0-9a-f]{5}\b)/i;

/** Classes whose rule paints a light fill, with the rule that does it. */
function lightClassesIn(source: string, where: string, found = new Map<string, string>()): Map<string, string> {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [, selectors, body] of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    const fill = body.match(/(?:^|;|\s)background(?:-color)?:\s*([^;]+)/);
    if (!fill || !LIGHT_FILL.test(fill[1].trim())) continue;
    for (const selector of selectors.split(",")) {
      if (/::?(before|after)\b/.test(selector)) continue;
      const last = selector.trim().split(/[\s>+~]+/).pop() ?? "";
      const classes = [...last.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
      const own = classes.filter((c) => !["btn", "neutral", "cut", "cut-btn", "sm", "lg"].includes(c));
      if (classes.includes("light")) continue;
      for (const name of own) found.set(name, `${where}: ${selector.trim()}`);
    }
  }
  return found;
}

function lightFillClasses(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of files(root, /\.css$/)) lightClassesIn(readFileSync(file, "utf8"), file.slice(root.length + 1), found);
  return found;
}

/**
 * `.btn.neutral:hover` paints a dark fill. A page that recolours a neutral button light with its own
 * rule loses to that hover (higher specificity), so the button flips to black with dark text. Light
 * buttons use `<Button variant="light">` (`.btn.light`), which owns a matching hover.
 * Dynamic class names are covered by `scripts/light-hover-check.mjs`.
 */
describe("light buttons", () => {
  it("are never neutral buttons recoloured by a page rule", () => {
    const light = lightFillClasses();
    const offenders: string[] = [];
    for (const file of files(root, /\.tsx$/)) {
      const source = readFileSync(file, "utf8");
      for (const [, literal] of source.matchAll(/className="([^"{}$]*)"/g)) {
        const tokens = literal.split(/\s+/);
        if (!tokens.includes("btn") || !tokens.includes("neutral")) continue;
        for (const token of tokens) {
          const rule = light.get(token);
          if (rule) offenders.push(`${file.slice(root.length + 1)}: "${literal}" is recoloured light by ${rule}`);
        }
      }
    }
    expect(offenders, 'Use <Button variant="light"> (or the "light" class) instead of recolouring a neutral button.').toEqual([]);
  });

  it("detects a page rule that paints a button light", () => {
    const found = lightClassesIn('.lb-page[aria-current="page"] { background: var(--fg); color: var(--shell); }\n.btn.light { background: var(--fg); }\n.x::before { background: var(--fg); }', "t.css");
    expect([...found.keys()]).toEqual(["lb-page"]);
  });
});
