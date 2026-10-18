import { enemy, targets, type Army, type Game, type Rng, type Square } from "../rules";

/**
 * The practice bot. It plays blind like a Player: it never reads the hidden ranks of the other army,
 * only its own. It spends a Two-Step Turn at once, raids the enemy depot when next to it, attacks with
 * its strong pieces, probes with Recons, and otherwise pushes forward. Landmines and its Truck mostly stay home.
 */
export function botMove(g: Game, rng: Rng = Math.random): { id: number; to: Square; twoStep: boolean } | null {
  const army: Army = g.turn;
  const twoStep = g.twoStep[army] > 0 && !g.twoStepActive && g.movedThisTurn.length === 0;
  // the Two-Step Turn is decided first: inside it a Recon no longer runs far, so every move is picked from what is legal there
  const view: Game = twoStep ? { ...g, twoStepActive: true } : g;
  const forward = army === "it" ? 1 : -1;
  const raid = g.depots.find((d) => d.raider === army && !d.claimed);
  let best: { id: number; to: Square; score: number } | null = null;
  for (const p of g.pieces) {
    if (p.army !== army) continue;
    for (const t of targets(view, p)) {
      const v = p.rank === "B" || p.rank === "F" ? 0 : Number(p.rank);
      const dist = Math.abs(t.r - p.r) + Math.abs(t.c - p.c);
      let score = rng() * 2;
      if (t.attack) {
        const foe = g.pieces.find((o) => o.r === t.r && o.c === t.c && o.army === enemy(army));
        score += foe?.known ? 30 : v >= 7 ? 6 + v / 2 : p.rank === "2" ? 4 : v >= 5 ? 2 : -3;
      } else {
        score += (t.r - p.r) * forward * (p.rank === "2" ? 0.6 : 1.4);
        if (raid && dist === 1 && t.r === raid.r && t.c === raid.c) score += 20;
        if (raid) score += (Math.abs(p.r - raid.r) + Math.abs(p.c - raid.c) - (Math.abs(t.r - raid.r) + Math.abs(t.c - raid.c))) * 0.8;
      }
      if (p.rank === "F") score -= 8;
      if (p.rank === "1" && !t.attack) score -= 1;
      if (!best || score > best.score) best = { id: p.id, to: { r: t.r, c: t.c }, score };
    }
  }
  return best && { id: best.id, to: best.to, twoStep };
}
