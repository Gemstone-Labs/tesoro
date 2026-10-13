/** How it works, held: scroll progress (0..1) to what the flow shows. The Position is lit from the start. */

export const TUBE_COUNT = 7;

export const STOPS = ["position", "advance", "play", "back", "settle", "win", "lose", "foot"] as const;
export type Stop = (typeof STOPS)[number];

const seg = (p: number, from: number, to: number) => Math.min(1, Math.max(0, (p - from) / (to - from)));

/** Each tube draws over its span; the node it reaches lights just after, and the closing line lands last. */
const TUBE_SPANS: [number, number][] = [
  [0.02, 0.17],
  [0.2, 0.38],
  [0.2, 0.38],
  [0.4, 0.56],
  [0.4, 0.56],
  [0.6, 0.78],
  [0.6, 0.78],
];
const NODE_AT: Record<Exclude<Stop, "position">, number> = { advance: 0.17, play: 0.38, back: 0.38, settle: 0.56, win: 0.78, lose: 0.78, foot: 0.88 };
const NODE_RAMP = 0.07;

export function howFlow(progress: number) {
  const p = Math.min(1, Math.max(0, progress));
  const tubes = TUBE_SPANS.map(([a, b]) => seg(p, a, b));
  const nodes = { position: 1 } as Record<Stop, number>;
  for (const [stop, at] of Object.entries(NODE_AT) as [Exclude<Stop, "position">, number][]) nodes[stop] = seg(p, at, at + NODE_RAMP);
  return { tubes, nodes, lit: STOPS.filter((s) => nodes[s] > 0) };
}
