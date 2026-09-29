function paint(seed: number): string[] {
  let s = seed;
  const rnd = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  return Array.from({ length: 64 }, (_, i) => {
    if (i <= 23) return "";
    const r = rnd();
    if (r >= 0.55) return "";
    return r < 0.07 ? "g" : `f${1 + Math.floor(rnd() * 4)}`;
  });
}

/** Deterministic Block Puzzle art. Game art is the colourful part of the product. */
export function BlockBoard({ seed = 11 }: { seed?: number }) {
  return (
    <div className="art" aria-hidden="true">
      <div className="board">
        {paint(seed).map((c, i) => (
          <i key={i} className={c} />
        ))}
      </div>
    </div>
  );
}
