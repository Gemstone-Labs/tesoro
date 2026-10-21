import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useEffect, useState, type CSSProperties } from "react";
import { Button } from "@/components/ui";
import { Marker, type HitSide } from "@/games/vanguard/VanguardBoard";
import { VanguardPractice } from "@/games/vanguard/practice/VanguardPractice";
import type { Game, Piece, Rank } from "@/games/vanguard/rules";
import "@/games/vanguard/vanguard.css";

/**
 * Vanguard prototype: blitz Stratego, US Army against the Royal Italian Army. You play the US against
 * a local bot on the real rules (`games/vanguard/rules.ts`). Tap a piece, then a marked square; attack an
 * Italian piece to see the reveal (only when you win or tie), the clash or the landmine.
 */
const meta: Meta<typeof VanguardPractice> = {
  title: "Games/Vanguard",
  component: VanguardPractice,
  parameters: { layout: "fullscreen" },
  args: { seed: 7, instant: false, clock: true },
};
export default meta;
type Story = StoryObj<typeof VanguardPractice>;

const phone = (s: Story): Story => ({ ...s, globals: { viewport: { value: "phone390", isRotated: false } } });

/** The real thing: 3-2-1, then 5-second turns against the bot. */
export const Practice: Story = {};

/** No clock and no countdown, to look around and try moves at leisure. */
export const NoClock: Story = { args: { instant: true, clock: false } };

/** The Dust Storm blows after the first two turns. */
export const DustStorm: Story = { args: { instant: true, clock: false, stormAt: 2 } };

/** A Two-Step Turn banked from the start: use it from your plate. */
export const TwoStepTurn: Story = { args: { instant: true, clock: false, twoStep: 1 } };

/** Move one piece of each army (by rank) onto a square, for a ready-made fight. */
const place = (g: Game, army: "us" | "it", rank: Rank, r: number, c: number, nth = 0): Game => {
  const p = g.pieces.filter((x) => x.army === army && x.rank === rank)[nth];
  if (!p) return g;
  const clear = g.pieces.filter((x) => !(x.r === r && x.c === c) || x.id === p.id);
  return { ...g, pieces: clear.map((x) => (x.id === p.id ? { ...x, r, c, trail: [`${r},${c}`] } : x)) };
};

/**
 * Pieces already in contact mid-board: your General (9) faces a hidden Italian 7 (attack it: you win,
 * the 7 is flashed as it falls), your Sergeant (4) faces a hidden Italian 8 (attack it: you lose, the 8 stays
 * hidden), your Engineer (3) faces a hidden Landmine (it clears it), and your Captain (6) faces the other
 * Landmine (it goes off and stays in plain sight).
 */
export const Contact: Story = {
  args: {
    instant: true,
    clock: false,
    prepare: (g) => {
      let x = g;
      x = place(x, "us", "9", 6, 0);
      x = place(x, "it", "7", 5, 0);
      x = place(x, "us", "4", 6, 4);
      x = place(x, "it", "8", 5, 4);
      x = place(x, "us", "3", 6, 9);
      x = place(x, "it", "B", 5, 9);
      x = place(x, "us", "6", 6, 5);
      x = place(x, "it", "B", 5, 5, 1);
      return x;
    },
  },
};

/** Put piece number `nth` of a rank on a square, with any other changes (a piece standing there is dropped). */
const put = (g: Game, army: "us" | "it", rank: Rank, r: number, c: number, nth = 0, extra: Partial<Piece> = {}): Game => {
  const p = g.pieces.filter((x) => x.army === army && x.rank === rank)[nth];
  if (!p) return g;
  const clear = g.pieces.filter((x) => !(x.r === r && x.c === c) || x.id === p.id);
  return { ...g, pieces: clear.map((x) => (x.id === p.id ? { ...x, r, c, trail: [`${r},${c}`], ...extra } : x)) };
};
const base = { instant: true, clock: false } as const;

/** Select the Engineer at (6,4) and the 8 squares are outlined; tap Blast to see the hidden pieces around it turn over and yours shown to the enemy. */
export const PowerBlast: Story = {
  args: {
    ...base,
    prepare: (g) => {
      let x = put(g, "us", "3", 6, 4);
      x = put(x, "it", "7", 5, 4);
      x = put(x, "it", "9", 5, 5);
      x = put(x, "it", "B", 6, 3);
      x = put(x, "it", "4", 7, 5);
      x = put(x, "us", "6", 6, 5);
      return put(x, "us", "5", 7, 4);
    },
  },
};

/** Select the Colonel at (6,4) and the arrow shows the Truck flying in from the corner; tap Rescue to send it. */
export const PowerRescue: Story = {
  args: {
    ...base,
    prepare: (g) => {
      let x = put(g, "us", "8", 6, 4);
      x = put(x, "us", "F", 8, 8);
      x = put(x, "it", "9", 7, 8);
      return put(x, "it", "4", 8, 7);
    },
  },
};

/** Select a Major and tap Dig in: it turns into a Landmine for good, with a small 7 badge for you. */
export const PowerDigIn: Story = { args: { ...base, prepare: (g) => put(put(g, "us", "7", 6, 4), "us", "7", 6, 5, 1) } };

