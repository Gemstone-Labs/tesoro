import { describe, expect, it } from "vitest";
import { move, newGame, seeded, startTwoStep, timeout, type Game } from "../rules";
import { botMove } from "./bot";

const T0 = 5_000_000;

/** Two copies of the bot play a whole Match on the engine; every action the bot picks must be accepted. */
function playOut(seed: number): Game {
  const rng = seeded(seed);
  let g = newGame(rng, T0);
  for (let i = 0; i < 2000 && !g.winner; i++) {
    const m = botMove(g, rng);
    const at = T0 + i * 1000;
    if (!m) {
      const t = timeout(g, g.deadline + 1);
      if (!t.ok) throw new Error(t.reason);
      g = t.game;
      continue;
    }
    if (m.twoStep) {
      const s = startTwoStep(g, at);
      if (!s.ok) throw new Error(s.reason);
      g = s.game;
    }
    const r = move(g, { id: m.id, to: m.to, at });
    if (!r.ok) throw new Error(`seed ${seed}: bot move refused (${r.reason})`);
    g = r.game;
  }
  return g;
}

describe("practice bot", () => {
  it("never plans a Recon long run it then spends a Two-Step Turn on", () => {
    let spent = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const rng = seeded(seed);
      let g = newGame(rng, T0);
      for (let i = 0; i < 400 && !g.winner; i++) {
        const m = botMove(g, rng);
        const at = T0 + i * 1000;
        if (!m) break;
        if (m.twoStep) {
          const s = startTwoStep(g, at);
          if (!s.ok) throw new Error(s.reason);
          g = s.game;
          spent++;
        }
        const r = move(g, { id: m.id, to: m.to, at });
        expect(r.ok, `seed ${seed} move ${i}`).toBe(true);
        if (!r.ok) return;
        g = r.game;
      }
    }
    expect(spent).toBeGreaterThan(0);
  }, 30_000);

  it("plays whole Matches to an end without a single refused action", () => {
    for (let seed = 1; seed <= 25; seed++) {
      const g = playOut(seed);
      expect(g.winner).not.toBeNull();
      expect(g.pieces.every((p) => p.known)).toBe(true);
    }
  });
});
