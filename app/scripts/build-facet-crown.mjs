/**
 * The facet crown: an emerald cut seen from above (step facets around a table), lit from the top.
 * Decoration for money surfaces (the Wallet balance). Writes public/brand/facet-crown.svg.
 *   node scripts/build-facet-crown.mjs
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const W = 560, H = 420, C = 120, K = Math.SQRT2 - 1;
const insets = [0, 34, 68, 104];
const oct = (d) => {
  const c = C + d * K;
  return [[c, d], [W - c, d], [W - d, c], [W - d, H - c], [W - c, H - d], [c, H - d], [d, H - c], [d, c]];
};
const rings = insets.map(oct);
const pts = (p) => p.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
// light falls from above: top facets brightest, the pavilion side darkest
const sideAlpha = [0.2, 0.13, 0.09, 0.05, 0.035, 0.05, 0.08, 0.12];
let facets = "";
for (let r = 0; r < rings.length - 1; r++) {
  const a = rings[r], b = rings[r + 1];
  for (let i = 0; i < 8; i++) {
    const j = (i + 1) % 8;
    const alpha = sideAlpha[i] * (1 - r * 0.22) * 0.6;
    facets += `<polygon points="${pts([a[i], a[j], b[j], b[i]])}" fill="#7efada" fill-opacity="${alpha.toFixed(3)}"/>`;
  }
}
const table = rings[rings.length - 1];
const lines = rings.map((r) => `<polygon points="${pts(r)}"/>`).join("") +
  rings[0].map((_, i) => `<line x1="${rings[0][i][0].toFixed(1)}" y1="${rings[0][i][1].toFixed(1)}" x2="${table[i][0].toFixed(1)}" y2="${table[i][1].toFixed(1)}"/>`).join("");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ${W + 4} ${H + 4}" width="${W + 4}" height="${H + 4}">
<defs>
<linearGradient id="t" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7efada" stop-opacity=".16"/><stop offset=".48" stop-color="#7efada" stop-opacity=".07"/><stop offset=".48" stop-color="#7efada" stop-opacity=".025"/><stop offset="1" stop-color="#7efada" stop-opacity=".05"/></linearGradient>
<linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b8ffec" stop-opacity=".34"/><stop offset="1" stop-color="#7efada" stop-opacity=".08"/></linearGradient>
</defs>
${facets}
<polygon points="${pts(table)}" fill="url(#t)"/>
<g fill="none" stroke="url(#s)" stroke-width="1.2" stroke-linejoin="round">${lines}</g>
</svg>
`;
const out = resolve(dirname(fileURLToPath(import.meta.url)), "../public/brand/facet-crown.svg");
writeFileSync(out, svg);
console.log("wrote", out, svg.length, "bytes");