/** The bot goes first with the fortress policy: its Major digs in beside its Truck. You see nothing: no callout, no log line, no count (a Dig in is secret). */
export const PowerDigInOpponent: Story = {
  args: {
    ...base,
    first: "it",
    policy: "fortress",
    prepare: (g) => put(put(g, "it", "F", 1, 4), "it", "7", 1, 5),
  },
};

/** Select your General of the Army (6,4), next to a shown Italian 10: tap Become a Spy (one tap, no confirm: it shows as a Spy at once), then attack. */
export const PowerBecomeSpy: Story = { args: { ...base, prepare: (g) => put(put(g, "us", "10", 6, 4), "it", "10", 5, 4, 0, { known: true }) } };

/** Jump marks: a Lieutenant (6,4) over a piece, a General (6,2) across the wadi, a Sergeant (7,0) on its diagonals, a Captain (6,6) in 8 directions. */
export const PowerJumps: Story = {
  args: {
    ...base,
    prepare: (g) => {
      let x = put(g, "us", "5", 6, 4);
      x = put(x, "it", "7", 5, 4);
      x = put(x, "us", "9", 6, 2);
      x = put(x, "us", "4", 7, 0);
      x = put(x, "us", "6", 6, 6);
      return x;
    },
  },
};

/** The roster strip when the Italian 10 has never been shown ("10 or Spy?"). A Major digging in changes nothing here. */
export const RosterUncertain: Story = {
  args: { ...base, prepare: (g) => ({ ...g, digs: { ...g.digs, it: 1 } }) },
};

/** Two Spies shown: the strip knows the 10 switched, so no question. */
export const RosterSwitchProven: Story = {
  args: { ...base, seen: { 1: ["1"], 2: ["1"] }, prepare: (g) => ({ ...g, pieces: g.pieces.filter((p) => p.id !== 1 && p.id !== 2) }) },
};

/** The end panel marking changed pieces for both armies. */
export const EndPanelChanges: Story = {
  args: {
    ...base,
    prepare: (g) => {
      const mj = g.pieces.find((p) => p.army === "us" && p.rank === "7")!;
      const ten = g.pieces.find((p) => p.army === "it" && p.rank === "10")!;
      return { ...g, winner: "us", reason: "truck", changed: { [mj.id]: "dug", [ten.id]: "spy", 31: "spy" }, pieces: g.pieces.map((p) => ({ ...p, known: true })) };
    },
  },
};

export const PhoneBlast = phone({ ...PowerBlast });
export const PhoneRescue = phone({ ...PowerRescue });
export const PhoneBecomeSpy = phone({ ...PowerBecomeSpy });
export const PhoneJumps = phone({ ...PowerJumps });
export const PhoneRoster = phone({ ...RosterUncertain });
export const PhoneEndPanel = phone({ ...EndPanelChanges });

const SIDES: { from: HitSide; arrow: string; label: string }[] = [
  { from: "left", arrow: "→", label: "hit from the left" },
  { from: "right", arrow: "←", label: "hit from the right" },
  { from: "top", arrow: "↓", label: "hit from the top" },
  { from: "bottom", arrow: "↑", label: "hit from the bottom" },
];

/** Hidden pieces turning over from the side they were hit, replaying every few seconds (or on the button). */
function RevealDemo({ size }: { size: number }) {
  const [up, setUp] = useState(false);
  const [round, setRound] = useState(0);
  useEffect(() => {
    const a = setTimeout(() => setUp(true), 700);
    const b = setTimeout(() => setUp(false), 2600);
    const c = setTimeout(() => setRound((r) => r + 1), 3200);
    return () => [a, b, c].forEach(clearTimeout);
  }, [round]);
  const ranks: Rank[] = ["9", "3", "7", "B"];
  return (
    <div className="vg-reveal-demo">
      {SIDES.map((sd, i) => (
        <div key={sd.from} className="vg-reveal-cell" style={{ "--vg-sq": `${size}px` } as CSSProperties}>
          <div className={`vg-slot from-${sd.from}`} data-arrow={sd.arrow}>
            <Marker p={{ id: i, army: "it", rank: ranks[i], r: 0, c: 0, up, hitFrom: sd.from }} selected={false} onTap={() => {}} disabled />
          </div>
          <small>{sd.label}</small>
        </div>
      ))}
      <Button onClick={() => setRound((r) => r + 1)}>Reveal again</Button>
    </div>
  );
}

/** The reveal: the whole marker turns over like a coin, from the side it was hit. Big and at phone size. */
export const Reveal: StoryObj = {
  render: () => (
    <>
      <RevealDemo size={130} />
      <RevealDemo size={36} />
    </>
  ),
};

export const PhonePractice = phone({ args: { instant: true, clock: true } });
export const PhoneNoClock = phone({ args: { instant: true, clock: false } });

/** Own pieces the enemy has seen face up (a Truck that was Spotted, a Colonel shown by a Blast) glow red round the rim; open Ranks for the legend. */
export const SeenByEnemy: Story = { args: { ...base, prepare: (g) => put(put(g, "us", "F", 7, 4, 0, { known: true }), "us", "8", 6, 4, 0, { known: true }) } };
export const PhoneSeenByEnemy = phone({ ...SeenByEnemy });
