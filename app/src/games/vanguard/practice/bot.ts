import { DEPOTS, act, enemy, fight, hasStep, move, rankOf, targets, type Army, type Game, type PowerKind, type Result, type Rng, type Square } from "../rules";

/** What the bot plays this turn. A move may carry the free Become a Spy switch; a Two-Step Turn is started first when `twoStep` is set. */
export type BotAction =
  | { kind: "move"; id: number; to: Square; twoStep: boolean; switch: boolean }
  | { kind: Exclude<PowerKind, "dig_in">; id: number; twoStep: false; switch: false }
  /** A Dig in is a pass that names the Major. The bot never passes otherwise: Players have no Pass button. */
  | { kind: "dig_in"; id: number; twoStep: false; switch: false };

/** "fortress" digs both Majors in around its Truck and otherwise plays like "standard". */
export type Policy = "standard" | "fortress";
export type BotMove = Extract<BotAction, { kind: "move" }>;

const near = (a: Square, b: Square) => Math.max(Math.abs(a.r - b.r), Math.abs(a.c - b.c)) <= 1;
/** Early enough for a Major to dig in beside its Truck or depot. */
const EARLY_TURN = 30;

/** Play the chosen action (the caller starts the Two-Step Turn first when `m.twoStep`). */
export function applyBot(g: Game, m: BotAction, at: number): Result {
  if (m.kind === "move") return move(g, { id: m.id, to: m.to, at, switch: m.switch });
  return act(g, { kind: m.kind, id: m.id, at });
}

/**
 * The practice bot. It plays blind like a Player: it never reads the hidden ranks of the other army,
 * only its own and the pieces already shown. It spends a Two-Step Turn at once (when a step exists), raids the enemy depot
 * when next to it, attacks with its strong pieces, probes with Recons, and otherwise pushes forward. Landmines and its Truck mostly stay home.
 * With no move left it returns null and lets the clock run out. Policy "plain" never uses a power (the recordings use it until their
 * regeneration with powers).
 * Powers (spec "Bot"): Rescue when an enemy stands next to the Truck, Blast when 3 or more hidden enemies are around
 * an Engineer, a Major digs in early beside its Truck or depot, and the 10 becomes a Spy only to attack a shown 10.
 */
export function botMove(g: Game, rng: Rng, policy: "plain"): BotMove | null;
export function botMove(g: Game, rng?: Rng, policy?: Policy): BotAction | null;
export function botMove(g: Game, rng: Rng, policy: Policy | "plain"): BotAction | null;
export function botMove(g: Game, rng: Rng = Math.random, policy: Policy | "plain" = "standard"): BotAction | null {
  const army: Army = g.turn;
  const mine = g.pieces.filter((p) => p.army === army);
  const foes = g.pieces.filter((p) => p.army === enemy(army));
  const truck = mine.find((p) => p.rank === "F");
  const home = DEPOTS.find((d) => d.raider === enemy(army))!;

  if (policy !== "plain" && g.version >= 6 && !g.twoStepActive && g.movedThisTurn.length === 0) {
    const colonel = mine.find((p) => rankOf(g, p) === "8");
    if (colonel && truck && foes.some((f) => near(f, truck))) return { kind: "rescue", id: colonel.id, twoStep: false, switch: false };
    const engineer = mine.find((p) => rankOf(g, p) === "3" && foes.filter((f) => !f.known && near(f, p)).length >= 3);
    if (engineer) return { kind: "blast", id: engineer.id, twoStep: false, switch: false };
    const early = policy === "fortress" || g.turnNo < EARLY_TURN;
    const major = mine.find((p) => rankOf(g, p) === "7" && early && ((truck && near(p, truck)) || (policy === "standard" && near(p, home))));
    if (major) return { kind: "dig_in", id: major.id, twoStep: false, switch: false };
  }

  const twoStep = g.twoStep[army] > 0 && !g.twoStepActive && g.movedThisTurn.length === 0 && hasStep(g, army);
  // the Two-Step Turn is decided first: inside it a Recon no longer runs far, so every move is picked from what is legal there
  const view: Game = twoStep ? { ...g, twoStepActive: true } : g;
  const forward = army === "it" ? 1 : -1;
  const raid = g.depots.find((d) => d.raider === army && !d.claimed);
  const hunted = foes.find((f) => f.known && rankOf(g, f) === "10");
  let best: { id: number; to: Square; score: number; switch: boolean } | null = null;
  for (const p of mine) {
    const rank = rankOf(g, p);
    const v = rank === "B" || rank === "F" ? 0 : Number(rank);
    const canSwitch = p.rank === "10" && !g.changed[p.id];
    for (const t of targets(view, p)) {
      const dist = Math.max(Math.abs(t.r - p.r), Math.abs(t.c - p.c));
      let score = rng() * 2;
      let sw = false;
      if (t.attack) {
        const foe = foes.find((o) => o.r === t.r && o.c === t.c)!;
        if (foe.known) {
          // a shown piece's rank is public: fight only what the fight is won against (a shown 10 falls to the 10 turned Spy)
          const foeRank = rankOf(g, foe);
          sw = canSwitch && foeRank === "10";
          const out = fight(sw ? "1" : rank, foeRank, g.version);
          score += out === "win" || out === "truck" ? 30 : out === "tie" ? 2 : -20;
        } else score += v >= 7 ? 6 + v / 2 : rank === "2" ? 4 : v >= 5 ? 2 : -3;
      } else {
        score += (t.r - p.r) * forward * (rank === "2" ? 0.6 : 1.4);
        // a step claims the depot; a longer run or a jump does not
        if (raid && dist === 1 && t.r === raid.r && t.c === raid.c) score += 20;
        if (raid) score += (Math.abs(p.r - raid.r) + Math.abs(p.c - raid.c) - (Math.abs(t.r - raid.r) + Math.abs(t.c - raid.c))) * 0.8;
        // an unswitched 10 closes in on a shown 10, which it can only beat as a Spy
        if (canSwitch && hunted) score += (distTo(p, hunted) - distTo(t, hunted)) * 2;
        if (policy === "fortress" && rank === "7" && truck) score += (distTo(p, truck) - distTo(t, truck)) * 6;
      }
      if (rank === "F") score -= 8;
      if (rank === "1" && !t.attack) score -= 1;
      if (!best || score > best.score) best = { id: p.id, to: { r: t.r, c: t.c }, score, switch: sw };
    }
  }
  return best && { kind: "move", id: best.id, to: best.to, twoStep, switch: best.switch };
}

const distTo = (a: Square, b: Square) => Math.max(Math.abs(a.r - b.r), Math.abs(a.c - b.c));
