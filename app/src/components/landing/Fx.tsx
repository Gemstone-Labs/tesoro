/** Small decorative effects, server-rendered and deterministic (no hydration drift). All are aria-hidden and stop under reduced motion. */

/** A seeded 0..1 sequence, so every render places the motes identically. */
function seq(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

/** Dust motes drifting up through a light shaft. `box` is the area they live in, in % of the parent. */
export function Motes({ count, seed, className = "" }: { count: number; seed: number; className?: string }) {
  const r = seq(seed);
  return (
    <span className={`lp-motes ${className}`} aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <i
          key={i}
          style={{
            ["--x" as string]: `${(r() * 100).toFixed(1)}%`,
            ["--y" as string]: `${(40 + r() * 60).toFixed(1)}%`,
            ["--s" as string]: `${(1.5 + r() * 2.5).toFixed(1)}px`,
            ["--d" as string]: `${(-r() * 14).toFixed(1)}s`,
            ["--t" as string]: `${(9 + r() * 8).toFixed(1)}s`,
            ["--dx" as string]: `${(r() * 40 - 20).toFixed(0)}px`,
          }}
        />
      ))}
    </span>
  );
}

/** Four-point star glints that flash now and then, at given spots (% of the parent); `phone` replaces them below 768px. */
export function Glints({ at, phone }: { at: [number, number, number][]; phone?: [number, number, number][] }) {
  const set = (pts: [number, number, number][], cls: string) => (
    <span className={`lp-glints ${cls}`} aria-hidden>
      {pts.map(([x, y, delay], i) => (
        <i key={i} style={{ left: `${x}%`, top: `${y}%`, ["--d" as string]: `${delay}s` }} />
      ))}
    </span>
  );
  return (
    <>
      {set(at, phone ? "wide-only" : "")}
      {phone && set(phone, "phone-only")}
    </>
  );
}
