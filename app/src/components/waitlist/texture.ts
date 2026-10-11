/**
 * The octagon texture's geometry, one 360 x 300 tile: an octagon (with a nested outline) whose corner facets link to
 * the facing facets of its diagonal neighbours, so every line joins two shapes. The gaps are 100px both ways, so the
 * links run at 45 degrees. The octagon's centre (160, 140) and the tile's size are what the divider's lattice snaps to.
 *
 * The same drawing ships as SVG in `--wl-texture` (waitlist.css), `--lp-texture` (landing.css, both themes) and the
 * divider's pattern (DividerSvg.tsx), with the links cut at the tile edge. Change them together.
 */
export type Pt = [number, number];

export const TILE = { w: 360, h: 300 } as const;

/** The outer octagon, with its corner facets' midpoints as vertices (the links start there). */
export const OUTER: Pt[] = [[70, 40], [250, 40], [270, 60], [290, 80], [290, 200], [270, 220], [250, 240], [70, 240], [50, 220], [30, 200], [30, 80], [50, 60]];
export const INNER: Pt[] = [[98, 68], [222, 68], [250, 96], [250, 184], [222, 212], [98, 212], [70, 184], [70, 96]];
/** Bottom corner facets to the next row's top corner facets, uncut (they end in the neighbouring tile). */
export const LINKS: [Pt, Pt][] = [[[270, 220], [410, 360]], [[50, 220], [-90, 360]]];
