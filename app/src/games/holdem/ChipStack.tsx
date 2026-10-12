const DENOMS = [1000, 500, 100, 50, 10, 1];

/** Chips for an amount, biggest first, at most `cap` discs (the rest rounds into the biggest). */
export function chipDiscs(amount: number, cap = 7): number[] {
  const out: number[] = [];
  let left = Math.max(0, Math.floor(amount));
  for (const d of DENOMS) {
    while (left >= d && out.length < cap) {
      out.push(d);
      left -= d;
    }
  }
  return out.reverse();
}

/**
 * A stack of neutral steel Chips for an amount. Chips are scorekeeping, not Gemas: never emerald,
 * never the Gema mark. `piles` splits big amounts into side-by-side stacks (the pot).
 */
export function ChipStack({ amount, piles = 1, className = "" }: { amount: bigint | number; piles?: 1 | 2 | 3; className?: string }) {
  const n = Number(amount);
  if (n <= 0) return null;
  const cap = piles * 6;
  const discs = chipDiscs(n, cap);
  const per = Math.ceil(discs.length / piles);
  const cols: number[][] = [];
  for (let i = 0; i < discs.length; i += per) cols.push(discs.slice(i, i + per));
  return (
    <span className={`hd-stack-chips ${className}`} aria-hidden="true">
      {cols.map((col, c) => (
        <span key={c} className="hd-pile" style={{ height: 14 + col.length * 4 }}>
          {col.map((d, i) => (
            <i key={i} className={`hd-chip d${d}`} style={{ bottom: i * 4 }} />
          ))}
        </span>
      ))}
    </span>
  );
}
