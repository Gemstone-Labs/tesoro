import { describe, expect, it } from "vitest";
import { apply, fitsAt, handBase, newState, pieceAt, SIZE, type State } from "./engine";
import { clearCallout, comboHeat, wouldClear } from "./feel";
import { readBest, writeBest } from "./best";

/** Deterministic walker: tries pieces in the hand at the first legal cell after a pseudo-random start. */
function* randomGame(seed: bigint) {
  let st = newState(seed);
  let r = Number(seed % 9973n) + 1;
  const rnd = (n: number) => {
    r = (r * 48271) % 2147483647;
    return r % n;
  };
  while (!st.over) {
    const base = handBase(st);
    const slots = [0, 1, 2].filter((n) => ((st.used >> n) & 1) === 0);
    const moves: { piece: number; x: number; y: number }[] = [];
    for (const n of slots) {
      const piece = pieceAt(st.seed, base + n);
      for (let i = 0; i < 64; i++) if (fitsAt(st, piece, i % SIZE, Math.floor(i / SIZE))) moves.push({ piece: base + n, x: i % SIZE, y: Math.floor(i / SIZE) });
    }
    if (!moves.length) return;
    const mv = moves[rnd(moves.length)];
    yield { st, mv };
    st = apply(st, mv).state;
  }
}

describe("wouldClear", () => {
  it("agrees with the engine over many seeded games", () => {
    let withClears = 0;
    let checked = 0;
    for (let s = 1n; s <= 40n; s++) {
      for (const { st, mv } of randomGame(s * 7919n)) {
        const piece = pieceAt(st.seed, mv.piece);
        const guess = wouldClear(st, piece, mv.x, mv.y);
        const { result } = apply(st, mv);
        expect(guess.rows.length + guess.cols.length).toBe(result.lines);
        let mask = 0n;
        for (const y of guess.rows) mask |= 0xffn << BigInt(y * SIZE);
        for (const x of guess.cols) mask |= 0x0101010101010101n << BigInt(x);
        expect(mask).toBe(result.cleared);
        checked++;
        if (result.lines) withClears++;
      }
    }
    expect(checked).toBeGreaterThan(500);
    expect(withClears).toBeGreaterThan(10);
  });

  it("reports nothing when the piece does not fit", () => {
    const st: State = { ...newState(1n), occ: 1n };
    expect(wouldClear(st, pieceAt(1n, 0), 0, 0)).toEqual({ rows: [], cols: [] });
  });
});

describe("clearCallout", () => {
  it("names big clears in plain words", () => {
    expect(clearCallout(1, 0, 0)).toBeNull();
    expect(clearCallout(2, 0, 0)).toBe("Double!");
    expect(clearCallout(3, 0, 1)).toBe("Triple!");
    expect(clearCallout(4, 0, 0)).toBe("Board shaker!");
    expect(clearCallout(6, 0, 0)).toBe("Board shaker!");
  });
  it("shows the gem multiplier", () => {
    expect(clearCallout(1, 1, 0)).toBe("Gem ×2");
    expect(clearCallout(2, 2, 0)).toBe("Double! Gem ×3");
  });
  it("calls a streak once it builds", () => {
    expect(clearCallout(1, 0, 3)).toBe("Combo ×3");
    expect(clearCallout(1, 0, 2)).toBeNull();
  });
});

describe("comboHeat", () => {
  it("rises with the streak and caps", () => {
    expect([0, 1, 2, 3, 4, 5, 9, 30].map(comboHeat)).toEqual([0, 1, 2, 3, 3, 4, 4, 4]);
  });
});

describe("best score", () => {
  it("round-trips through storage", () => {
    const m = new Map<string, string>();
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    expect(readBest(store)).toBe(0);
    writeBest(120, store);
    expect(readBest(store)).toBe(120);
  });
  it("tolerates storage that throws", () => {
    const bad = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readBest(bad)).toBe(0);
    expect(() => writeBest(5, bad)).not.toThrow();
  });
  it("ignores junk", () => {
    expect(readBest({ getItem: () => "abc", setItem: () => {} })).toBe(0);
  });
});
