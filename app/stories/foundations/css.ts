import globalsCss from "../../src/app/globals.css?raw";
import landingCss from "../../src/components/landing/landing.css?raw";
import uiCss from "../../src/components/ui/ui.css?raw";
import pageCss from "../../src/components/ui/page.css?raw";
import shellCss from "../../src/components/shell/shell.css?raw";
import lobbyCss from "../../src/components/lobby/lobby.css?raw";

export type Token = { name: string; value: string };

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");

/** The custom properties declared in the first block that starts with `selector`. */
function tokensOf(css: string, selector: string): Token[] {
  const at = css.indexOf(selector);
  if (at < 0) return [];
  const body = stripComments(css.slice(css.indexOf("{", at) + 1, css.indexOf("\n}", at)));
  return [...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => ({ name: m[1], value: m[2].trim().replace(/\s+/g, " ") }));
}

/** App tokens: the first `:root` block of globals.css. New tokens show up here by themselves. */
export const appTokens = tokensOf(globalsCss, ":root {");

/** The landing light theme: what `:root[data-theme="light"]` overrides. */
export const lightTokens = tokensOf(landingCss, ':root[data-theme="light"] {').filter((t) => !t.value.startsWith("url("));

const isColour = (v: string) => /^(#|rgba?\(|hsla?\(|color-mix)/.test(v);
const isGradient = (v: string) => /gradient\(/.test(v);
export type Kind = "colour" | "gradient" | "font" | "size" | "other";
export const kindOf = (t: Token): Kind =>
  isColour(t.value) ? "colour" : isGradient(t.value) ? "gradient" : t.name.startsWith("--f-") ? "font" : /^-?[\d.]+(px|rem)$/.test(t.value) ? "size" : "other";

/** Every plain `font-size: Npx` the component CSS declares, with how often. */
export function fontSizesInUse(): { px: number; count: number }[] {
  const counts = new Map<number, number>();
  for (const css of [uiCss, pageCss, shellCss, lobbyCss]) {
    for (const m of stripComments(css).matchAll(/font-size:\s*([\d.]+)px/g)) counts.set(+m[1], (counts.get(+m[1]) ?? 0) + 1);
  }
  return [...counts].map(([px, count]) => ({ px, count })).sort((a, b) => a.px - b.px);
}
