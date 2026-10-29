/** Classes only; a loading placeholder is checked against the real thing with this. */
const SKELETON_ONLY = new Set(["skel-text", "skel-inline", "vt-card-skel", "vt-card-art-skel", "wl-pocket-skel", "wl-pockets-skel"]);
const VARIANTS = new Set(["money", "neutral", "primary", "danger"]);

/**
 * The class lists of every element in a static render, in order. Text-sized placeholders
 * (`skel-text`, and the dollar figure it stands in for) and icons are left out, skeleton-only classes and button variants are dropped:
 * what remains is the layout a skeleton must share with the real card, so a missing wrapper,
 * row or class fails the comparison and names the difference.
 */
export function shape(html: string): string[] {
  const out: string[] = [];
  const tag = /<(?!\/)([a-z0-9]+)((?:\s[^>]*?)?)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(html))) {
    const name = m[1].toLowerCase();
    if (!["div", "section", "article", "header", "h1", "h2", "h3", "p", "b", "small", "span", "button", "ul", "li", "img", "a", "i"].includes(name)) continue;
    const cls = /class="([^"]*)"/.exec(m[2])?.[1].split(/\s+/).filter(Boolean) ?? [];
    if (cls.includes("skel-text") || cls.includes("gema-usd")) continue;
    if (cls.includes("sr-only")) continue;
    const kept = cls.filter((c) => !SKELETON_ONLY.has(c) && !VARIANTS.has(c)).sort();
    if (kept.length === 0 && cls.length > 0) continue;
    out.push(`${kept.join(".") || "-"}`);
  }
  return out;
}
